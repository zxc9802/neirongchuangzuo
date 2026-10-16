import test from 'node:test';
import assert from 'node:assert/strict';

const id = n => n.toString(16).padStart(32, '0');
const cos = 'https://hunjianx-1410143389.cos.ap-singapore.myqcloud.com/staging/video.mp4?sign=temporary';
const item = (n, overrides = {}) => ({ id: id(n), name: `video-${n}.mp4`, bytes: 5, duration: 8, state: 'ready', error: null, indexed_clips: 1, url: `/api/mix/materials/${id(n)}/stream`, ...overrides });
const file = (name, size = 5) => ({ name: name.split('/').at(-1), webkitRelativePath: name, size });
const tick = () => new Promise(resolve => setImmediate(resolve));
const eventually = async predicate => {
  for (let n = 0; n < 100 && !predicate(); n++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'cloud materials did not finish expected work');
};
const module = async () => import('../design/cloud-materials.js').catch(() => ({}));

test('cloud library restores server metadata and indexed clip readiness without local files', async () => {
  const { default: CloudMaterials = class {} } = await module();
  const calls = [], statuses = [];
  const client = new CloudMaterials({ api: async path => { calls.push(path); return { configured: true, items: [item(1)], indexed_clips: 4 }; }, onStatus: status => statuses.push(status) });
  try {
    assert.equal(typeof client.restore, 'function');
    await client.restore();
    assert.equal(client.mode, 'cloud');
    assert.deepEqual(calls, ['/api/mix/materials']);
    assert.equal(client.status.indexed, 4);
    assert.equal(client.status.connected, true);
    assert.equal(client.media[0].type, 'video');
    assert.equal(client.media[0].url, item(1).url);
    assert.equal(statuses.at(-1).totalFiles, 1);
  } finally { client.stop?.(); }
});

test('folder videos upload through signed COS PUT and finalize before server indexing', async () => {
  const { default: CloudMaterials = class {} } = await module();
  const calls = [], uploads = [];
  const client = new CloudMaterials({ api: async (path, options = {}) => {
    calls.push({ path, ...options });
    if (path.endsWith('/uploads')) return { id: id(1), upload_url: cos, headers: { 'Content-Type': 'video/mp4' } };
    if (path.endsWith('/complete')) return { item: item(1, { state: 'queued', indexed_clips: 0 }) };
    return { configured: true, items: [], indexed_clips: 0 };
  }, fetch: async (url, options) => { uploads.push({ url, ...options }); return { ok: true }; } });
  try {
    assert.equal(typeof client.selectFiles, 'function');
    const source = file('素材/子目录/a.mp4');
    await client.selectFiles([file('素材/readme.txt'), source]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].path, '/api/mix/materials/uploads');
    assert.deepEqual(JSON.parse(calls[0].body), { name: '素材/子目录/a.mp4', bytes: 5 });
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].method, 'PUT');
    assert.equal(uploads[0].credentials, 'omit');
    assert.equal(uploads[0].redirect, 'error');
    assert.equal(uploads[0].body, source);
    assert.deepEqual(uploads[0].headers, { 'Content-Type': 'video/mp4' });
    assert.equal(calls[1].path, `/api/mix/materials/${id(1)}/complete`);
    assert.equal(client.items[0].state, 'queued');
    assert.equal(client.status.uploadBytes, 5);
    assert.equal(client.scanning, false);
  } finally { client.stop?.(); }
});

