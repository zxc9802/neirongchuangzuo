import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import BrowserMaterials from '../design/browser-materials.js';
const helpers = BrowserMaterials?.helpers || {};
const digest = value => createHash('sha256').update(value).digest('hex');

test('IndexedDB folder stores capture separate account namespaces', async () => {
  const original = { indexedDB: globalThis.indexedDB, workspaceUser: globalThis.workspaceUser };
  const names = [];
  globalThis.indexedDB = { open(name) {
    names.push(name);
    const request = {};
    queueMicrotask(() => {
      request.result = { transaction() {
        const tx = { objectStore: () => ({ get: () => ({ result: null }) }) };
        queueMicrotask(() => tx.oncomplete());
        return tx;
      } };
      request.onsuccess();
    });
    return request;
  } };
  try {
    globalThis.workspaceUser = { id: 'account-a' };
    const first = helpers.createFolderStore();
    globalThis.workspaceUser = { id: 'account-b' };
    const second = helpers.createFolderStore();
    await first.get(); await second.get();
    assert.deepEqual(names, ['workbench-browser-materials:account-a', 'workbench-browser-materials:account-b']);
  } finally { Object.assign(globalThis, original); }
});

test('account changes during decoding stop old folder registration and persistence', async () => {
  const original = globalThis.workspaceUser;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const backend = server();
  const store = memoryStore();
  globalThis.workspaceUser = { id: 'account-a' };
  const controller = new BrowserMaterials({ store, api: backend.api, readDuration: () => pending });
  try {
    const selecting = controller.selectFiles([videoFile('素材/a.mp4')]);
    await eventually(() => backend.calls.some(call => call.path.endsWith('/connect')));
    globalThis.workspaceUser = { id: 'account-b' };
    release(2);
    await selecting;
    assert.equal(controller.active, false);
    assert.equal(backend.calls.some(call => call.path.endsWith('/clips')), false);
    assert.deepEqual(store.value.manifest, {});
  } finally { controller.stop(); globalThis.workspaceUser = original; }
});

test('explicit disconnect revokes the server device before forgetting the local directory', async () => {
  const backend = server();
  const store = memoryStore();
  const controller = new BrowserMaterials({ store, api: backend.api, readDuration: async () => 2 });
  try {
    await controller.selectFiles([videoFile('素材/a.mp4')]);
    await controller.disconnect();
    assert.ok(backend.calls.some(call => call.method === 'DELETE' && call.path === '/api/browser-materials/devices/' + '1'.repeat(32)));
    assert.equal(store.value, null);
    assert.equal(controller.connected, false);
  } finally { controller.stop(); }
});

test('ten folder replacements and reselects release old devices without revoking the retained folder', async () => {
  const calls = [];
  const live = new Set();
  const ids = new Map();
  const store = memoryStore();
  const controller = new BrowserMaterials({ store, readDuration: async () => 2, api: async (path, options = {}) => {
    calls.push({ path, method: options.method });
    if (path.endsWith('/connect')) {
      const key = JSON.parse(options.body).folder_key;
      if (!ids.has(key)) ids.set(key, String(ids.size + 1).padStart(32, '0'));
      assert.ok(live.size < 10, 'old devices permanently consumed the directory cap');
      live.add(ids.get(key));
      return { device_id: ids.get(key) };
    }
    if (options.method === 'DELETE') { live.delete(path.split('/').pop()); return { ok: true }; }
    if (path.endsWith('/clips')) return { clips: JSON.parse(options.body).clips.map(clip => ({ id: clip.id, state: 'indexed' })) };
    return { requests: [] };
  } });
  try {
    for (let index = 0; index < 12; index++) {
      await controller.selectFiles([videoFile(`folder-${index}/a.mp4`)]);
      assert.equal(live.size, 1);
      const deletes = calls.filter(call => call.method === 'DELETE').length;
      await controller.selectFiles([videoFile(`folder-${index}/a.mp4`)]);
      assert.equal(calls.filter(call => call.method === 'DELETE').length, deletes);
    }
    assert.equal(calls.filter(call => call.method === 'DELETE').length, 11);
    await controller.disconnect();
    assert.equal(live.size, 0);
  } finally { controller.stop(); }
});

test('account change during a saved-folder read prevents a late old-device revocation', async () => {
  const original = globalThis.workspaceUser;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const calls = [];
  const store = memoryStore({ folderKey: 'b'.repeat(64), name: '旧素材', deviceId: '1'.repeat(32), handle: null, manifest: {}, uploads: {} });
  const previous = store.value;
  store.get = () => pending;
  globalThis.workspaceUser = { id: 'account-a' };
  const controller = new BrowserMaterials({ store, api: async (path, options) => {
    calls.push({ path, method: options?.method });
    return {};
  } });
  try {
    const selecting = controller.selectFiles([videoFile('新素材/a.mp4')]);
    await new Promise(resolve => setImmediate(resolve));
    globalThis.workspaceUser = { id: 'account-b' };
    release(previous);
    await selecting;
    assert.equal(calls.some(call => call.method === 'DELETE'), false);
    assert.equal(controller.active, false);
  } finally { controller.stop(); globalThis.workspaceUser = original; }
});

test('failed old-device revocation stays in the account record and is retried before a new connection', async () => {
  const store = memoryStore();
  const calls = [];
  let offline = true;
  const controller = new BrowserMaterials({ store, readDuration: async () => 2, api: async (path, options = {}) => {
    calls.push({ path, method: options.method });
    if (options.method === 'DELETE' && offline) throw new Error('offline');
    if (path.endsWith('/connect')) return { device_id: path && (calls.filter(call => call.path.endsWith('/connect')).length === 1 ? '1' : '2').repeat(32) };
    if (path.endsWith('/clips')) return { clips: JSON.parse(options.body).clips.map(clip => ({ id: clip.id, state: 'indexed' })) };
    return { requests: [] };
  } });
  try {
    await controller.selectFiles([videoFile('first/a.mp4')]);
    await controller.selectFiles([videoFile('second/a.mp4')]);
    assert.deepEqual(store.value.retiredDeviceIds, ['1'.repeat(32)]);
    assert.equal(calls.filter(call => call.path.endsWith('/connect')).length, 1);
    offline = false;
    await controller.selectFiles([videoFile('second/a.mp4')]);
    assert.deepEqual(store.value.retiredDeviceIds, []);
    assert.equal(controller.deviceId, '2'.repeat(32));
    assert.equal(calls.filter(call => call.method === 'DELETE').length, 2);
  } finally { controller.stop(); }
});

test('permission reconnect rejects a different native directory before revoking the active job input', async () => {
  const original = globalThis.showDirectoryPicker;
  const backend = server();
  const store = memoryStore();
  const controller = new BrowserMaterials({ store, api: backend.api, readDuration: async () => 2 });
  const handle = directory('原素材', []);
  handle.isSameEntry = async chosen => chosen === handle;
  try {
    globalThis.showDirectoryPicker = async () => handle;
    await controller.choose();
    const key = store.value.folderKey;
    const before = backend.calls.length;
    globalThis.showDirectoryPicker = async () => directory('其他素材', []);
    await controller.choose({ reconnectOnly: true });
    assert.match(controller.status.error, /原素材文件夹/);
    assert.equal(backend.calls.length, before);
    assert.equal(store.value.folderKey, key);
    globalThis.showDirectoryPicker = async () => handle;
    await controller.choose({ reconnectOnly: true });
    assert.equal(store.value.folderKey, key);
    assert.equal(backend.calls.some(call => call.method === 'DELETE'), false);
  } finally { controller.stop(); globalThis.showDirectoryPicker = original; }
});

