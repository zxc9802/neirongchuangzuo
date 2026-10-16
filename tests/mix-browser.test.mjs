import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import BrowserMaterials from '../design/browser-materials.js';
const helpers = BrowserMaterials?.helpers || {};
const digest = value => createHash('sha256').update(value).digest('hex');

test('cloud progress polls independently of analysis and ignores a late response after stopping', async () => {
  const backend = server();
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const reports = [];
  const controller = new BrowserMaterials({ store: memoryStore(), readDuration: async () => 2,
    sampleFrames: async () => ['frame'], trackProgress: true, onStatus: status => reports.push(status),
    api: async (path, options) => {
      if (path.endsWith('/progress')) return blocked;
      return backend.api(path, options);
    } });
  try {
    await controller.selectFiles([videoFile('素材/a.mp4')]);
    await eventually(() => controller.status.indexed === 1);
    assert.equal(controller.status.scanTotal, 1);
    assert.equal(controller.status.prepared, 1);
    assert.ok(reports.some(status => status.stages.frames.active === 1));
    assert.ok(reports.some(status => status.stages.analysis.active === 1));
    const count = reports.length;
    controller.stop();
    release({ total: 999, ready: 999 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reports.length, count);
    assert.equal(controller.status.cloud, null);
  } finally { controller.stop(); release({}); }
});

test('restoring a folder without read permission still displays saved cloud analysis progress', async () => {
  const store = memoryStore({ folderKey: 'a'.repeat(64), name: '素材', deviceId: '1'.repeat(32),
    handle: { queryPermission: async () => 'prompt' }, manifest: {}, uploads: {} });
  const calls = [];
  const controller = new BrowserMaterials({ store, trackProgress: true, api: async path => {
    calls.push(path);
    return { total: 7, vectorized: 7, described: 4, ready: 4 };
  } });
  try {
    await controller.restore();
    await eventually(() => controller.status.cloud?.ready === 4);
    assert.equal(controller.status.needsPermission, true);
    assert.equal(controller.connected, false);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].endsWith('/progress'));
  } finally { controller.stop(); }
});

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
  return { value: record, async get() { return this.value; }, async put(value) { this.value = value; },
    async clear() { this.value = null; } };
}

// A multi-gigabyte file whose bytes are generated on demand: `header` at the start, zeros after it.
function largeFile(path, size, header = new Uint8Array(0), modified = 1) {
  const reads = [];
  return { name: path.split('/').pop(), webkitRelativePath: path, size, lastModified: modified, reads,
    slice(start = 0, end = size) {
      end = Math.min(end, size);
      reads.push([start, end]);
      const bytes = new Uint8Array(Math.max(0, end - start));
      if (start < header.length) bytes.set(header.subarray(start, Math.min(end, header.length)));
      return new Blob([bytes]);
    } };
}

function box(kind, size, largesize) {
  const bytes = new Uint8Array(largesize === undefined ? Math.max(8, Math.min(size, 64)) : 16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, largesize === undefined ? size : 1);
  for (let i = 0; i < 4; i++) bytes[4 + i] = kind.charCodeAt(i);
  if (largesize !== undefined) view.setBigUint64(8, BigInt(largesize));
  return bytes;
}

// ftyp(24) + moov(100) + mdat with a 64-bit size that runs to the end of the file.
function mp4Header(size) {
  const header = new Uint8Array(140);
  header.set(box('ftyp', 24), 0);
  header.set(box('moov', 100), 24);
  header.set(box('mdat', 0, size - 124), 124);
  return header;
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
  const clips = new Map();
  return { calls, states, async api(path, options = {}) {
    const body = options.body && typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    calls.push({ path, method: options.method || 'GET', body, signal: options.signal });
    if (path.endsWith('/connect')) return { device_id: '1'.repeat(32) };
    if (path.endsWith('/clips')) return { clips: body.clips.map(clip => {
      clips.set(clip.id, clip);
      if (!states.has(clip.id)) states.set(clip.id, 'pending');
      return { id: clip.id, state: states.get(clip.id) };
    }) };
    if (path.endsWith('/requests')) return { requests: [] };
    if (path.endsWith('/analysis-source')) return { source_ready: true,
      request: { ...clips.get(body.clip_id), id: '8'.repeat(32), clip_id: body.clip_id, kind: 'analysis' } };
    if (path.endsWith('/analyze')) { states.set(body.clip_id, 'indexed'); return { complete: true }; }
    return { ok: true };
  } };
}

async function eventually(predicate) {
  // Deadline-based (performance.now, since tests freeze Date.now) so a busy machine does not fail slow timers.
  for (const deadline = performance.now() + 3000; performance.now() < deadline;) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  if (predicate()) return;
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

test('matching requests and queued analysis both complete without reanalyzing indexed clips', async () => {
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
    await eventually(() => controller.status.indexed === 1 && events.includes('proxy'));
    await controller._cycle(controller.generation);
    assert.deepEqual([...events].sort(), ['analysis', 'proxy']);
  } finally { controller.stop(); }
});

test('a stalled mix source upload leaves all eight analysis slots running and new clips advancing', async () => {
  const backend = server(), releases = new Map();
  const source = videoFile('素材/source.mp4', 1, Buffer.alloc(helpers.CHUNK_SIZE + 7));
  let releaseUpload, cycle, uploading = false, completed = false, frames = 0, analyses = 0, peak = 0, creates = 0, polls = 0;
  const upload = new Promise(resolve => { releaseUpload = resolve; });
  const controller = new BrowserMaterials({ store: memoryStore(), readDuration: async () => 2,
    wasmMedia: { extractSegment: async () => ({ file: source, origin: 0 }) },
    sampleFrames: async () => { frames++; return ['frame']; }, api: async (path, options = {}) => {
      if (path.endsWith('/clips')) {
        const result = await backend.api(path, options);
        const sourceId = controller.record.manifest['source.mp4']?.clips[0].id;
        result.clips.forEach(clip => { if (clip.id === sourceId) clip.state = 'indexed'; });
        return result;
      }
      if (path.endsWith('/requests')) { polls++; return { requests: completed ? [] : [{ id: '2'.repeat(32), kind: 'source',
        asset_id: controller.record.manifest['source.mp4'].assetId }] }; }
      if (path.endsWith('/segment')) { creates++; return { id: '3'.repeat(32), offset: 0 }; }
      if (options.method === 'PATCH') {
        uploading = true; await upload;
        return { offset: Number(options.headers['Upload-Offset']) + options.body.byteLength };
      }
      if (path.endsWith('/complete')) { completed = true; return { complete: true }; }
      if (path.endsWith('/analyze')) {
        analyses++; peak = Math.max(peak, analyses);
        const id = JSON.parse(options.body).clip_id;
        await new Promise(resolve => releases.set(id, resolve));
        analyses--;
      }
      return backend.api(path, options);
    } });
  controller._schedule = () => {};
  try {
    await controller.selectFiles([source, ...Array.from({ length: 20 }, (_, i) => videoFile(`素材/${i}.mp4`))]);
    cycle = controller._cycle(controller.generation);
    await eventually(() => uploading);
    await eventually(() => analyses === 8 && frames === 13);
    assert.equal(controller.workers.size, 13, 'the transfer must not occupy a background pipeline slot');
    for (const release of releases.values()) release();
    await eventually(() => controller.status.indexed >= 9);
    await controller._cycle(controller.generation);
    await eventually(() => frames === 20);
    assert.equal(peak, 8);
    assert.equal(creates, 1, 'repeated cycles must not duplicate the active upload');
    assert.equal(polls, 1, 'do not poll overlapping copies of the same active transfer');
    for (let i = 0; i < 4; i++) {
      for (const release of releases.values()) release();
      await new Promise(resolve => setImmediate(resolve));
      await controller._cycle(controller.generation);
    }
    await eventually(() => controller.status.indexed === 21);
    assert.equal(completed, false, 'indexing finished while the source upload was still waiting');
    const reports = [];
    controller.onStatus = status => reports.push(status);
    const requestWork = controller.requestWorker;
    controller.stop(); releaseUpload();
    await Promise.all([cycle, requestWork]);
    assert.equal(completed, false, 'cancelled upload must not complete after a late response');
    assert.equal(reports.length, 0);
  } finally {
    controller.stop(); releaseUpload(); for (const release of releases.values()) release();
    await Promise.all([cycle, controller.requestWorker]);
  }
});