test('default browser fetch retains its Window receiver when uploading directly to COS', async () => {
  const { default: CloudMaterials = class {} } = await module();
  const originalFetch = globalThis.fetch;
  let uploaded = 0, finalized = 0;
  globalThis.fetch = async function (url, options) {
    if (this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    assert.equal(url, cos);
    assert.equal(options.method, 'PUT');
    uploaded++;
    return { ok: true };
  };
  const client = new CloudMaterials({ api: async path => {
    if (path.endsWith('/uploads')) return { id: id(1), upload_url: cos, headers: {} };
    if (path.endsWith('/complete')) { finalized++; return { item: item(1, { state: 'queued', indexed_clips: 0 }) }; }
    throw new Error('unexpected API request');
  } });
  try {
    await client.selectFiles([file('browser-upload.mov')]);
    assert.equal(client.status.error, '');
    assert.equal(uploaded, 1);
    assert.equal(finalized, 1);
    assert.equal(client.status.uploadBytes, 5);
    assert.equal(client.items[0].state, 'queued');
  } finally { client.stop(); globalThis.fetch = originalFetch; }
});

test('unsafe signed upload destinations are rejected before sending source bytes', async () => {
  const { default: CloudMaterials = class {} } = await module();
  for (const upload_url of ['https://evil.example/video', '//evil.example/video', cos.replace('https:', 'http:'), cos.replace('.myqcloud.com', '.myqcloud.com.evil.example'), cos.replace('/staging', ':8443/staging'), cos.replace('https://', 'https://user:password@')]) {
    let puts = 0, completes = 0;
    const client = new CloudMaterials({ api: async path => {
      if (path.endsWith('/complete')) completes++;
      return { id: id(1), upload_url, headers: {} };
    }, fetch: async () => { puts++; return { ok: true }; } });
    try {
      assert.equal(typeof client.selectFiles, 'function');
      await client.selectFiles([file('a.mp4')]);
      assert.equal(puts, 0);
      assert.equal(completes, 0);
      assert.match(client.status.error, /上传地址/);
    } finally { client.stop?.(); }
  }
});

test('folder uploads have at most three simultaneous transfers and enforce the 5 GiB limit', async () => {
  const { default: CloudMaterials = class {} } = await module();
  let created = 0, active = 0, peak = 0;
  const releases = [];
  const client = new CloudMaterials({ api: async path => path.endsWith('/uploads')
    ? { id: id(++created), upload_url: cos, headers: {} }
    : { item: item(Number.parseInt(path.split('/').at(-2), 16)) },
  fetch: () => new Promise(resolve => { active++; peak = Math.max(peak, active); releases.push(() => { active--; resolve({ ok: true }); }); }) });
  try {
    assert.equal(typeof client.selectFiles, 'function');
    const uploading = client.selectFiles(Array.from({ length: 7 }, (_, n) => file(`folder/${n}.mov`)));
    await eventually(() => active === 3);
    assert.equal(created, 3);
    while (created < 7 || active) { releases.splice(0).forEach(release => release()); await tick(); }
    await uploading;
    assert.equal(peak, 3);
    await client.selectFiles([file('oversize.mp4', 5 * 1024 ** 3 + 1)]);
    assert.equal(created, 7);
    assert.match(client.status.error, /5 GiB/);
  } finally { releases.forEach(release => release()); client.stop?.(); }
});

test('stop and account changes abort transfers and ignore stale restored libraries', async () => {
  const { default: CloudMaterials = class {} } = await module();
  const original = globalThis.workspaceUser;
  globalThis.workspaceUser = { id: 'a' };
  let release, signal, updates = 0;
  const client = new CloudMaterials({ api: async (path, options) => { signal = options.signal; return new Promise(resolve => { release = resolve; }); }, onStatus: () => updates++ });
  try {
    assert.equal(typeof client.restore, 'function');
    const restoring = client.restore();
    await tick();
    const before = updates;
    globalThis.workspaceUser = { id: 'b' };
    release({ configured: true, items: [item(1)], indexed_clips: 1 });
    await assert.rejects(restoring, { name: 'AbortError' });
    assert.equal(signal.aborted, true);
    assert.deepEqual(client.media, []);
    assert.equal(updates, before);
  } finally { client.stop?.(); globalThis.workspaceUser = original; }

  let putSignal, finishPut, finalized = false;
  const uploading = new CloudMaterials({ api: async path => {
    if (path.endsWith('/complete')) finalized = true;
    return { id: id(1), upload_url: cos, headers: {} };
  }, fetch: async (url, options) => { putSignal = options.signal; return new Promise(resolve => { finishPut = resolve; }); } });
  try {
    const work = uploading.selectFiles([file('a.mp4')]);
    await eventually(() => !!putSignal);
    uploading.stop();
    assert.equal(putSignal.aborted, true);
    finishPut({ ok: true });
    await work;
    assert.equal(finalized, false);
  } finally { uploading.stop?.(); finishPut?.({ ok: true }); }
});

test('queued indexing polls durable state and retry/delete use owned asset API routes', async () => {
  const { default: CloudMaterials = class {} } = await module();
  const calls = [];
  let polls = 0;
  const client = new CloudMaterials({ pollInterval: 5, api: async (path, options = {}) => {
    calls.push({ path, ...options });
    if (options.method === 'DELETE') return { ok: true };
    if (path.endsWith('/retry')) return { item: item(1, { state: 'queued', indexed_clips: 0 }) };
    return { configured: true, items: [item(1, { state: ++polls < 2 ? 'indexing' : 'ready' })], indexed_clips: polls < 2 ? 0 : 1 };
  } });
  try {
    assert.equal(typeof client.restore, 'function');
    await client.restore();
    await eventually(() => client.status.indexed === 1);
    await client.retry(id(1));
    assert.equal(client.items[0].state, 'queued');
    await client.delete(id(1));
    assert.deepEqual(client.items, []);
    assert.ok(calls.some(call => call.path === `/api/mix/materials/${id(1)}/retry` && call.method === 'POST'));
    assert.ok(calls.some(call => call.path === `/api/mix/materials/${id(1)}` && call.method === 'DELETE'));
    client.stop();
    const count = calls.length;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls.length, count);
  } finally { client.stop?.(); }
});