test('asset and clip IDs use the exact contract and clips are at most eight seconds', async () => {
  assert.equal(typeof helpers.assetId, 'function');
  const id = await helpers.assetId('海边/a.mp4', 900, 1234);
  assert.equal(id, digest(JSON.stringify(['海边/a.mp4', 900, 1234])));
  const clips = await helpers.makeClips(id, '海边/a.mp4', 17.25);
  assert.deepEqual(clips.map(({ start, end }) => [start, end]), [[0, 8], [8, 16], [16, 17.25]]);
  assert.equal(clips[2].id, digest(id + ':16:17.25'));
});

function entry(path, id, state = 'indexed') {
  return { relativePath: path, assetId: id, size: 10, lastModified: 1, duration: 2,
    clips: [{ id: id + '-clip', asset_id: id, name: path, start: 0, end: 2, state }] };
}

test('complete reconciliation reuses unchanged clips and replaces, adds, and deletes assets', () => {
  assert.equal(typeof helpers.reconcileManifest, 'function');
  const old = { 'same.mp4': entry('same.mp4', 'same'), 'changed.mp4': entry('changed.mp4', 'old'),
    'deleted.mp4': entry('deleted.mp4', 'gone') };
  const result = helpers.reconcileManifest(old, [
    { relativePath: 'same.mp4', entry: old['same.mp4'] },
    { relativePath: 'changed.mp4', entry: entry('changed.mp4', 'new', 'pending') },
    { relativePath: 'added.mp4', entry: entry('added.mp4', 'added', 'pending') },
  ], true);
  assert.equal(result.manifest['same.mp4'], old['same.mp4']);
  assert.equal(result.manifest['changed.mp4'].assetId, 'new');
  assert.equal(result.manifest['added.mp4'].assetId, 'added');
  assert.equal(result.manifest['deleted.mp4'], undefined);
  assert.deepEqual(result.revocations.sort(), ['gone', 'old']);
});

test('unreadable files and incomplete enumeration retain old assets without revoking', () => {
  assert.equal(typeof helpers.reconcileManifest, 'function');
  const old = { 'bad.mp4': entry('bad.mp4', 'bad'), 'missing.mp4': entry('missing.mp4', 'missing'),
    'changed.mp4': entry('changed.mp4', 'old') };
  const result = helpers.reconcileManifest(old, [
    { relativePath: 'bad.mp4', error: 'cannot read' },
    { relativePath: 'changed.mp4', entry: entry('changed.mp4', 'new', 'pending') },
  ], false);
  assert.equal(result.manifest['bad.mp4'].assetId, 'bad');
  assert.equal(result.manifest['missing.mp4'].assetId, 'missing');
  assert.equal(result.manifest['changed.mp4'].assetId, 'new');
  assert.deepEqual(result.revocations, []);
  assert.deepEqual(result.deferredRevocations, ['old']);
  const next = helpers.reconcileManifest(result.manifest,
    [{ relativePath: 'changed.mp4', entry: result.manifest['changed.mp4'] }], true, result.deferredRevocations);
  assert.deepEqual(next.revocations.sort(), ['bad', 'missing', 'old']);
});

test('unchanged inspection reuses duration without decoding; new and changed files decode', async () => {
  assert.equal(typeof helpers.inspectFile, 'function');
  const file = new Blob(['video']);
  Object.defineProperties(file, { name: { value: 'a.mp4' }, lastModified: { value: 4 } });
  const id = await helpers.assetId('a.mp4', file.size, 4);
  const old = { ...entry('a.mp4', id), size: file.size, lastModified: 4 };
  let reads = 0;
  const reader = async () => { reads++; return 9; };
  assert.equal(await helpers.inspectFile('a.mp4', file, old, reader), old);
  assert.equal(reads, 0);
  const added = await helpers.inspectFile('new.mp4', file, undefined, reader);
  assert.equal(added.duration, 9);
  assert.equal(added.clips.length, 2);
  const changed = await helpers.inspectFile('a.mp4', file, { ...old, lastModified: 1 }, reader);
  assert.equal(changed.clips.length, 2);
  assert.equal(reads, 2);
});

test('streaming upload resumes at the server offset and hashes only four MiB slices', async () => {
  assert.equal(typeof helpers.transferFile, 'function');
  const chunk = 4 * 1024 * 1024;
  const size = chunk * 2 + 7;
  const slices = [];
  const file = { size, arrayBuffer() { throw new Error('whole file must never be read'); },
    slice(start, end) { slices.push([start, end]); return new Blob([Buffer.alloc(end - start, 7)]); } };
  const sent = [];
  let completed = false;
  await helpers.transferFile({ file, upload: { id: 'saved' },
    head: async id => { assert.equal(id, 'saved'); return chunk; },
    create: async () => { throw new Error('must reuse saved upload'); },
    patch: async (id, offset, bytes, checksum) => {
      assert.equal(id, 'saved');
      assert.equal(checksum, digest(Buffer.from(bytes)));
      sent.push(offset);
      return offset + bytes.byteLength;
    }, complete: async () => { completed = true; } });
  assert.deepEqual(slices, [[chunk, chunk * 2], [chunk * 2, size]]);
  assert.deepEqual(sent, [chunk, chunk * 2]);
  assert.equal(completed, true);
});

test('a lost chunk acknowledgement reconciles the offset without resending accepted bytes', async () => {
  assert.equal(typeof helpers.transferFile, 'function');
  const file = new Blob([Buffer.alloc(9)]);
  let serverOffset = 0;
  let patches = 0;
  await helpers.transferFile({ file, create: async () => ({ id: 'new', offset: 0 }),
    head: async () => serverOffset,
    patch: async (_, offset, bytes) => { patches++; serverOffset = offset + bytes.byteLength;
      throw new Error('lost response'); }, complete: async () => {} });
  assert.equal(patches, 1);
});

test('oversize sources are rejected before an upload or file read', async () => {
  assert.equal(typeof helpers.transferFile, 'function');
  let creates = 0;
  await assert.rejects(helpers.transferFile({ file: { size: 512 * 1024 * 1024 + 1 },
    create: async () => { creates++; }, head: async () => 0 }), /512 MiB/);
  assert.equal(creates, 0);
});

test('transfer stops after an asynchronous read when its run has been cancelled', async () => {
  assert.equal(typeof helpers.transferFile, 'function');
  let alive = true;
  let patches = 0;
  const file = { size: 3, slice() { return { async arrayBuffer() { alive = false; return new ArrayBuffer(3); } }; } };
  await assert.rejects(helpers.transferFile({ file, create: async () => ({ id: 'new', offset: 0 }),
    guard() { if (!alive) throw Object.assign(new Error('stopped'), { name: 'AbortError' }); },
    patch: async () => { patches++; }, head: async () => 0, complete: async () => {} }), /stopped/);
  assert.equal(patches, 0);
});

function memoryStore(record = null) {
  const repairs = new Map();
  return { value: record, repairs, async get() { return this.value; }, async put(value) { this.value = value; },
    async getRepair(id) { return repairs.get(id); }, async putRepair(id, file) { repairs.set(id, file); },
    async deleteRepair(id) { repairs.delete(id); }, async clearRepairs() { repairs.clear(); },
    async clear() { this.value = null; } };
}