test('slow mix request polling or heartbeat cannot block background analysis', async () => {
  for (const blocked of ['/requests', '/heartbeat']) {
    const backend = server();
    let release, cycle, waiting = false, blockedCalls = 0;
    const pending = new Promise(resolve => { release = resolve; });
    const controller = new BrowserMaterials({ store: memoryStore(), readDuration: async () => 2,
      sampleFrames: async () => ['frame'], api: async (path, options) => {
        if (path.endsWith(blocked)) { blockedCalls++; waiting = true; await pending; }
        return backend.api(path, options);
      } });
    controller._schedule = () => {};
    try {
      await controller.selectFiles(Array.from({ length: 3 }, (_, i) => videoFile(`素材/${i}.mp4`)));
      cycle = controller._cycle(controller.generation);
      await eventually(() => waiting);
      await eventually(() => controller.status.indexed === 3);
      for (let i = 0; i < 3; i++) await controller._cycle(controller.generation);
      assert.equal(blockedCalls, 1, 'keep only one material request worker per connection');
      const work = controller.requestWorker;
      controller.stop(); release(); await Promise.all([cycle, work]);
    } finally { controller.stop(); release(); await Promise.all([cycle, controller.requestWorker]); }
  }
});

test('failed mix request polling or heartbeat backs off while background analysis continues', async () => {
  const originalNow = Date.now;
  let now = originalNow();
  try {
    Date.now = () => now;
    for (const failed of ['/requests', '/heartbeat']) {
      const backend = server();
      let failedCalls = 0;
      const controller = new BrowserMaterials({ store: memoryStore(), readDuration: async () => 2,
        sampleFrames: async () => ['frame'], api: async (path, options) => {
          if (path.endsWith(failed) && ++failedCalls === 1) throw new Error('mix connection unavailable');
          return backend.api(path, options);
        } });
      controller._schedule = () => {};
      const cycle = async () => {
        await controller._cycle(controller.generation);
        await Promise.all([...controller.workers.values(), controller.requestWorker]);
      };
      try {
        await controller.selectFiles(Array.from({ length: 3 }, (_, i) => videoFile(`素材/${i}.mp4`)));
        await cycle();
        assert.equal(controller.status.indexed, 3);
        for (let i = 0; i < 3; i++) await cycle();
        assert.equal(failedCalls, 1, 'fast indexing completions must not hammer a failed mix connection');
        now += 3000;
        await cycle();
        assert.equal(failedCalls, 2, 'retry the mix connection after its own cooldown');
      } finally { controller.stop(); }
    }
  } finally { Date.now = originalNow; }
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

test('multi-gigabyte sources are indexed after reading only a small fingerprint', async () => {
  const backend = server();
  const file = largeFile('素材/huge.mp4', 6 * 1024 ** 3);
  const controller = new BrowserMaterials({ api: backend.api, store: memoryStore(), readDuration: async () => 20 });
  controller._schedule = () => {};
  try {
    await controller.selectFiles([file]);
    assert.equal(controller.status.error, '');
    const registered = backend.calls.find(call => call.path.endsWith('/clips')).body.clips;
    assert.equal(registered.length, 3);
    assert.ok(registered.every(clip => /^[a-f0-9]{64}$/.test(clip.content_key)));
    assert.ok(file.reads.reduce((total, [start, end]) => total + end - start, 0) <= 3 * 65536 + 1,
      'scanning must not read the whole video');
  } finally { controller.stop(); }
});

test('MOV clips try local decoding with compatible fallback and reselecting the folder reuses indexed clips', async () => {
  const backend = server();
  const attempts = [];
  const originalNow = Date.now;
  let now = originalNow();
  let broken = true;
  const controller = new BrowserMaterials({ api: backend.api, store: memoryStore(), readDuration: async () => 16,
    wasmMedia: { probe: async () => { throw new Error('读取视频超时'); } },
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
    assert.deepEqual(attempts.sort(), ['bad.mov', 'bad.mov', 'good.mp4', 'good.mp4']);
    assert.equal(controller.status.indexed, 4);
    assert.equal(controller.status.error, '');
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
  const controller = new BrowserMaterials({ store: memoryStore(), readDuration: async () => 64,
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

test('segment requests resume the server offset in a new controller after a lost acknowledgement', async () => {
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
  const options = { store, wasmMedia: { extractSegment: async () => ({ file, origin: 0 }) }, readDuration: async () => 2, api: async (path, config) => {
    if (path.endsWith('/clips')) {
      const result = await backend.api(path, config);
      result.clips.forEach(clip => { clip.state = 'indexed'; });
      return result;
    }
    if (path.endsWith('/requests')) return { requests: fulfilled ? [] : [{ id: '2'.repeat(32),
      asset_id: store.value.manifest['a.mp4'].assetId, start: 0, end: 2, kind: 'source' }] };
    if (path.endsWith('/segment')) { creates++; return { id: '3'.repeat(32), offset }; }
    if (config?.method === 'PATCH') {
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
    assert.equal(offset, helpers.CHUNK_SIZE);
    allowHead = true;
    controller = new BrowserMaterials(options);
    await controller.restore();
    await eventually(() => fulfilled && !store.value.uploads['2'.repeat(32)]);
    assert.equal(creates, 2);
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
    wasmMedia: { extractSegment: async () => ({ file, origin: 0 }) },
    sampleFrames: async () => ['frame'], api: async (path, options = {}) => {
      if (path.endsWith('/analyze')) { await analysis; return { complete: true }; }
      if (path.endsWith('/segment')) return { id: '3'.repeat(32), offset: 0 };
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

test('a slow metadata read cannot hold back indexing for readable files', async () => {
  const backend = server();
  let release, slowStarted = false, probes = 0;
  const controller = new BrowserMaterials({ api: backend.api, store: memoryStore(),
    readDuration: file => file.name === 'slow.mov' ? new Promise(resolve => {
      slowStarted = true; release = () => resolve(2);
    }) : file.name === 'bad.mp4' ? Promise.reject(Object.assign(new Error('decode failed'), { code: 'MEDIA_DECODE' }))
      : Promise.resolve(2), sampleFrames: async () => ['frame'],
    wasmMedia: { probe: async () => { probes++; return { duration: 2 }; } } });
  const selecting = controller.selectFiles([videoFile('素材/slow.mov'), videoFile('素材/good.mp4'), videoFile('素材/bad.mp4')]);
  try {
    await eventually(() => slowStarted);
    await eventually(() => controller.status.indexed === 1);
    assert.equal(controller.scanning, true, 'the good file must finish before the slow scan');
    assert.equal(controller.record.manifest['good.mp4'].clips[0].state, 'indexed');
    await controller._cycle(controller.generation);
    assert.equal(probes, 0, 'compatibility reads wait until the initial scan and normal analysis finish');
    release(); await selecting;
    await eventually(() => controller.status.indexed === 3);
  } finally { controller.stop(); release?.(); await selecting; }
});

test('browser metadata reads use metadata preload and allow thirty seconds before a distinct timeout', async () => {
  const original = { document: globalThis.document, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  let expire, timeout, video;
  class Video extends EventTarget {
    load() {}
    pause() {}
    removeAttribute() { this.src = ''; }
  }
  globalThis.document = { createElement: () => (video = new Video()) };
  globalThis.setTimeout = (callback, delay) => { expire = callback; timeout = delay; return 1; };
  globalThis.clearTimeout = () => {};
  const reading = helpers.readDuration(new Blob(['video']));
  const outcome = reading.catch(error => error);
  try {
    assert.equal(video.preload, 'metadata', 'metadata discovery must not preload whole network videos');
    assert.equal(timeout, 30000);
    expire();
    assert.equal((await outcome).code, 'MEDIA_TIMEOUT');
    assert.equal(video.src, '');
  } finally { expire?.(); await outcome; Object.assign(globalThis, original); }
});

test('a stalled first-byte read has a deadline before metadata decoding begins', async () => {
  const original = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  let expire, timeout, decodes = 0;
  globalThis.setTimeout = (callback, delay) => { expire = callback; timeout = delay; return 1; };
  globalThis.clearTimeout = () => {};
  const file = { size: 20, lastModified: 1, slice: () => ({ arrayBuffer: () => new Promise(() => {}) }) };
  const reading = helpers.inspectFile('slow.mov', file, null, async () => { decodes++; return 2; });
  const outcome = reading.catch(error => error);
  try {
    assert.equal(typeof expire, 'function', 'network file reads must not wait forever');
    assert.equal(timeout, 30000);
    expire();
    assert.equal((await outcome).code, 'MEDIA_TIMEOUT');
    assert.equal(decodes, 0);
  } finally { expire?.(); Object.assign(globalThis, original); }
});

test('a cancelled local file read cannot start decoding or persist a late result', async () => {
  const abort = new AbortController();
  let release, started, decodes = 0;
  const began = new Promise(resolve => { started = resolve; });
  const file = { size: 20, lastModified: 1, slice: () => ({ arrayBuffer: () => {
    started(); return new Promise(resolve => { release = resolve; });
  } }) };
  const reading = helpers.inspectFile('slow.mov', file, null, async () => { decodes++; return 2; }, () => {}, abort.signal);
  const rejected = assert.rejects(reading, error => error.name === 'AbortError');
  await began;
  abort.abort();
  await rejected;
  release(new ArrayBuffer(1));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(decodes, 0);
});

test('stopping a streaming scan prevents queued registrations and late status updates', async () => {
  const backend = server(), statuses = [];
  let release, registrations = 0;
  const controller = new BrowserMaterials({ store: memoryStore(), readDuration: async () => 2,
    onStatus: status => statuses.push(status), api: async (path, options) => {
      if (path.endsWith('/clips')) {
        registrations++;
        await new Promise(resolve => { release = resolve; });
      }
      return backend.api(path, options);
    } });
  const selecting = controller.selectFiles([videoFile('素材/a.mp4'), videoFile('素材/b.mp4')]);
  try {
    await eventually(() => !!release && controller.status.scanned === 2);
    const count = statuses.length;
    controller.stop(); release(); await selecting;
    assert.equal(registrations, 1);
    assert.equal(statuses.length, count);
    assert.equal(backend.calls.some(call => call.path.endsWith('/analyze')), false);
  } finally { controller.stop(); release?.(); await selecting; }
});

test('extraction timeouts retry after normal files without forcing server decoding', async () => {
  const backend = server(), originalNow = Date.now;
  let now = originalNow(), reads = 0, probes = 0;
  const controller = new BrowserMaterials({ api: backend.api, store: memoryStore(), readDuration: async () => 2,
    sampleFrames: async file => {
      if (file.name === 'slow.mp4' && ++reads === 1) throw Object.assign(new Error('读取视频超时'), { code: 'MEDIA_TIMEOUT' });
      return ['frame'];
    }, wasmMedia: { probe: async () => { probes++; throw new Error('unnecessary compatibility read'); } } });
  controller._schedule = () => {};
  const cycle = async () => { await controller._cycle(controller.generation); await Promise.all(controller.workers.values()); };
  try {
    Date.now = () => now;
    await controller.selectFiles([videoFile('素材/slow.mp4'), videoFile('素材/good.mp4')]);
    await cycle(); await cycle();
    assert.equal(controller.status.indexed, 1);
    assert.equal(probes, 0, 'slow reads alone do not prove incompatible encoding');
    now += 15000;
    await cycle();
    assert.equal(controller.status.indexed, 2);
    assert.equal(reads, 2);
    assert.equal(controller.record.manifest['slow.mp4'].decoder, undefined);
    assert.equal(backend.calls.some(call => call.path.endsWith('/analysis-source')), false);
    assert.equal(controller.status.error, '');
  } finally { controller.stop(); Date.now = originalNow; }
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

test('five readers continue extracting while eight analysis requests await and bound prepared frames', async () => {
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
    await controller.selectFiles(Array.from({ length: 20 }, (_, i) => videoFile(`素材/${i}.mp4`)));
    await eventually(() => frames.size === 5);
    frames.get('0.mp4')();
    await eventually(() => analysis.size === 1 && frames.has('5.mp4'));
    for (const release of frames.values()) release();
    await eventually(() => analysis.size === 6 && frames.size === 11);
    for (const release of frames.values()) release();
    await eventually(() => analysis.size === 8 && frames.size === 13);
    for (const release of frames.values()) release();
    await eventually(() => reading === 0);
    assert.equal(analysis.size, 8, 'prepared frames must wait when all analysis slots are occupied');
    assert.equal(frames.size, 13, 'do not pre-extract the rest of the directory into memory');
    controller.start(); controller.start();
    const first = [...analysis.values()][0]; first();
    await eventually(() => analysis.size === 9 && frames.has('13.mp4'));
    for (let i = 0; i < 40 && controller.status.indexed < 20; i++) {
      for (const release of frames.values()) release();
      for (const release of analysis.values()) release();
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(controller.status.indexed, 20);
    assert.equal(peakReaders, 5);
    assert.equal(peakAnalysis, 8);
    assert.equal(analysis.size, 20, 'each clip is submitted only once');
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
      await controller.selectFiles(Array.from({ length: 20 }, (_, i) => videoFile(`素材/${i}.mp4`)));
      await eventually(() => phase === 'frames' ? samples === 5 : samples === 13 && analyses === 8);
      const count = statuses.length;
      controller.stop();
      for (const release of releases) release();
      await Promise.all(controller.workers.values());
      assert.equal(samples, phase === 'frames' ? 5 : 13);
      assert.equal(analyses, phase === 'frames' ? 0 : 8);
      assert.equal(statuses.length, count);
      assert.equal(controller.workers.size, 0);
    } finally { controller.stop(); for (const release of releases) release(); }
  }
});

test('every analysis error waits at the tail between its three automatic retries', async () => {
  const originalNow = Date.now;
  let now = originalNow();
  try {
    Date.now = () => now;
    for (const status of [400, 403, 404, 422, 503, undefined]) {
      const backend = server();
      let analyses = 0;
      const controller = new BrowserMaterials({ store: memoryStore(), readDuration: async () => 2,
        sampleFrames: async () => ['frame'], api: async (path, options) => {
          if (path.endsWith('/analyze')) {
            analyses++;
            throw Object.assign(new Error('output_blocked: PROHIBITED_CONTENT'), { status });
          }
          return backend.api(path, options);
        } });
      controller._schedule = () => {};
      const cycle = async () => { await controller._cycle(controller.generation); await Promise.all(controller.workers.values()); };
      try {
        await controller.selectFiles([videoFile('素材/blocked.mp4')]);
        await cycle();
        for (const delay of [15000, 30000, 60000]) {
          const before = analyses;
          now += delay - 1;
          await cycle();
          assert.equal(analyses, before, 'all errors must wait before the next attempt');
          now++;
          await cycle();
          assert.equal(analyses, before + 1);
        }
        now += 60000;
        await cycle();
        assert.equal(analyses, 4);
        assert.equal(controller.status.processing, false);
        assert.match(controller.status.error, /PROHIBITED_CONTENT/);
      } finally { controller.stop(); }
    }
  } finally { Date.now = originalNow; }
});

test('unclassified file read errors wait behind normal clips and compatibility reads before recovery', async () => {
  const backend = server(), events = [];
  const originalNow = Date.now;
  let now = originalNow(), badReads = 0, release;
  const controller = new BrowserMaterials({ store: memoryStore(), readDuration: async file => {
    if (file.name === 'bad.mp4' && ++badReads === 1) throw new Error('temporary file read failure');
    if (file.name === 'big.mov') throw Object.assign(new Error('decode failed'), { code: 'MEDIA_DECODE' });
    return 2;
  }, sampleFrames: async file => { events.push('frames:' + file.name); return ['frame']; },
  wasmMedia: { probe: file => {
    events.push('repair:' + file.name);
    return new Promise(resolve => { release = () => resolve({ duration: 2 }); });
  } }, api: backend.api });
  controller._schedule = () => {};
  const cycle = async () => { await controller._cycle(controller.generation); await Promise.all(controller.workers.values()); };
  try {
    Date.now = () => now;
    await controller.selectFiles([videoFile('素材/bad.mp4'), videoFile('素材/good.mp4'), videoFile('素材/big.mov')]);
    await cycle();
    assert.equal(controller.status.indexed, 1);
    await controller._cycle(controller.generation);
    await eventually(() => !!release);
    now += 60000;
    await controller._cycle(controller.generation);
    assert.equal(badReads, 1, 'do not retry a read while a compatibility read is active');
    release(); await Promise.all(controller.workers.values());
    await cycle();
    assert.equal(badReads, 1, 'compatibility-read files get their first analysis before failed reads');
    await cycle(); await cycle();
    assert.equal(badReads, 2);
    assert.equal(controller.status.indexed, 3);
    assert.deepEqual(events.filter(event => event.startsWith('repair:')), ['repair:big.mov']);
    assert.equal(controller.status.error, '');
  } finally { controller.stop(); release?.(); Date.now = originalNow; }
});

test('failed file handles get three tail retries and can later recover manually', async () => {
  const backend = server(), originalNow = Date.now;
  let now = originalNow(), reads = 0, broken = true;
  const handle = { name: '素材', queryPermission: async () => 'granted', async *values() {
    yield { kind: 'file', name: 'bad.mp4', async getFile() {
      reads++;
      if (broken) throw new Error('file temporarily unavailable');
      return videoFile('bad.mp4');
    } };
    yield { kind: 'file', name: 'good.mp4', async getFile() { return videoFile('good.mp4'); } };
  } };
  const store = memoryStore({ folderKey: 'a'.repeat(64), name: '素材', deviceId: '1'.repeat(32), handle,
    manifest: {}, uploads: {}, deferredRevocations: [] });
  const controller = new BrowserMaterials({ store, api: backend.api, readDuration: async () => 2,
    sampleFrames: async () => ['frame'], wasmMedia: { probe: async () => { assert.fail('read errors do not require compatibility reads'); } } });
  controller._schedule = () => {};
  const cycle = async () => { await controller._cycle(controller.generation); await Promise.all(controller.workers.values()); };
  try {
    Date.now = () => now;
    await controller.restore();
    await cycle();
    assert.equal(controller.status.indexed, 1);
    assert.equal(controller.status.processing, true);
    for (let i = 0; i < 3; i++) { now += 60000; await cycle(); }
    now += 60000; await cycle();
    assert.equal(reads, 4, 'initial read plus three automatic retries');
    assert.equal(controller.status.processing, false);
    broken = false;
    await controller.scan(); await cycle();
    assert.equal(controller.status.indexed, 2);
    assert.equal(backend.calls.filter(call => call.path.endsWith('/analyze')).length, 2, 'reuse the completed good clip');
    assert.equal(controller.status.error, '');
  } finally { controller.stop(); Date.now = originalNow; }
});

test('clip registration errors automatically retry at the tail before starting analysis', async () => {
  const backend = server(), originalNow = Date.now;
  let now = originalNow(), registrations = 0;
  const controller = new BrowserMaterials({ store: memoryStore(), readDuration: async () => 2,
    sampleFrames: async () => ['frame'], api: async (path, options) => {
      if (path.endsWith('/clips') && ++registrations === 1) throw Object.assign(new Error('registration failed'), { status: 400 });
      return backend.api(path, options);
    } });
  controller._schedule = () => {};
  const cycle = async () => { await controller._cycle(controller.generation); await Promise.all(controller.workers.values()); };
  try {
    Date.now = () => now;
    await controller.selectFiles([videoFile('素材/a.mp4')]);
    await cycle();
    assert.equal(controller.status.processing, true);
    assert.equal(backend.calls.some(call => call.path.endsWith('/analyze')), false);
    now += 15000;
    await cycle(); await cycle();
    assert.equal(registrations, 2);
    assert.equal(controller.status.indexed, 1);
    assert.equal(controller.status.error, '');
  } finally { controller.stop(); Date.now = originalNow; }
});

test('recovered file reads can still move to server decoding if their frames fail', async () => {
  const backend = server(), originalNow = Date.now;
  let now = originalNow(), reads = 0, probes = 0;
  const controller = new BrowserMaterials({ store: memoryStore(), api: backend.api, readDuration: async () => {
    if (++reads === 1) throw new Error('temporary metadata failure');
    return 2;
  }, sampleFrames: async () => { throw Object.assign(new Error('frames cannot be decoded'), { code: 'MEDIA_DECODE' }); },
  wasmMedia: { probe: async () => { probes++; return { duration: 2 }; } } });
  controller._schedule = () => {};
  const cycle = async () => { await controller._cycle(controller.generation); await Promise.all(controller.workers.values()); };
  try {
    Date.now = () => now;
    await controller.selectFiles([videoFile('素材/bad.mp4')]);
    await cycle(); await cycle();
    assert.equal(reads, 1, 'a failed read waits before its tail retry');
    now += 15000;
    await cycle(); await cycle();
    assert.equal(reads, 2);
    assert.equal(controller.status.indexed, 1);
    assert.equal(controller.record.manifest['bad.mp4'].decoder, 'server');
    assert.equal(probes, 0, 'a readable file only moves its frame decoding to the server');
    assert.equal(controller.status.error, '');
  } finally { controller.stop(); Date.now = originalNow; }
});

test('stopping during a deferred file read prevents late registration and status changes', async () => {
  const backend = server(), originalNow = Date.now, statuses = [];
  let now = originalNow(), reads = 0, release;
  const handle = { name: '素材', queryPermission: async () => 'granted', async *values() {
    yield { kind: 'file', name: 'a.mp4', async getFile() {
      if (++reads === 1) throw new Error('temporary read failure');
      return new Promise(resolve => { release = () => resolve(videoFile('a.mp4')); });
    } };
  } };
  const store = memoryStore({ folderKey: 'a'.repeat(64), name: '素材', deviceId: '1'.repeat(32), handle,
    manifest: {}, uploads: {}, deferredRevocations: [] });
  const controller = new BrowserMaterials({ store, api: backend.api, readDuration: async () => 2,
    onStatus: value => statuses.push(value) });
  controller._schedule = () => {};
  try {
    Date.now = () => now;
    await controller.restore();
    now += 15000;
    await controller._cycle(controller.generation);
    await eventually(() => !!release);
    const count = statuses.length;
    controller.stop(); release();
    await Promise.all(controller.workers.values());
    assert.equal(statuses.length, count);
    assert.equal(backend.calls.some(call => call.path.endsWith('/clips') || call.path.endsWith('/analyze')), false);
    assert.deepEqual(store.value.manifest, {});
  } finally { controller.stop(); release?.(); Date.now = originalNow; }
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

const undecodable = async file => {
  if (/\.mov$/.test(file.name)) throw Object.assign(new Error('MOV decode failed'), { code: 'MEDIA_DECODE' });
  return 2;
};

test('failed analysis waits until every compatibility probe and server first analysis has finished', async () => {
  const backend = server(), events = [], releases = [];
  const originalNow = Date.now;
  let now = originalNow(), failedId, releaseAnalysis, blockedName;
  const controller = new BrowserMaterials({ store: memoryStore(), readDuration: undecodable,
    sampleFrames: async () => ['frame'], wasmMedia: {
      probe: file => {
        events.push('probe:' + file.name);
        return new Promise(resolve => releases.push(() => resolve({ duration: 2 })));
      }, sampleFrames: async () => ['frame'] },
    api: async (path, options) => {
      if (path.endsWith('/analyze')) {
        const id = JSON.parse(options.body).clip_id;
        events.push('analyze:' + id);
        if (id === failedId) throw Object.assign(new Error('gateway unavailable'), { status: 503 });
        if (id === controller.record.manifest[blockedName]?.clips[0].id) await new Promise(resolve => { releaseAnalysis = resolve; });
      }
      return backend.api(path, options);
    } });
  controller._schedule = () => {};
  const cycle = async () => { await controller._cycle(controller.generation); };
  try {
    Date.now = () => now;
    await controller.selectFiles([videoFile('素材/failed.mp4'), videoFile('素材/one.mov'), videoFile('素材/two.mov')]);
    // Parallel metadata reads may finish in either order. Exercise the reverse order.
    controller.repairs = new Map([...controller.repairs].sort(([a], [b]) => b.localeCompare(a)));
    blockedName = [...controller.repairs.keys()].at(-1);
    failedId = controller.record.manifest['failed.mp4'].clips[0].id;
    await cycle(); await Promise.all(controller.workers.values());
    now += 60000;
    for (const name of controller.repairs.keys()) {
      await cycle(); await eventually(() => events.includes('probe:' + name));
      await cycle();
      assert.equal(events.filter(event => event === 'analyze:' + failedId).length, 1, 'no retries while probing is active');
      releases.shift()(); await Promise.all(controller.workers.values());
      await cycle();
      if (name === blockedName) {
        await eventually(() => !!releaseAnalysis);
        await cycle();
        assert.equal(events.filter(event => event === 'analyze:' + failedId).length, 1, 'no retries while server first analysis is active');
        releaseAnalysis();
      }
      await Promise.all(controller.workers.values());
      assert.equal(events.filter(event => event === 'analyze:' + failedId).length, 1, 'server clips must finish their first attempt before retries');
      assert.equal(controller.record.manifest[name].decoder, 'wasm');
    }
    await cycle(); await Promise.all(controller.workers.values());
    assert.equal(events.filter(event => event === 'analyze:' + failedId).length, 2);
    assert.equal(controller.status.indexed, 2);
  } finally { controller.stop(); for (const release of releases) release(); releaseAnalysis?.(); Date.now = originalNow; }
});

test('failed compatibility probing moves behind other files, retries three times, then permits manual recovery', async () => {
  const backend = server(), probes = [], store = memoryStore();
  const originalNow = Date.now;
  let now = originalNow(), broken = true;
  const controller = new BrowserMaterials({ api: backend.api, store, readDuration: undecodable,
    sampleFrames: async () => ['frame'], wasmMedia: { probe: async file => {
      probes.push(file.name);
      if (broken && file.name === 'bad.mov') throw new Error('wasm probe failed');
      return { duration: 2 };
    }, sampleFrames: async () => ['frame'] } });
  controller._schedule = () => {};
  const cycle = async () => { await controller._cycle(controller.generation); await Promise.all(controller.workers.values()); };
  const files = [videoFile('素材/bad.mov'), videoFile('素材/good.mov')];
  try {
    Date.now = () => now;
    await controller.selectFiles(files);
    await cycle(); await cycle(); await cycle();
    assert.deepEqual(probes, ['bad.mov', 'good.mov']);
    assert.equal(controller.status.indexed, 1);
    assert.equal(controller.status.processing, true, 'failed probing should wait for an automatic retry');
    for (let i = 0; i < 3; i++) { now += 60000; await cycle(); }
    for (let i = 0; i < 3; i++) { now += 60000; await cycle(); }
    assert.deepEqual(probes, ['bad.mov', 'good.mov', 'bad.mov', 'bad.mov', 'bad.mov']);
    assert.equal(controller.status.processing, false);
    assert.match(controller.status.error, /bad.mov.*wasm probe failed/);
    broken = false;
    await controller.selectFiles(files);
    await cycle(); await cycle();
    assert.equal(controller.status.indexed, 2);
    assert.equal(probes.filter(name => name === 'good.mov').length, 1, 'manual retry must reuse completed files');
    assert.equal(store.value.manifest['good.mov'].decoder, 'wasm');
    assert.equal(controller.status.error, '');
  } finally { controller.stop(); Date.now = originalNow; }
});

test('server proxy failures retry without probing or decoding the original again', async () => {
  const backend = server();
  const originalNow = Date.now;
  let now = originalNow();
  let probes = 0, prepared = 0;
  const controller = new BrowserMaterials({ api: async (path, options) => {
    if (path.endsWith('/analysis-source')) { prepared++; throw new Error('server decode failed'); }
    return backend.api(path, options);
  }, store: memoryStore(), readDuration: undecodable,
    sampleFrames: async () => { throw new Error('browser decode failed'); },
    wasmMedia: { probe: async () => { probes++; return { duration: 2 }; },
      sampleFrames: async () => { throw new Error('wasm decode failed'); } } });
  controller._schedule = () => {};
  const cycle = async () => { await controller._cycle(controller.generation); await Promise.all(controller.workers.values()); };
  try {
    Date.now = () => now;
    await controller.selectFiles([videoFile('素材/bad.mov')]);
    await cycle(); await cycle(); await cycle();
    for (const delay of [15000, 30000, 60000]) {
      const before = prepared;
      now += delay - 1;
      await cycle();
      assert.equal(prepared, before, 'server proxy failures must wait before retrying');
      now++;
      await cycle(); await cycle();
      assert.equal(prepared, before + 1);
    }
    await cycle();
    assert.equal(prepared, 4, 'server proxy failures also get three extra attempts');
    assert.equal(probes, 1, 'metadata probing is retained across proxy retries');
    assert.equal(controller.status.processing, false);
    assert.match(controller.status.error, /server decode failed/);
    assert.equal(backend.calls.some(call => call.path.endsWith('/analyze')), false);
  } finally { controller.stop(); Date.now = originalNow; }
});

test('unreadable retained indexing records do not block retries for current readable files', async () => {
  const originalNow = Date.now;
  let now = originalNow();
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
    Date.now = () => now;
    await controller.selectFiles([bad, videoFile('素材/good.mp4')]);
    for (let i = 0; i < 6; i++) {
      await controller._cycle(controller.generation); await Promise.all(controller.workers.values());
      now += 60000;
    }
    assert.equal(controller.status.readyFiles, 1);
    assert.equal(analyses, 2);
    assert.equal(controller.status.processing, false);
  } finally { controller.stop(); Date.now = originalNow; }
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

test('duration repair probes metadata once then extracts local frames without copying originals', async () => {
  const backend = server(), events = [];
  const store = memoryStore();
  const big = largeFile('素材/big.mp4', 3 * 1024 ** 3, new Uint8Array(0), 7);
  const bad = videoFile('素材/bad.mov');
  const good = videoFile('素材/good.mp4');
  const options = { store, readDuration: undecodable,
    sampleFrames: async file => { events.push('frames:' + file.name); return ['frame']; },
    wasmMedia: { probe: async file => { events.push('probe:' + file.name); return { duration: 2 }; },
      sampleFrames: async file => { events.push('wasm:' + file.name); return ['frame']; } },
    api: async (path, options) => { if (path.endsWith('/analyze')) events.push('indexed'); return backend.api(path, options); } };
  let controller = new BrowserMaterials(options);
  try {
    await controller.selectFiles([big, bad, good]);
    await eventually(() => controller.status.indexed === 3);
    assert.ok(events.indexOf('indexed') < events.indexOf('probe:bad.mov'));
    assert.deepEqual(events.filter(event => event.endsWith('bad.mov')), ['probe:bad.mov', 'wasm:bad.mov']);
    assert.equal(controller.files.get('bad.mov'), bad, 'the original file is read in place');
    assert.equal(controller.record.manifest['bad.mov'].decoder, 'wasm');
    assert.equal(controller.record.manifest['big.mp4'].decoder, undefined);
    assert.equal(controller.record.manifest['big.mp4'].assetId, await helpers.assetId('big.mp4', big.size, 7));
    assert.equal(controller.status.error, '');
    controller.stop();
    controller = new BrowserMaterials(options);
    await controller.selectFiles([big, bad, good]);
    assert.equal(controller.status.indexed, 3);
    assert.equal(controller.status.error, '');
    assert.equal(events.filter(event => event.startsWith('probe:')).length, 1, 'the saved decoder choice is reused');
    assert.equal(events.filter(event => event === 'indexed').length, 3);
    await controller.disconnect();
  } finally { controller.stop(); }
});

test('stopping during compatibility probing cannot register stale clips', async () => {
  const backend = server(), store = memoryStore();
  let release, started = false;
  const controller = new BrowserMaterials({ api: backend.api, store, readDuration: undecodable,
    wasmMedia: { probe: () => { started = true; return new Promise(resolve => { release = resolve; }); } } });
  try {
    await controller.selectFiles([videoFile('素材/big.mov')]);
    await eventually(() => started);
    controller.stop(); release({ duration: 2 });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(backend.calls.some(call => call.path.endsWith('/clips')), false);
    assert.deepEqual(store.value.manifest, {});
  } finally { controller.stop(); release?.({ duration: 2 }); }
});

test('MP4 index scan keeps every box except media payloads and rejects other layouts', async () => {
  const size = 5 * 1024 ** 3;
  assert.deepEqual(await helpers.mp4Index(largeFile('a.mp4', size, mp4Header(size))), [[0, 140]]);
  const tail = new Uint8Array(300);
  tail.set(box('ftyp', 24), 0);
  tail.set(box('mdat', 200), 24);
  tail.set(box('moov', 76), 224);
  assert.deepEqual(await helpers.mp4Index(largeFile('b.mov', 300, tail)), [[0, 32], [224, 300]], 'camera files put moov last');
  const open = new Uint8Array(200);
  open.set(box('ftyp', 24), 0);
  open.set(box('moov', 40), 24);
  open.set(box('mdat', 0), 64);
  assert.deepEqual(await helpers.mp4Index(largeFile('c.mp4', 200, open)), [[0, 72]], 'a zero size runs to the end');
  const fragmented = new Uint8Array(200);
  fragmented.set(box('ftyp', 24), 0);
  fragmented.set(box('moov', 40), 24);
  fragmented.set(box('moof', 36), 64);
  fragmented.set(box('mdat', 100), 100);
  assert.equal(await helpers.mp4Index(largeFile('d.mp4', 200, fragmented)), null);
  assert.equal(await helpers.mp4Index(largeFile('e.mkv', 1000, new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))), null);
  const truncated = new Uint8Array(100);
  truncated.set(box('ftyp', 24), 0);
  truncated.set(box('mdat', 500), 24);
  assert.equal(await helpers.mp4Index(largeFile('f.mp4', 100, truncated)), null);
  const noMovie = new Uint8Array(100);
  noMovie.set(box('ftyp', 24), 0);
  noMovie.set(box('mdat', 76), 24);
  assert.equal(await helpers.mp4Index(largeFile('g.mp4', 100, noMovie)), null);
});

function sourceHarness(file, handlers, options = {}, request = { id: '2'.repeat(32), kind: 'source', start: 3, end: 5 }) {
  const backend = server(), patches = [], posts = [];
  let fulfilled = false;
  const store = memoryStore();
  const controller = new BrowserMaterials({ store, readDuration: async () => 20, sampleFrames: async () => ['frame'], ...options,
    api: async (path, config = {}) => {
      if (path.endsWith('/clips')) {
        const result = await backend.api(path, config);
        result.clips.forEach(clip => { clip.state = 'indexed'; });
        return result;
      }
      if (path.endsWith('/requests')) {
        return { requests: fulfilled ? [] : [{ ...request, asset_id: store.value.manifest[file.name].assetId }] };
      }
      if (config.method === 'PATCH') {
        assert.equal(config.headers['Upload-Checksum'], digest(Buffer.from(config.body)));
        assert.ok(config.body.byteLength <= helpers.CHUNK_SIZE);
        const offset = Number(config.headers['Upload-Offset']);
        patches.push([path.split('/').pop(), offset, config.body.byteLength]);
        return { offset: offset + config.body.byteLength };
      }
      const name = path.split('/').pop();
      if (['file', 'sparse', 'segment', 'plan', 'complete', 'frames'].includes(name)) {
        posts.push(name);
        const result = await handlers[name](JSON.parse(config.body));
        if (name === 'complete' || name === 'frames') fulfilled = true;
        return result;
      }
      return backend.api(path, config);
    } });
  return { controller, patches, posts, done: () => fulfilled };
}

test('small and large MP4 sources upload only the index and the planned packet ranges', async () => {
  for (const size of [8 * 1024 ** 2, 3 * 1024 ** 3]) {
  const file = largeFile('素材/long.mp4', size, mp4Header(size));
  const bodies = {}, id = '4'.repeat(32);
  const { controller, patches, posts, done } = sourceHarness(file, {
    sparse: body => { bodies.sparse = body; return { id, ranges: [[0, 140]] }; },
    plan: () => ({ id, ranges: [[1000, 1000 + helpers.CHUNK_SIZE + 9]] }),
    complete: () => ({ complete: true }) });
  try {
    await controller.selectFiles([file]);
    await eventually(done);
    assert.deepEqual(bodies.sparse, { size, ranges: [[0, 140]] });
    assert.deepEqual(posts, ['sparse', 'plan', 'complete']);
    assert.deepEqual(patches, [[id, 0, 140], [id, 1000, helpers.CHUNK_SIZE], [id, 1000 + helpers.CHUNK_SIZE, 9]]);
    assert.equal(controller.status.error, '');
  } finally { controller.stop(); }
  }
});

test('a sparse plan the server cannot cut falls back to a wasm stream-copied segment', async () => {
  const size = 3 * 1024 ** 3;
  const file = largeFile('素材/long.mp4', size, mp4Header(size));
  const segments = [], bodies = {};
  const { controller, patches, posts, done } = sourceHarness(file, {
    sparse: () => ({ id: '4'.repeat(32), ranges: [] }),
    plan: () => { throw Object.assign(new Error('无法解析原视频索引'), { status: 422 }); },
    segment: body => { bodies.segment = body; return { id: '5'.repeat(32), offset: 0 }; },
    complete: () => ({ complete: true }) }, { wasmMedia: { extractSegment: async (source, start, end) => {
    segments.push([source, start, end]);
    return { file: new Blob(['segment-bytes']), origin: 1.5 };
  } } });
  try {
    await controller.selectFiles([file]);
    await eventually(done);
    assert.deepEqual(segments, [[file, 3, 5]]);
    assert.deepEqual(posts, ['sparse', 'plan', 'segment', 'complete']);
    assert.deepEqual(bodies.segment, { size: 13, origin: 1.5 });
    assert.deepEqual(patches, [['5'.repeat(32), 0, 13]]);
  } finally { controller.stop(); }
});

test('small sources fall back to segments when sparse parsing fails without uploading full files', async () => {
  const size = 50000, file = largeFile('素材/a.mov', size, mp4Header(size));
  const { controller, posts, patches, done } = sourceHarness(file, {
    sparse: () => { throw Object.assign(new Error('已有完整原片缓存'), { status: 422 }); },
    segment: () => ({ id: '5'.repeat(32), offset: 0 }), complete: () => ({ complete: true }) }, { wasmMedia: { extractSegment: async () => ({ file: new Blob(['segment']), origin: 0 }) } });
  try {
    await controller.selectFiles([file]);
    await eventually(done);
    assert.deepEqual(posts, ['sparse', 'segment', 'complete']);
    assert.deepEqual(patches, [['5'.repeat(32), 0, 7]], 'only the requested segment is uploaded');
  } finally { controller.stop(); }
});

test('large non-MP4 sources send only a segment around the requested clip', async () => {
  const file = largeFile('素材/long.mkv', 2 * 1024 ** 3, new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]));
  const { controller, posts, done } = sourceHarness(file, {
    segment: () => ({ id: '5'.repeat(32), offset: 0 }), complete: () => ({ complete: true }) },
  { wasmMedia: { extractSegment: async () => ({ file: new Blob(['segment']), origin: 0 }) } });
  try {
    await controller.selectFiles([file]);
    await eventually(done);
    assert.deepEqual(posts, ['segment', 'complete']);
    assert.ok(file.reads.every(([start, end]) => end - start <= 65536), 'the large original is never streamed');
  } finally { controller.stop(); }
});

test('a preview request switches an indexed video to native transfer when browser sampling fails', async () => {
  const file = videoFile('素材/a.mp4');
  const { controller, done, posts } = sourceHarness(file, {
    segment: () => ({ id: '5'.repeat(32), offset: 0 }), complete: () => ({ complete: true }) }, {
    sampleFrames: async () => { throw Object.assign(new Error('seek failed'), { code: 'MEDIA_DECODE' }); },
    wasmMedia: { extractSegment: async () => ({ file: new Blob(['segment']), origin: 0 }) } },
  { id: '2'.repeat(32), kind: 'proxy', start: 0, end: 2 });
  try {
    await controller.selectFiles([file]);
    await eventually(done);
    assert.deepEqual(posts, ['segment', 'complete']);
    assert.equal(controller.record.manifest['a.mp4'].decoder, 'server');
  } finally { controller.stop(); }
});

test('MOV and wasm entries extract local frames while saved server fallback remains usable', async () => {
  for (const decoder of [undefined, 'server', 'wasm']) {
    const file = videoFile(decoder ? '素材/a.mp4' : '素材/a.MOV'), backend = server();
    const entry = await helpers.inspectFile(file.name, file, null, async () => 2);
    entry.decoder = decoder;
    const store = memoryStore({ folderKey: 'a'.repeat(64), name: '素材', deviceId: '1'.repeat(32),
      manifest: { [file.name]: entry }, uploads: {}, deferredRevocations: [] });
    let sampled = 0;
    const controller = new BrowserMaterials({ store, api: backend.api, readDuration: async () => 2,
      sampleFrames: async () => { sampled++; return ['frame']; },
      wasmMedia: { sampleFrames: async () => { sampled++; return ['frame']; } } });
    try {
      await controller.selectFiles([file]);
      await eventually(() => controller.status.indexed === 1);
      assert.equal(sampled, decoder === 'server' ? 0 : 1);
      const body = backend.calls.find(call => call.path.endsWith('/analyze')).body;
      assert.deepEqual(body, decoder === 'server' ? { clip_id: entry.clips[0].id, source_request_id: '8'.repeat(32) }
        : { clip_id: entry.clips[0].id, frames: ['frame'] });
      assert.equal(controller.files.get(file.name), file);
      assert.equal(controller.record.manifest[file.name].assetId, entry.assetId);
    } finally { controller.stop(); }
  }
});

test('failed normal sampling starts native analysis while another normal reader is still blocked', async () => {
  const backend = server();
  let release;
  const controller = new BrowserMaterials({ store: memoryStore(), api: backend.api, readDuration: async () => 2,
    sampleFrames: file => file.name === 'bad.mp4' ? Promise.reject(new Error('cannot decode')) :
      new Promise(resolve => { release = () => resolve(['frame']); }) });
  try {
    await controller.selectFiles([videoFile('素材/bad.mp4'), videoFile('素材/slow.mp4')]);
    await eventually(() => controller.status.indexed === 1);
    assert.equal(controller.record.manifest['bad.mp4'].decoder, 'server');
    assert.equal(backend.calls.filter(call => call.path.endsWith('/analysis-source')).length, 1);
    release();
    await eventually(() => controller.status.indexed === 2);
  } finally { controller.stop(); release?.(); }
});

test('small MOV native proxies prefer sparse packets and skip analysis requests in the render poller', async () => {
  const file = largeFile('素材/a.mov', 50000, mp4Header(50000));
  const backend = server(), steps = [], id = '6'.repeat(32);
  let request, prepared = false;
  const controller = new BrowserMaterials({ store: memoryStore(), readDuration: async () => 2,
    sampleFrames: () => { throw new Error('browser frame path used'); }, api: async (path, options = {}) => {
      if (path.endsWith('/analysis-source')) {
        const clip = controller.record.manifest['a.mov'].clips[0];
        request = { id: '7'.repeat(32), clip_id: clip.id, asset_id: clip.asset_id, start: 0, end: 2, kind: 'analysis' };
        return { request, source_ready: false };
      }
      if (path.endsWith('/requests')) return { requests: request ? [request] : [] };
      const name = path.split('/').pop();
      if (['file', 'sparse', 'plan', 'complete'].includes(name)) steps.push(name);
      if (name === 'sparse') return { id, ranges: [[0, 140]] };
      if (name === 'plan') return { id, ranges: [[1000, 2000]] };
      if (name === 'complete') { prepared = true; return { complete: true }; }
      if (options.method === 'PATCH') return { offset: Number(options.headers['Upload-Offset']) + options.body.byteLength };
      if (name === 'analyze') assert.equal(prepared, true);
      return backend.api(path, options);
    } });
  try {
    await controller.selectFiles([file]);
    await eventually(() => controller.status.indexed === 1);
    controller.lastRequests = 0;
    controller._startRequests(controller.generation);
    await controller.requestWorker;
    assert.deepEqual(steps, ['sparse', 'plan', 'complete']);
    assert.deepEqual(controller.requests, []);
  } finally { controller.stop(); }
});

test('native analysis and render share one transfer stage and release it before model work', async () => {
  const backend = server(), file = videoFile('素材/a.mov');
  let transferActive = 0, peak = 0, releaseTransfer, releaseModel, modelStarted = false, completed = 0;
  const controller = new BrowserMaterials({ store: memoryStore(), readDuration: async () => 2,
    api: async (path, options) => {
      if (path.endsWith('/analysis-source')) {
        const clip = controller.record.manifest['a.mov'].clips[0];
        return { request: { id: '7'.repeat(32), clip_id: clip.id, asset_id: clip.asset_id, start: 0, end: 2, kind: 'analysis' }, source_ready: false };
      }
      if (path.endsWith('/analyze')) { modelStarted = true; await new Promise(resolve => { releaseModel = resolve; }); }
      return backend.api(path, options);
    } });
  controller._sendLarge = async () => {
    transferActive++; peak = Math.max(peak, transferActive);
    if (!releaseTransfer) await new Promise(resolve => { releaseTransfer = resolve; });
    transferActive--; completed++;
  };
  try {
    await controller.selectFiles([file]);
    await eventually(() => !!releaseTransfer);
    const entry = controller.record.manifest['a.mov'];
    const rendering = controller._serve({ id: '9'.repeat(32), asset_id: entry.assetId, kind: 'source', start: 0, end: 2 }, controller.generation);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, 0);
    releaseTransfer();
    await rendering;
    await eventually(() => modelStarted);
    assert.equal(peak, 1);
    assert.equal(completed, 2, 'render must proceed while the model is pending');
    releaseModel();
    await eventually(() => controller.status.indexed === 1);
  } finally { controller.stop(); releaseTransfer?.(); releaseModel?.(); }
});

test('stopping cancels queued native transfers before preparation or model submission', async () => {
  const backend = server();
  let release, preparations = 0;
  const controller = new BrowserMaterials({ store: memoryStore(), readDuration: async () => 2,
    api: async (path, options) => {
      if (path.endsWith('/analysis-source')) {
        preparations++;
        await new Promise(resolve => { release = resolve; });
      }
      return backend.api(path, options);
    } });
  try {
    await controller.selectFiles([videoFile('素材/one.mov'), videoFile('素材/two.mov')]);
    await eventually(() => !!release && controller.stages.transfer.waiting.length === 1);
    const workers = [...controller.workers.values()];
    controller.stop();
    release();
    await Promise.all(workers);
    assert.equal(preparations, 1);
    assert.equal(backend.calls.some(call => call.path.endsWith('/analyze')), false);
  } finally { controller.stop(); release?.(); }
});

test('a saved folder reconnects with one permission prompt and keeps the site storage', async () => {
  const originalPicker = globalThis.showDirectoryPicker;
  const handle = directory('素材', [videoFile('a.mp4')], 'prompt');
  let requested = 0, answer = 'denied', persisted = 0;
  handle.requestPermission = options => { requested++; assert.deepEqual(options, { mode: 'read' }); return Promise.resolve(answer); };
  const store = memoryStore({ folderKey: 'a'.repeat(64), name: '素材', deviceId: '1'.repeat(32), handle, manifest: {}, uploads: {} });
  const backend = server(), pickers = [];
  globalThis.showDirectoryPicker = async options => { pickers.push(options); return handle; };
  Object.defineProperty(globalThis.navigator, 'storage', { value: { persist: async () => { persisted++; return true; } }, configurable: true });
  const options = { store, api: backend.api, readDuration: async () => 2, sampleFrames: async () => ['frame'] };
  let controller = new BrowserMaterials(options);
  try {
    await controller.restore();
    assert.equal(controller.status.needsPermission, true);
    const refused = controller.choose();
    assert.equal(requested, 1, 'the permission prompt must open inside the click');
    await refused;
    assert.equal(controller.status.needsPermission, true);
    assert.match(controller.status.error, /再次点击/);
    assert.equal(backend.calls.length, 0);
    await controller.choose();
    assert.equal(requested, 1, 'after a refusal the next click opens the picker');
    assert.deepEqual(pickers, [{ mode: 'read', id: 'mix-materials', startIn: handle }]);
    assert.equal(controller.connected, true);
    controller.stop();

    controller = new BrowserMaterials(options);
    await controller.restore();
    answer = 'granted';
    const reconnecting = controller.choose();
    assert.equal(requested, 2);
    await reconnecting;
    assert.equal(pickers.length, 1, 'a granted permission needs no picker');
    assert.equal(controller.connected, true);
    assert.equal(controller.status.needsPermission, false);
    assert.equal(controller.status.error, '');
    await eventually(() => controller.status.indexed === 1);
    assert.ok(persisted >= 1, 'ask the browser to keep the saved folder handle');
  } finally {
    controller.stop();
    globalThis.showDirectoryPicker = originalPicker;
    delete globalThis.navigator.storage;
  }
});

test('content keys follow the video bytes so moved or renamed files reuse paid analysis', async () => {
  const a = await helpers.inspectFile('a.mp4', videoFile('a.mp4', 1, 'same video'), null, async () => 10);
  const b = await helpers.inspectFile('folder/b.mp4', videoFile('b.mp4', 9, 'same video'), null, async () => 10);
  const c = await helpers.inspectFile('a.mp4', videoFile('a.mp4', 1, 'edit video'), null, async () => 10);
  assert.notEqual(a.assetId, b.assetId);
  assert.deepEqual(a.clips.map(clip => clip.content_key), b.clips.map(clip => clip.content_key));
  assert.notDeepEqual(a.clips.map(clip => clip.content_key), c.clips.map(clip => clip.content_key));
  assert.notEqual(a.clips[0].content_key, a.clips[1].content_key);
  const legacy = structuredClone(a);
  delete legacy.fingerprint;
  legacy.clips.forEach(clip => { delete clip.content_key; });
  legacy.repaired = true;
  const upgraded = await helpers.inspectFile('a.mp4', videoFile('a.mp4', 1, 'same video'), legacy,
    async () => { throw new Error('unchanged file decoded'); });
  assert.equal(upgraded, legacy, 'saved entries are upgraded in place');
  assert.equal(upgraded.repaired, undefined);
  assert.deepEqual(upgraded.clips.map(clip => clip.content_key), a.clips.map(clip => clip.content_key));
});

test('opening the folder store drops the old transcoded-copy cache', async () => {
  const original = globalThis.indexedDB;
  const versions = [], deleted = [], created = [];
  globalThis.indexedDB = { open(name, version) {
    versions.push(version);
    const request = {};
    queueMicrotask(() => {
      request.result = { objectStoreNames: { contains: store => ['folder', 'repairs'].includes(store) },
        createObjectStore: store => created.push(store), deleteObjectStore: store => deleted.push(store),
        transaction() {
          const tx = { objectStore: () => ({ get: () => ({ result: null }) }) };
          queueMicrotask(() => tx.oncomplete());
          return tx;
        } };
      request.onupgradeneeded();
      request.onsuccess();
    });
    return request;
  } };
  try {
    const store = helpers.createFolderStore('materials-test');
    assert.equal(await store.get(), null);
    assert.deepEqual(versions, [3]);
    assert.deepEqual(deleted, ['repairs']);
    assert.deepEqual(created, []);
    assert.equal(store.putRepair, undefined);
  } finally { globalThis.indexedDB = original; }
});

function lockManager() {
  const queue = [];
  let held = false;
  const grant = () => {
    if (held || !queue.length) return;
    const item = queue.shift();
    held = true;
    Promise.resolve().then(item.callback).then(item.resolve, item.reject).finally(() => { held = false; grant(); });
  };
  return { request(name, options, callback) {
    return new Promise((resolve, reject) => {
      const item = { callback, resolve, reject };
      options.signal?.addEventListener('abort', () => {
        const index = queue.indexOf(item);
        if (index >= 0) { queue.splice(index, 1); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }
      }, { once: true });
      queue.push(item);
      grant();
    });
  } };
}

test('only one tab of an account processes materials and another tab takes over when it stops', async () => {
  const locks = lockManager(), backend = server(), analyses = [], polls = [];
  const create = name => new BrowserMaterials({ store: memoryStore(), locks, readDuration: async () => 2,
    sampleFrames: async () => ['frame'], api: async (path, options = {}) => {
      if (path.endsWith('/analyze')) analyses.push(name);
      if (path.endsWith('/requests')) polls.push(name);
      return backend.api(path, options);
    } });
  const first = create('first'), second = create('second');
  try {
    await first.selectFiles([videoFile('素材/a.mp4')]);
    await eventually(() => first.status.indexed === 1);
    await second.selectFiles([videoFile('素材/b.mp4')]);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(first.leading, true);
    assert.equal(second.leading, false);
    assert.equal(second.status.follower, true);
    assert.match(second.status.text, /另一个标签页正在处理素材/);
    assert.deepEqual(analyses, ['first']);
    assert.equal(polls.includes('second'), false, 'a following tab must not serve upload requests');
    first.stop();
    await eventually(() => second.status.indexed === 1);
    assert.equal(second.leading, true);
    assert.deepEqual(analyses, ['first', 'second']);
  } finally { first.stop(); second.stop(); }
});