test('a slow library snapshot cannot restore an asset deleted after the snapshot began', async () => {
  const { default: CloudMaterials = class {} } = await module();
  let release, reads = 0;
  const client = new CloudMaterials({ api: async (path, options = {}) => {
    if (options.method === 'DELETE') return { ok: true };
    if (++reads === 1) return { configured: true, items: [item(1)], indexed_clips: 1 };
    return new Promise(resolve => { release = resolve; });
  } });
  try {
    await client.restore();
    const refreshing = client.refresh();
    await tick();
    await client.delete(id(1));
    release({ configured: true, items: [item(1)], indexed_clips: 1 });
    await refreshing;
    assert.deepEqual(client.items, []);
    assert.equal(client.status.indexed, 0);
  } finally { client.stop?.(); }
});

test('a file picker completed after stop cannot upload for the old account', async () => {
  const { default: CloudMaterials = class {} } = await module();
  const original = globalThis.document;
  let changed, calls = 0;
  globalThis.document = { createElement: () => ({ files: [file('a.mp4')], addEventListener: (name, fn) => { changed = fn; }, click() {} }) };
  const client = new CloudMaterials({ api: async () => { calls++; } });
  try {
    client.choose();
    client.stop();
    await changed();
    await tick();
    assert.equal(calls, 0);
  } finally { client.stop?.(); globalThis.document = original; }
});

test('a rejected old-account restore aborts without reporting its network error', async () => {
  const { default: CloudMaterials = class {} } = await module();
  const original = globalThis.workspaceUser;
  globalThis.workspaceUser = { id: 'first' };
  let reject;
  const client = new CloudMaterials({ api: () => new Promise((resolve, fail) => { reject = fail; }) });
  try {
    const restoring = client.restore();
    globalThis.workspaceUser = { id: 'second' };
    reject(new Error('old account network failed'));
    await assert.rejects(restoring, { name: 'AbortError' });
    assert.equal(client.active, false);
    assert.equal(client.error, '');
  } finally { client.stop?.(); globalThis.workspaceUser = original; }
});