function videoFile(path, modified = 1, content = 'video') {
  const file = new Blob([content], { type: 'video/mp4' });
  Object.defineProperties(file, { name: { value: path.split('/').pop() },
    webkitRelativePath: { value: path }, lastModified: { value: modified } });
  return file;
}

function directory(name, files, permission = 'granted') {
  return { name, kind: 'directory', queryPermission: async () => permission,
    async isSameEntry(other) { return this === other; },
    async *values() {
      for (const file of files) yield { kind: 'file', name: file.name, async getFile() { return file; } };
    } };
}

function server() {
  const calls = [];
  const states = new Map();
  return { calls, states, async api(path, options = {}) {
    const body = options.body && typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    calls.push({ path, method: options.method || 'GET', body, signal: options.signal });
    if (path.endsWith('/connect')) return { device_id: '1'.repeat(32) };
    if (path.endsWith('/clips')) return { clips: body.clips.map(clip => {
      if (!states.has(clip.id)) states.set(clip.id, 'pending');
      return { id: clip.id, state: states.get(clip.id) };
    }) };
    if (path.endsWith('/requests')) return { requests: [] };
    if (path.endsWith('/analyze')) { states.set(body.clip_id, 'indexed'); return { complete: true }; }
    return { ok: true };
  } };
}

async function eventually(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('controller did not finish expected work');
}

test('restore scans a granted directory and reuses indexed unchanged clips', async () => {
  assert.equal(typeof BrowserMaterials?.prototype.restore, 'function');
  const file = videoFile('a.mp4');
  const old = await helpers.inspectFile('a.mp4', file, null, async () => 2);
  old.clips[0].state = 'indexed';
  const store = memoryStore({ folderKey: 'a'.repeat(64), name: '素材', deviceId: '1'.repeat(32),
    handle: directory('素材', [file]), manifest: { 'a.mp4': old }, deferredRevocations: [], uploads: {} });
  const backend = server();
  backend.states.set(old.clips[0].id, 'indexed');
  let connected;
  const controller = new BrowserMaterials({ api: backend.api, store,
    readDuration: async () => { throw new Error('unchanged file decoded'); }, onConnected: id => { connected = id; } });
  try {
    await controller.restore();
    assert.equal(connected, '1'.repeat(32));
    assert.equal(controller.folderName, '素材');
    assert.equal(controller.deviceId, '1'.repeat(32));
    assert.equal(controller.status.indexed, 1);
    assert.equal(backend.calls.filter(call => call.path.endsWith('/analyze')).length, 0);
  } finally { controller.stop(); }
});

test('restoration with expired or unavailable permission asks for an explicit reconnect', async () => {
  assert.equal(typeof BrowserMaterials?.prototype.restore, 'function');
  for (const handle of [directory('素材', [], 'prompt'), { name: '素材', kind: 'directory' }, null]) {
    const backend = server();
    const controller = new BrowserMaterials({ api: backend.api,
      store: memoryStore({ folderKey: 'a'.repeat(64), name: '素材', deviceId: '1'.repeat(32), handle, manifest: {} }) });
    await controller.restore();
    assert.equal(controller.status.needsPermission, true);
    assert.equal(controller.status.text, '重新连接素材文件夹');
    assert.equal(controller.deviceId, '');
    assert.equal(backend.calls.length, 0);
    controller.stop();
  }
});

test('fallback selection indexes new files, reuses its saved folder key, and needs reselection on reload', async () => {
  assert.equal(typeof BrowserMaterials?.prototype.selectFiles, 'function');
  const store = memoryStore();
  const backend = server();
  const controller = new BrowserMaterials({ api: backend.api, store, readDuration: async () => 9,
    sampleFrames: async () => ['data:image/jpeg;base64,frame'] });
  try {
    await controller.selectFiles([videoFile('素材/海边.mp4')]);
    await eventually(() => controller.status.indexed === 2);
    const key = store.value.folderKey;
    assert.match(key, /^[a-f0-9]{64}$/);
    assert.equal(store.value.handle, null);
    assert.equal(store.value.manifest['海边.mp4'].clips.length, 2);
    await controller.selectFiles([videoFile('素材/海边.mp4')]);
    assert.equal(store.value.folderKey, key);
    assert.equal(backend.calls.filter(call => call.path.endsWith('/analyze')).length, 2);
    controller.stop();
    await controller.restore();
    assert.equal(controller.status.needsPermission, true);
  } finally { controller.stop(); }
});

test('directory picker starts within the click gesture before reading IndexedDB', async () => {
  assert.equal(typeof BrowserMaterials?.prototype.choose, 'function');
  const previousPicker = globalThis.showDirectoryPicker;
  let picked = false;
  globalThis.showDirectoryPicker = () => { picked = true; return Promise.resolve(directory('素材', [])); };
  const store = memoryStore();
  store.get = async () => { assert.equal(picked, true); return null; };
  const controller = new BrowserMaterials({ api: server().api, store });
  try { await controller.choose(); assert.equal(controller.folderName, '素材'); }
  finally { controller.stop(); globalThis.showDirectoryPicker = previousPicker; }
});

test('stop cancels a scan after metadata decoding and prevents later registration writes', async () => {
  assert.equal(typeof BrowserMaterials?.prototype.selectFiles, 'function');
  const backend = server();
  let resume;
  let began;
  const started = new Promise(resolve => { began = resolve; });
  const controller = new BrowserMaterials({ api: backend.api, store: memoryStore(), readDuration: () => {
    began(); return new Promise(resolve => { resume = resolve; });
  } });
  const scanning = controller.selectFiles([videoFile('素材/a.mp4')]);
  await started;
  controller.stop();
  resume(2);
  await scanning;
  assert.equal(backend.calls.filter(call => call.path.endsWith('/clips') || call.path.endsWith('/analyze')).length, 0);
  assert.equal(backend.calls[0].signal.aborted, true);
});

test('decode errors remain visible and incomplete scans do not revoke missing assets', async () => {
  assert.equal(typeof BrowserMaterials?.prototype.restore, 'function');
  const old = entry('old.mp4', '0'.repeat(64));
  const backend = server();
  const handle = directory('素材', [videoFile('bad.mp4')]);
  const store = memoryStore({ folderKey: 'a'.repeat(64), name: '素材', deviceId: '1'.repeat(32),
    handle, manifest: { 'old.mp4': old }, uploads: {} });
  const controller = new BrowserMaterials({ api: backend.api, store,
    readDuration: async () => { throw new Error('请转换为 MP4'); } });
  try {
    await controller.restore();
    assert.match(controller.status.error, /bad.mp4.*MP4/);
    assert.equal(store.value.manifest['old.mp4'].assetId, old.assetId);
    assert.equal(backend.calls.some(call => call.method === 'DELETE'), false);
  } finally { controller.stop(); }
});

test('clip registration is split into batches of at most five hundred', async () => {
  assert.equal(typeof BrowserMaterials?.prototype.selectFiles, 'function');
  const backend = server();
  const controller = new BrowserMaterials({ api: backend.api, store: memoryStore(), readDuration: async () => 4008 });
  try {
    await controller.selectFiles([videoFile('素材/a.mp4')]);
    assert.deepEqual(backend.calls.filter(call => call.path.endsWith('/clips')).map(call => call.body.clips.length), [500, 1]);
  } finally { controller.stop(); }
});