test('cloud selection accepts only extensions supported by the server', async () => {
  const { default: CloudMaterials = class {} } = await module();
  const supported = ['mp4', 'mov', 'mkv', 'avi', 'm4v', 'mts', 'm2ts', 'webm'];
  const created = [];
  const originalDocument = globalThis.document;
  const input = { addEventListener() {}, click() {} };
  globalThis.document = { createElement: () => input };
  const client = new CloudMaterials({ api: async (path, options = {}) => {
    if (path.endsWith('/uploads')) {
      created.push(JSON.parse(options.body).name);
      return { id: id(created.length), upload_url: cos, headers: {} };
    }
    return { item: item(Number.parseInt(path.split('/').at(-2), 16)) };
  }, fetch: async () => ({ ok: true }) });
  try {
    client.choose();
    assert.deepEqual(input.accept.split(',').sort(), supported.map(extension => `.${extension}`).sort());
    await client.selectFiles([...supported, 'wmv', 'mpeg', 'mpg', '3gp', 'flv', 'ts'].map(extension => file(`a.${extension}`)));
    assert.deepEqual(created.sort(), supported.map(extension => `a.${extension}`).sort());
  } finally { client.stop?.(); globalThis.document = originalDocument; }
});

test('partial checkpoints on failed or queued assets never enable cloud readiness', async () => {
  const { default: CloudMaterials = class {} } = await module();
  for (const state of ['failed', 'queued', 'indexing']) {
    const client = new CloudMaterials({ api: async path => {
      if (path.endsWith('/uploads')) return { id: id(1), upload_url: cos, headers: {} };
      return { item: item(1, { state, indexed_clips: 5 }) };
    }, fetch: async () => ({ ok: true }) });
    try {
      await client.selectFiles([file('a.mp4')]);
      assert.equal(client.status.indexed, 0, `${state} checkpoints are not ready clips`);
    } finally { client.stop?.(); }
  }
  const client = new CloudMaterials({ api: async (path, options = {}) => {
    if (options.method === 'DELETE') return { ok: true };
    if (path.endsWith('/retry')) return { item: item(1, { state: 'queued', indexed_clips: 5 }) };
    return { configured: true, items: [item(1, { state: 'failed', indexed_clips: 5 })], indexed_clips: 0 };
  } });
  try {
    await client.restore();
    await client.retry(id(1));
    assert.equal(client.status.indexed, 0);
    await client.delete(id(1));
    assert.equal(client.status.indexed, 0, 'deleting partial checkpoints cannot reduce ready clips');
  } finally { client.stop?.(); }
  const ready = new CloudMaterials({ api: async path => path.endsWith('/retry')
    ? { item: item(1, { state: 'queued', indexed_clips: 5 }) }
    : { configured: true, items: [item(1, { indexed_clips: 2 })], indexed_clips: 2 } });
  try {
    await ready.restore();
    await ready.retry(id(1));
    assert.equal(ready.status.indexed, 0, 'requeuing a ready asset removes its ready clips');
  } finally { ready.stop?.(); }
});

test('uploading assets stay in management without exposing an unavailable preview stream', async () => {
  const { default: CloudMaterials = class {} } = await module();
  let finish;
  const client = new CloudMaterials({ api: async path => path.endsWith('/uploads') ? { id: id(1), upload_url: cos, headers: {} }
    : { item: item(1, { state: 'queued', indexed_clips: 0 }) },
  fetch: () => new Promise(resolve => { finish = resolve; }) });
  try {
    const uploading = client.selectFiles([file('a.mp4')]);
    await eventually(() => !!finish);
    assert.equal(client.items.length, 1);
    assert.equal(client.status.totalFiles, 1);
    assert.deepEqual(client.media, []);
    finish({ ok: true });
    await uploading;
    assert.equal(client.media.length, 1);
  } finally { client.stop?.(); finish?.({ ok: true }); }
});