test('clip registration batches also fit the gateway UTF-8 JSON body limit with Chinese paths', async () => {
  const backend = server();
  const controller = new BrowserMaterials({ api: backend.api, store: memoryStore(), readDuration: async () => 4000 });
  try {
    await controller.selectFiles([videoFile('素材/' + '海'.repeat(153) + '.mp4')]);
    const batches = backend.calls.filter(call => call.path.endsWith('/clips')).map(call => call.body);
    assert.equal(batches.length > 1, true);
    assert.equal(batches.reduce((count, body) => count + body.clips.length, 0), 500);
    assert.equal(batches.every(body => body.clips.length <= 500), true);
    assert.equal(batches.every(body => Buffer.byteLength(JSON.stringify(body), 'utf8') <= 262144), true);
  } finally { controller.stop(); }
});

test('a clip larger than the body limit gives an actionable error without submitting it', async () => {
  const backend = server();
  const controller = new BrowserMaterials({ api: backend.api, store: memoryStore(), readDuration: async () => 2 });
  try {
    await controller.selectFiles([videoFile('素材/' + '海'.repeat(90000) + '.mp4')]);
    assert.match(controller.status.error, /名称过长.*缩短/);
    assert.equal(backend.calls.some(call => call.path.endsWith('/clips')), false);
  } finally { controller.stop(); }
});

test('matching requests are served before queued analysis and indexed clips are not reanalyzed', async () => {
  assert.equal(typeof BrowserMaterials?.prototype.selectFiles, 'function');
  const backend = server();
  const events = [];
  let pendingRequest = true;
  const controller = new BrowserMaterials({ store: memoryStore(), readDuration: async () => 2,
    sampleFrames: async () => ['frame'], api: async (path, options) => {
      if (path.endsWith('/requests')) return { requests: pendingRequest ? [{ id: '2'.repeat(32),
        asset_id: Object.values(controller.record.manifest)[0].assetId, start: 0, end: 2, kind: 'proxy' }] : [] };
      if (path.endsWith('/frames')) { events.push('proxy'); pendingRequest = false; return { complete: true }; }
      if (path.endsWith('/analyze')) events.push('analysis');
      return backend.api(path, options);
    } });
  try {
    await controller.selectFiles([videoFile('素材/a.mp4')]);
    await eventually(() => controller.status.indexed === 1);
    assert.deepEqual(events, ['proxy', 'analysis']);
  } finally { controller.stop(); }
});

test('a folder picker completed after stop cannot reconnect or write to the server', async () => {
  const previousPicker = globalThis.showDirectoryPicker;
  let finish;
  globalThis.showDirectoryPicker = () => new Promise(resolve => { finish = resolve; });
  const backend = server();
  const controller = new BrowserMaterials({ api: backend.api, store: memoryStore() });
  try {
    const picking = controller.choose();
    controller.stop();
    finish(directory('素材', []));
    await picking;
    assert.equal(backend.calls.length, 0);
    assert.equal(controller.active, false);
  } finally { controller.stop(); globalThis.showDirectoryPicker = previousPicker; }
});

test('a rejected API response after stop cannot update the old status', async () => {
  let rejectConnect;
  let connected;
  const began = new Promise(resolve => { connected = resolve; });
  const statuses = [];
  const controller = new BrowserMaterials({ store: memoryStore(), onStatus: status => statuses.push(status),
    api: () => { connected(); return new Promise((_, reject) => { rejectConnect = reject; }); } });
  const selecting = controller.selectFiles([videoFile('素材/a.mp4')]);
  await began;
  controller.stop();
  const count = statuses.length;
  rejectConnect(new Error('logout caused failed fetch'));
  await selecting;
  assert.equal(statuses.length, count);
});

test('calling start repeatedly while analysis is awaiting preserves a single worker', async () => {
  const backend = server();
  let finishFrames;
  let started;
  const began = new Promise(resolve => { started = resolve; });
  let samples = 0;
  const controller = new BrowserMaterials({ api: backend.api, store: memoryStore(), readDuration: async () => 2,
    sampleFrames: () => { samples++; started(); return new Promise(resolve => { finishFrames = resolve; }); } });
  try {
    await controller.selectFiles([videoFile('素材/a.mp4')]);
    await began;
    controller.start();
    controller.start();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(samples, 1);
    finishFrames(['frame']);
    await eventually(() => controller.status.indexed === 1);
  } finally { controller.stop(); }
});

test('oversize sources surface a file error during scanning before indexing', async () => {
  const backend = server();
  const file = { name: 'huge.mp4', webkitRelativePath: '素材/huge.mp4', size: 512 * 1024 * 1024 + 1,
    lastModified: 1, slice() { throw new Error('oversize file must not be read'); } };
  const controller = new BrowserMaterials({ api: backend.api, store: memoryStore(), readDuration: async () => 2 });
  try {
    await controller.selectFiles([file]);
    assert.match(controller.status.error, /huge.mp4.*512 MiB/);
    assert.equal(backend.calls.some(call => call.path.endsWith('/clips')), false);
  } finally { controller.stop(); }
});

test('a video that times out does not repeatedly block the remaining files and can be retried on rescan', async () => {
  const backend = server();
  const attempts = [];
  const originalNow = Date.now;
  let now = originalNow();
  let broken = true;
  const controller = new BrowserMaterials({ api: backend.api, store: memoryStore(), readDuration: async () => 16,
    repairVideo: async () => { throw new Error('读取视频超时'); },
    sampleFrames: async file => {
      attempts.push(file.name);
      if (broken && file.name === 'bad.mov') {
        now += 30000;
        throw new Error('读取视频超时，请检查文件或转换为 MP4（H.264）');
      }
      return ['frame'];
    } });
  controller._schedule = () => {};
  const files = [videoFile('素材/bad.mov'), videoFile('素材/good.mp4')];
  try {
    Date.now = () => now;
    await controller.selectFiles(files);
    for (let i = 0; i < 5; i++) { await controller._cycle(controller.generation); await Promise.all(controller.workers.values()); }
    assert.deepEqual(attempts, ['bad.mov', 'bad.mov', 'good.mp4', 'good.mp4']);
    assert.equal(controller.status.indexed, 2);
    assert.match(controller.status.error, /bad.mov.*读取视频超时/);
    broken = false;
    await controller.selectFiles(files);
    for (let i = 0; i < 2; i++) { await controller._cycle(controller.generation); await Promise.all(controller.workers.values()); }
    assert.equal(controller.status.indexed, 4);
    assert.equal(controller.status.error, '');
  } finally { controller.stop(); Date.now = originalNow; }
});

test('slow model failures are retried after fresh clips instead of starving the queue', async () => {
  const backend = server();
  const attempts = [];
  const originalNow = Date.now;
  let now = originalNow();
  let failing = true;
  const controller = new BrowserMaterials({ store: memoryStore(), readDuration: async () => 48,
    sampleFrames: async () => ['frame'], api: async (path, options) => {
      if (path.endsWith('/analyze')) {
        const id = JSON.parse(options.body).clip_id;
        attempts.push(id);
        if (failing) { now += 30000; throw new Error('HTTP 503'); }
      }
      return backend.api(path, options);
    } });
  controller._schedule = () => {};
  try {
    Date.now = () => now;
    await controller.selectFiles([videoFile('素材/first.mp4'), videoFile('素材/second.mp4')]);
    const clips = Object.values(controller.record.manifest).flatMap(item => item.clips);
    for (let i = 0; i < 2; i++) { await controller._cycle(controller.generation); await Promise.all(controller.workers.values()); }
    assert.deepEqual(attempts, clips.map(clip => clip.id));
    failing = false;
    now += 30000;
    for (let i = 0; i < 2; i++) { await controller._cycle(controller.generation); await Promise.all(controller.workers.values()); }
    assert.equal(controller.status.indexed, clips.length);
  } finally { controller.stop(); Date.now = originalNow; }
});

test('default video sampling produces one JPEG per second at no more than 640 pixels', async () => {
  const previousDocument = globalThis.document;
  const seeks = [];
  const draws = [];
  class Video extends EventTarget {
    constructor() { super(); this.duration = 20; this.videoWidth = 1920; this.videoHeight = 1080; this.readyState = 2; this.time = 0; }
    get currentTime() { return this.time; }
    set currentTime(value) { this.time = value; seeks.push(value); queueMicrotask(() => this.dispatchEvent(new Event('seeked'))); }
    load() { if (this.src) queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata'))); }
    pause() {}
    removeAttribute() { this.src = ''; }
  }
  globalThis.document = { createElement(type) {
    if (type === 'video') return new Video();
    const canvas = { getContext: () => ({ drawImage(video, x, y, width, height) { draws.push([video.currentTime, width, height]); } }),
      toDataURL: type => 'data:' + type + ';base64,jpeg' };
    return canvas;
  } };
  try {
    const frames = await helpers.sampleFrames(new Blob(['video']), 9.2, 17);
    assert.equal(frames.length, 8);
    assert.equal(frames.every(frame => frame.startsWith('data:image/jpeg;')), true);
    assert.deepEqual(seeks, Array.from({ length: 8 }, (_, i) => 9.2 + i));
    assert.equal(draws.every(([, width, height]) => width === 640 && height === 360), true);
  } finally { globalThis.document = previousDocument; }
});

test('a restored current version is removed from deferred revocations', () => {
  const old = { 'a.mp4': entry('a.mp4', 'new') };
  const result = helpers.reconcileManifest(old, [{ relativePath: 'a.mp4', entry: entry('a.mp4', 'original') }], true, ['original']);
  assert.deepEqual(result.revocations, ['new']);
});

test('unreadable observations prevent deletion even if traversal finished', () => {
  const old = { 'bad.mp4': entry('bad.mp4', 'bad'), 'missing.mp4': entry('missing.mp4', 'missing') };
  const result = helpers.reconcileManifest(old, [{ relativePath: 'bad.mp4', error: 'cannot read' }], true);
  assert.deepEqual(result.revocations, []);
  assert.equal(result.manifest['missing.mp4'], old['missing.mp4']);
});

test('server registration must confirm a pending clip before analysis is allowed', async () => {
  const backend = server();
  let samples = 0;
  const controller = new BrowserMaterials({ store: memoryStore(), readDuration: async () => 2,
    sampleFrames: async () => { samples++; return ['frame']; }, api: async (path, options) => {
      if (path.endsWith('/clips')) throw new Error('register service unavailable');
      return backend.api(path, options);
    } });
  try {
    await controller.selectFiles([videoFile('素材/a.mp4')]);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(samples, 0);
    assert.match(controller.status.error, /register service unavailable/);
  } finally { controller.stop(); }
});

test('source requests persist their upload ID and resume in a new controller via same-origin HEAD', async () => {
  const file = videoFile('a.mp4', 1, Buffer.alloc(4 * 1024 * 1024 + 7, 3));
  const store = memoryStore({ folderKey: 'a'.repeat(64), name: '素材', deviceId: '1'.repeat(32),
    handle: directory('素材', [file]), manifest: {}, uploads: {} });
  let controller;
  let offset = 0;
  let creates = 0;
  let allowHead = false;
  let fulfilled = false;
  const offsets = [];
  const backend = server();
  const options = { store, readDuration: async () => 2, api: async (path, config) => {
    if (path.endsWith('/clips')) {
      const result = await backend.api(path, config);
      result.clips.forEach(clip => { clip.state = 'indexed'; });
      return result;
    }
    if (path.endsWith('/requests')) return { requests: fulfilled ? [] : [{ id: '2'.repeat(32),
      asset_id: store.value.manifest['a.mp4'].assetId, start: 0, end: 2, kind: 'source' }] };
    if (path.endsWith('/file')) { creates++; return { id: '3'.repeat(32), offset: 0 }; }
    if (config?.method === 'PATCH') {
      assert.equal(store.value.uploads['2'.repeat(32)].id, '3'.repeat(32));
      assert.equal(config.headers['Content-Type'], 'application/octet-stream');
      assert.equal(config.headers['Upload-Checksum'], digest(Buffer.from(config.body)));
      assert.equal(config.body.byteLength <= helpers.CHUNK_SIZE, true);
      offsets.push(Number(config.headers['Upload-Offset']));
      offset += config.body.byteLength;
      if (!allowHead) throw new Error('connection interrupted');
      return { offset };
    }
    if (path.endsWith('/complete')) { fulfilled = true; return { complete: true }; }
    return backend.api(path, config);
  }, fetch: async (path, config) => {
    assert.equal(path, '/api/browser-materials/devices/' + '1'.repeat(32) + '/files/' + '3'.repeat(32));
    assert.equal(config.method, 'HEAD');
    assert.equal(config.credentials, 'same-origin');
    assert.equal(config.headers['X-Workbench-Request'], '1');
    if (!allowHead) throw new Error('offline');
    return new Response(null, { headers: { 'Upload-Offset': String(offset) } });
  } };
  try {
    controller = new BrowserMaterials(options);
    await controller.restore();
    await eventually(() => controller.status.error.includes('offline'));
    controller.stop();
    assert.equal(store.value.uploads['2'.repeat(32)].id, '3'.repeat(32));
    allowHead = true;
    controller = new BrowserMaterials(options);
    await controller.restore();
    await eventually(() => fulfilled && !store.value.uploads['2'.repeat(32)]);
    assert.equal(creates, 1);
    assert.deepEqual(offsets, [0, helpers.CHUNK_SIZE]);
  } finally { controller?.stop(); }
});

test('background indexing completion preserves an ongoing source upload progress', async () => {
  const backend = server();
  const file = videoFile('素材/a.mp4', 1, Buffer.alloc(helpers.CHUNK_SIZE + 7));
  let releaseAnalysis, releaseUpload, serving, lastChunk = false;
  const analysis = new Promise(resolve => { releaseAnalysis = resolve; });
  const uploading = new Promise(resolve => { releaseUpload = resolve; });
  const controller = new BrowserMaterials({ store: memoryStore(), readDuration: async () => 2,
    sampleFrames: async () => ['frame'], api: async (path, options = {}) => {
      if (path.endsWith('/analyze')) { await analysis; return { complete: true }; }
      if (path.endsWith('/file')) return { id: '3'.repeat(32), offset: 0 };
      if (options.method === 'PATCH') {
        const offset = Number(options.headers['Upload-Offset']);
        if (offset) { lastChunk = true; await uploading; }
        return { offset: offset + options.body.byteLength };
      }
      if (path.endsWith('/complete')) return { complete: true };
      return backend.api(path, options);
    } });
  controller._schedule = () => {};
  try {
    await controller.selectFiles([file]);
    await controller._cycle(controller.generation);
    serving = controller._serve({ id: '2'.repeat(32), kind: 'source',
      asset_id: controller.record.manifest['a.mp4'].assetId }, controller.generation);
    await eventually(() => lastChunk);
    releaseAnalysis();
    await Promise.all(controller.workers.values());
    assert.equal(controller.status.uploadBytes, helpers.CHUNK_SIZE);
    assert.equal(controller.status.uploadTotal, file.size);
    releaseUpload();
    await serving;
    assert.equal(controller.status.uploadTotal, 0);
  } finally { releaseAnalysis(); releaseUpload(); await serving?.catch(() => {}); controller.stop(); }
});

test('an indexing lease is refreshed to the server state without duplicate model requests', async () => {
  const backend = server();
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  let registrations = 0;
  let samples = 0;
  const controller = new BrowserMaterials({ store: memoryStore(), readDuration: async () => 2,
    sampleFrames: async () => { samples++; return ['frame']; }, api: async (path, options) => {
      const result = await backend.api(path, options);
      if (path.endsWith('/clips')) {
        registrations++;
        result.clips.forEach(clip => { clip.state = registrations === 1 ? 'indexing' : 'indexed'; });
      }
      return result;
    } });
  try {
    await controller.selectFiles([videoFile('素材/a.mp4')]);
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(controller.status.indexed, 0);
    now += 31000;
    controller.start();
    await eventually(() => controller.status.indexed === 1);
    assert.equal(samples, 0);
    assert.equal(registrations, 2);
  } finally { controller.stop(); Date.now = originalNow; }
});

test('rescan reuses unchanged vectors and indexes additions and modifications while revoking deletions', async () => {
  const files = [videoFile('a.mp4'), videoFile('b.mp4'), videoFile('unchanged.mp4')];
  const handle = directory('素材', files);
  const store = memoryStore({ folderKey: 'a'.repeat(64), name: '素材', deviceId: '1'.repeat(32), handle, manifest: {}, uploads: {} });
  const backend = server();
  let decodes = 0;
  let samples = 0;
  const controller = new BrowserMaterials({ api: backend.api, store,
    readDuration: async () => { decodes++; return 2; }, sampleFrames: async () => { samples++; return ['frame']; } });
  try {
    await controller.restore();
    await eventually(() => controller.status.indexed === 3);
    const oldIds = ['a.mp4', 'b.mp4'].map(path => store.value.manifest[path].assetId);
    files.splice(0, 2, videoFile('a.mp4', 2), videoFile('added.mp4'));
    await controller.scan();
    await eventually(() => controller.status.indexed === 3);
    assert.equal(decodes, 5);
    assert.equal(samples, 5);
    assert.deepEqual(backend.calls.filter(call => call.method === 'DELETE').map(call => call.path.split('/').pop()).sort(), oldIds.sort());
    assert.equal(store.value.manifest['b.mp4'], undefined);
    await controller.scan();
    assert.equal(decodes, 5);
    assert.equal(samples, 5);
  } finally { controller.stop(); }
});

test('an unreadable unchanged file retains its old metadata and never starts analysis', async () => {
  const readable = videoFile('a.mp4');
  const old = await helpers.inspectFile('a.mp4', readable, null, async () => 2);
  const file = { name: 'a.mp4', size: readable.size, lastModified: 1,
    slice: () => ({ arrayBuffer: async () => { throw new Error('file cannot be read'); } }) };
  const store = memoryStore({ folderKey: 'a'.repeat(64), name: '素材', deviceId: '1'.repeat(32),
    handle: directory('素材', [file]), manifest: { 'a.mp4': old }, uploads: {} });
  const backend = server();
  const controller = new BrowserMaterials({ api: backend.api, store });
  try {
    await controller.restore();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(store.value.manifest['a.mp4'].assetId, old.assetId);
    assert.match(controller.status.error, /a.mp4.*cannot be read/);
    assert.equal(backend.calls.some(call => call.method === 'DELETE' || call.path.endsWith('/analyze')), false);
  } finally { controller.stop(); }
});

test('metadata scan runs five readers and fills freed slots without waiting for a slow file', async () => {
  const readers = new Map();
  let active = 0, peak = 0;
  const controller = new BrowserMaterials({ api: server().api, store: memoryStore(), readDuration: file => {
    active++; peak = Math.max(peak, active);
    return new Promise(resolve => readers.set(file.name, () => { active--; resolve(2); }));
  } });
  const selecting = controller.selectFiles(Array.from({ length: 7 }, (_, i) => videoFile(`素材/${i}.mp4`)));
  try {
    await eventually(() => readers.size === 5);
    readers.get('1.mp4')();
    await eventually(() => readers.has('5.mp4'));
    readers.get('2.mp4')(); readers.get('5.mp4')();
    await eventually(() => readers.has('6.mp4'));
    readers.get('0.mp4')(); readers.get('3.mp4')(); readers.get('4.mp4')(); readers.get('6.mp4')();
    await selecting;
    assert.equal(peak, 5);
    assert.equal(controller.status.scanned, 7);
  } finally { controller.stop(); for (const finish of readers.values()) finish(); await selecting; }
});

test('five readers continue extracting while five analysis requests await and bound prepared frames', async () => {
  const backend = server();
  const frames = new Map(), analysis = new Map();
  let reading = 0, analyzing = 0, peakReaders = 0, peakAnalysis = 0;
  const controller = new BrowserMaterials({ store: memoryStore(), readDuration: async () => 2,
    sampleFrames: file => new Promise(resolve => {
      reading++; peakReaders = Math.max(peakReaders, reading);
      let finished = false;
      frames.set(file.name, () => { if (!finished) { finished = true; reading--; resolve(['frame']); } });
    }), api: async (path, options) => {
      if (path.endsWith('/analyze')) {
        const id = JSON.parse(options.body).clip_id;
        analyzing++; peakAnalysis = Math.max(peakAnalysis, analyzing);
        await new Promise(resolve => {
          let finished = false;
          analysis.set(id, () => { if (!finished) { finished = true; analyzing--; resolve(); } });
        });
      }
      return backend.api(path, options);
    } });
  try {
    await controller.selectFiles(Array.from({ length: 13 }, (_, i) => videoFile(`素材/${i}.mp4`)));
    await eventually(() => frames.size === 5);
    frames.get('0.mp4')();
    await eventually(() => analysis.size === 1 && frames.has('5.mp4'));
    for (const release of frames.values()) release();
    await eventually(() => analysis.size === 5 && frames.size === 10);
    for (const release of frames.values()) release();
    await eventually(() => reading === 0);
    assert.equal(analysis.size, 5, 'prepared frames must wait when all analysis slots are occupied');
    assert.equal(frames.size, 10, 'do not pre-extract the rest of the directory into memory');
    controller.start(); controller.start();
    const first = [...analysis.values()][0]; first();
    await eventually(() => analysis.size === 6 && frames.has('10.mp4'));
    for (let i = 0; i < 30 && controller.status.indexed < 13; i++) {
      for (const release of frames.values()) release();
      for (const release of analysis.values()) release();
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(controller.status.indexed, 13);
    assert.equal(peakReaders, 5);
    assert.equal(peakAnalysis, 5);
    assert.equal(analysis.size, 13, 'each clip is submitted only once');
  } finally {
    controller.stop();
    for (const release of frames.values()) release();
    for (const release of analysis.values()) release();
    await Promise.all(controller.workers.values());
  }
});

test('stopping cancels waiting extraction and analysis work without late requests or status writes', async () => {
  for (const phase of ['frames', 'analysis']) {
    const backend = server(), releases = [], statuses = [];
    let samples = 0, analyses = 0;
    const controller = new BrowserMaterials({ store: memoryStore(), readDuration: async () => 2,
      onStatus: value => statuses.push(value), sampleFrames: async () => {
        samples++;
        if (phase === 'frames') await new Promise(resolve => releases.push(resolve));
        return ['frame'];
      }, api: async (path, options) => {
        if (path.endsWith('/analyze')) { analyses++; await new Promise(resolve => releases.push(resolve)); }
        return backend.api(path, options);
      } });
    try {
      await controller.selectFiles(Array.from({ length: 10 }, (_, i) => videoFile(`素材/${i}.mp4`)));
      await eventually(() => phase === 'frames' ? samples === 5 : samples === 10 && analyses === 5);
      const count = statuses.length;
      controller.stop();
      for (const release of releases) release();
      await Promise.all(controller.workers.values());
      assert.equal(samples, phase === 'frames' ? 5 : 10);
      assert.equal(analyses, phase === 'frames' ? 0 : 5);
      assert.equal(statuses.length, count);
      assert.equal(controller.workers.size, 0);
    } finally { controller.stop(); for (const release of releases) release(); }
  }
});

test('analysis failures stop after three automatic retries for permanent and temporary errors', async () => {
  const originalNow = Date.now;
  let now = originalNow();
  try {
    Date.now = () => now;
    for (const status of [422, 503]) {
      const backend = server(), attempts = [];
      const controller = new BrowserMaterials({ store: memoryStore(), readDuration: async () => 2,
        sampleFrames: async () => ['frame'], api: async (path, options) => {
          if (path.endsWith('/analyze')) { attempts.push(JSON.parse(options.body).clip_id); throw Object.assign(new Error('analysis failed'), { status }); }
          return backend.api(path, options);
        } });
      controller._schedule = () => {};
      try {
        await controller.selectFiles(Array.from({ length: 5 }, (_, i) => videoFile(`素材/${i}.mp4`)));
        const ids = Object.values(controller.record.manifest).flatMap(entry => entry.clips.map(clip => clip.id));
        for (let round = 0; round < 4; round++) {
          await controller._cycle(controller.generation); await Promise.all(controller.workers.values());
          assert.deepEqual(new Set(attempts.slice(round * 5, (round + 1) * 5)), new Set(ids));
          now += 60000;
        }
        for (let i = 0; i < 4; i++) {
          await controller._cycle(controller.generation); await Promise.all(controller.workers.values());
          now += 60000;
        }
        assert.equal(attempts.length, 20, 'one first attempt plus exactly three retries per clip');
        assert.equal(controller.status.indexed, 0);
        assert.equal(controller.status.processing, false, 'exhausted failures must hand over to manual retry');
      } finally { controller.stop(); }
    }
  } finally { Date.now = originalNow; }
});

test('failed analysis waits until every compression and repaired first analysis has finished', async () => {
  const backend = server(), events = [], releases = [];
  const originalNow = Date.now;
  let now = originalNow(), failedId, releaseAnalysis;
  const controller = new BrowserMaterials({ store: memoryStore(), readDuration: async () => 2,
    sampleFrames: async () => ['frame'], repairVideo: file => {
      events.push('repair:' + file.name);
      return new Promise(resolve => releases.push(() => resolve(videoFile(file.name.replace('.mov', '.mp4')))));
    }, api: async (path, options) => {
      if (path.endsWith('/analyze')) {
        const id = JSON.parse(options.body).clip_id;
        events.push('analyze:' + id);
        if (id === failedId) throw Object.assign(new Error('gateway unavailable'), { status: 503 });
        if (id === controller.record.manifest['two.mov']?.clips[0].id) await new Promise(resolve => { releaseAnalysis = resolve; });
      }
      return backend.api(path, options);
    } });
  controller._schedule = () => {};
  const cycle = async () => { await controller._cycle(controller.generation); };
  const big = name => ({ name, webkitRelativePath: '素材/' + name, size: 600 * 1024 * 1024, lastModified: 1 });
  try {
    Date.now = () => now;
    await controller.selectFiles([videoFile('素材/failed.mp4'), big('one.mov'), big('two.mov')]);
    failedId = controller.record.manifest['failed.mp4'].clips[0].id;
    await cycle(); await Promise.all(controller.workers.values());
    now += 60000;
    for (const name of ['one.mov', 'two.mov']) {
      await cycle(); await eventually(() => events.includes('repair:' + name));
      await cycle();
      assert.equal(events.filter(event => event === 'analyze:' + failedId).length, 1, 'no retries while compression is active');
      releases.shift()(); await Promise.all(controller.workers.values());
      await cycle();
      if (name === 'two.mov') {
        await eventually(() => !!releaseAnalysis);
        await cycle();
        assert.equal(events.filter(event => event === 'analyze:' + failedId).length, 1, 'no retries while repaired first analysis is active');
        releaseAnalysis();
      }
      await Promise.all(controller.workers.values());
      assert.equal(events.filter(event => event === 'analyze:' + failedId).length, 1, 'repaired clips must finish their first attempt before retries');
    }
    await cycle(); await Promise.all(controller.workers.values());
    assert.equal(events.filter(event => event === 'analyze:' + failedId).length, 2);
    assert.equal(controller.status.indexed, 2);
  } finally { controller.stop(); for (const release of releases) release(); releaseAnalysis?.(); Date.now = originalNow; }
});

test('failed compression moves behind other files, retries three times, then permits manual recovery', async () => {
  const backend = server(), repairs = [], store = memoryStore();
  const originalNow = Date.now;
  let now = originalNow(), broken = true;
  const controller = new BrowserMaterials({ api: backend.api, store, readDuration: async () => 2,
    sampleFrames: async () => ['frame'], repairVideo: async file => {
      repairs.push(file.name);
      if (broken && file.name === 'bad.mov') throw new Error('conversion failed');
      return videoFile(file.name.replace('.mov', '.mp4'));
    } });
  controller._schedule = () => {};
  const cycle = async () => { await controller._cycle(controller.generation); await Promise.all(controller.workers.values()); };
  const files = ['bad.mov', 'good.mov'].map(name => ({ name, webkitRelativePath: '素材/' + name,
    size: 600 * 1024 * 1024, lastModified: 1, slice: () => new Blob(['original']) }));
  try {
    Date.now = () => now;
    await controller.selectFiles(files);
    await cycle(); await cycle(); await cycle();
    assert.deepEqual(repairs, ['bad.mov', 'good.mov']);
    assert.equal(controller.status.indexed, 1);
    assert.equal(controller.status.processing, true, 'failed conversion should wait for an automatic retry');
    for (let i = 0; i < 3; i++) { now += 60000; await cycle(); }
    for (let i = 0; i < 3; i++) { now += 60000; await cycle(); }
    assert.deepEqual(repairs, ['bad.mov', 'good.mov', 'bad.mov', 'bad.mov', 'bad.mov']);
    assert.equal(controller.status.processing, false);
    assert.match(controller.status.error, /bad.mov.*conversion failed/);
    broken = false;
    await controller.selectFiles(files);
    await cycle(); await cycle();
    assert.equal(controller.status.indexed, 2);
    assert.equal(repairs.filter(name => name === 'good.mov').length, 1, 'manual retry must reuse completed files');
    assert.equal(controller.status.error, '');
  } finally { controller.stop(); Date.now = originalNow; }
});

test('converted files that still fail extraction use bounded repair retries before manual recovery', async () => {
  const backend = server();
  let repairs = 0;
  const controller = new BrowserMaterials({ api: backend.api, store: memoryStore(), readDuration: async () => 2,
    repairVideo: async () => { repairs++; return videoFile('bad.mp4'); },
    sampleFrames: async () => { throw new Error('decode failed'); } });
  controller._schedule = () => {};
  try {
    await controller.selectFiles([videoFile('素材/bad.mov')]);
    for (let i = 0; i < 12; i++) { await controller._cycle(controller.generation); await Promise.all(controller.workers.values()); }
    assert.equal(repairs, 4, 'converted decode failures also get three extra attempts');
    assert.equal(controller.status.processing, false);
    assert.match(controller.status.error, /decode failed/);
    assert.equal(backend.calls.some(call => call.path.endsWith('/analyze')), false);
  } finally { controller.stop(); }
});

test('unreadable retained indexing records do not block retries for current readable files', async () => {
  const bad = videoFile('素材/bad.mov'), backend = server();
  const old = await helpers.inspectFile('bad.mov', bad, null, async () => 2);
  old.clips[0].state = 'indexing';
  Object.defineProperty(bad, 'slice', { value: () => { throw new Error('file is unavailable'); } });
  const store = memoryStore({ folderKey: 'a'.repeat(64), name: '素材', deviceId: '1'.repeat(32),
    manifest: { 'bad.mov': old }, uploads: {}, deferredRevocations: [] });
  let analyses = 0;
  const controller = new BrowserMaterials({ store, readDuration: async () => 2, sampleFrames: async () => ['frame'],
    api: async (path, options) => {
      if (path.endsWith('/analyze') && ++analyses === 1) throw new Error('analysis failed');
      return backend.api(path, options);
    } });
  controller._schedule = () => {};
  try {
    await controller.selectFiles([bad, videoFile('素材/good.mp4')]);
    for (let i = 0; i < 3; i++) { await controller._cycle(controller.generation); await Promise.all(controller.workers.values()); }
    assert.equal(controller.status.readyFiles, 1);
    assert.equal(analyses, 2);
    assert.equal(controller.status.processing, false);
  } finally { controller.stop(); }
});

test('temporary analysis failures recover after two attempts without rescanning or hammering the server', async () => {
  const backend = server(), attempts = new Map(), order = [];
  const originalNow = Date.now;
  let now = originalNow();
  const controller = new BrowserMaterials({ store: memoryStore(), readDuration: async () => 2,
    sampleFrames: async () => ['frame'], api: async (path, options) => {
      if (path.endsWith('/analyze')) {
        const id = JSON.parse(options.body).clip_id;
        attempts.set(id, (attempts.get(id) || 0) + 1);
        order.push(id);
        if (attempts.get(id) < 3) throw Object.assign(new Error('gateway temporarily unavailable'), { status: 502 });
      }
      return backend.api(path, options);
    } });
  controller._schedule = () => {};
  const cycle = async () => { await controller._cycle(controller.generation); await Promise.all(controller.workers.values()); };
  try {
    Date.now = () => now;
    await controller.selectFiles(Array.from({ length: 5 }, (_, i) => videoFile(`素材/${i}.mp4`)));
    await cycle(); await cycle();
    assert.equal(order.length, 5, 'fresh clips should run before any retries');
    await cycle();
    assert.equal(order.length, 5, 'temporary errors should wait before retrying');
    assert.equal(controller.status.processing, true, 'waiting for retries is still an active upload');
    now += 15000;
    await cycle(); await cycle();
    assert.equal(order.length, 10);
    await cycle();
    assert.equal(order.length, 10);
    now += 30000;
    await cycle(); await cycle();
    assert.equal(controller.status.indexed, 5, 'a third successful attempt must finish automatically');
    assert.equal(controller.status.processing, false);
    assert.equal(controller.status.error, '');
  } finally { controller.stop(); Date.now = originalNow; }
});

test('oversize and unreadable MOV repair waits for normal indexing and reuses cached MP4 copies', async () => {
  const backend = server(), events = [];
  const store = memoryStore();
  const big = { name: 'big.mov', webkitRelativePath: '素材/big.mov', size: 600 * 1024 * 1024, lastModified: 7,
    slice: () => new Blob(['x']) };
  const bad = videoFile('素材/bad.mov');
  const good = videoFile('素材/good.mp4');
  const options = { store, readDuration: async file => {
    if (file.name === 'bad.mov') throw Object.assign(new Error('MOV decode failed'), { code: 'MEDIA_DECODE' });
    return 2;
  }, sampleFrames: async file => { events.push('frames:' + file.name); return ['frame']; },
  repairVideo: async file => { events.push('repair:' + file.name); return videoFile(file.name.replace(/\.mov$/, '.mp4')); },
  api: async (path, options) => { if (path.endsWith('/analyze')) events.push('indexed'); return backend.api(path, options); } };
  let controller = new BrowserMaterials(options);
  try {
    await controller.selectFiles([big, bad, good]);
    await eventually(() => controller.status.indexed === 3);
    assert.ok(events.indexOf('indexed') < events.indexOf('repair:big.mov'));
    assert.ok(events.indexOf('indexed') < events.indexOf('repair:bad.mov'));
    assert.equal(controller.record.manifest['big.mov'].assetId, await helpers.assetId('big.mov', big.size, 7));
    assert.equal(controller.files.get('big.mov').name, 'big.mp4');
    assert.equal(controller.status.error, '');
    controller.stop();
    controller = new BrowserMaterials(options);
    await controller.selectFiles([big, bad, good]);
    assert.equal(controller.status.indexed, 3);
    assert.equal(controller.files.get('big.mov').name, 'big.mp4');
    assert.equal(controller.status.error, '');
    assert.equal(events.filter(event => event.startsWith('repair:')).length, 2);
    assert.equal(events.filter(event => event === 'indexed').length, 3);
    await controller.disconnect();
    assert.equal(store.repairs.size, 0);
  } finally { controller.stop(); }
});

test('stopping during repair cannot save a converted copy or register stale clips', async () => {
  const backend = server(), store = memoryStore();
  let release, started = false;
  const controller = new BrowserMaterials({ api: backend.api, store, readDuration: async () => 2,
    repairVideo: () => { started = true; return new Promise(resolve => { release = resolve; }); } });
  try {
    await controller.selectFiles([{ name: 'big.mov', webkitRelativePath: '素材/big.mov', size: 600 * 1024 * 1024, lastModified: 1 }]);
    await eventually(() => started);
    controller.stop(); release(videoFile('big.mp4'));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(store.repairs.size, 0);
    assert.equal(backend.calls.some(call => call.path.endsWith('/clips')), false);
  } finally { controller.stop(); release?.(videoFile('big.mp4')); }
});
