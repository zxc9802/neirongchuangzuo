import test from 'node:test';
import assert from 'node:assert/strict';
import BrowserMaterials from '../design/browser-materials.js';
import { renderStudio, bindStudio } from '../design/studios.js';

const id = 'a'.repeat(32);
const settle = async predicate => {
  for (let count = 0; count < 100 && !predicate(); count++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'browser UI did not finish expected work');
};

async function fixture({ files = 1, fetchJob, pending, useShared = false, health = { browser_materials: true, configured: true, indexing_configured: true, missing: [] } } = {}) {
  const original = Object.fromEntries(['workspaceUser', 'document', 'window', 'location', 'indexedDB', 'localStorage', 'fetch'].map(key => [key, globalThis[key]]));
  const storage = new Map();
  const databases = new Map();
  const calls = [];
  const videos = [];
  const manifest = {};
  for (let n = 0; n < files; n++) {
    const name = `sub/video-${n}.mp4`;
    const file = new Blob(['video']);
    Object.defineProperties(file, { name: { value: `video-${n}.mp4` }, lastModified: { value: 1 } });
    const assetId = await BrowserMaterials.helpers.assetId(name, file.size, 1);
    videos.push({ name, file });
    manifest[name] = { relativePath: name, assetId, size: file.size, lastModified: 1, duration: 2,
      clips: await BrowserMaterials.helpers.makeClips(assetId, name, 2) };
    manifest[name].clips.forEach(clip => { clip.state = 'indexed'; });
  }
  const handle = { name: '素材', kind: 'directory', queryPermission: async () => 'granted',
    async *values() { yield { name: 'sub', kind: 'directory', async *values() {
      for (const { file } of videos) yield { name: file.name, kind: 'file', getFile: async () => file };
    } }; } };
  databases.set('workbench-browser-materials:account-a', { name: '素材', handle, folderKey: 'b'.repeat(64), deviceId: 'c'.repeat(32), manifest, uploads: {} });
  if (pending) storage.set('mix-active-job:account-a', JSON.stringify(pending));
  const events = new Map();
  const nodes = {
    '#mix-material-status': { innerHTML: '' },
    '[data-action="studio-generate"]': { disabled: true, title: '' },
    '#studio-generation-hint': { textContent: '' },
    '#studio-char-count': { textContent: '' },
    '#studio-prompt': { addEventListener(name, fn) { this[name] = fn; } },
  };
  const root = { querySelector: selector => nodes[selector] || null, querySelectorAll: () => [] };
  globalThis.document = { querySelector: selector => ['.mix-studio', '.special-workspace'].includes(selector) ? root : nodes[selector] || null,
    addEventListener(name, fn) { events.set('document:' + name, fn); } };
  globalThis.window = { addEventListener(name, fn) { events.set(name, fn); } };
  globalThis.location = { origin: 'https://workspace.example' };
  globalThis.workspaceUser = { id: 'account-a' };
  globalThis.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  globalThis.indexedDB = { open(name) {
    const opening = {};
    queueMicrotask(() => {
      opening.result = { transaction() {
        const tx = { objectStore: () => ({ get: () => ({ result: databases.get(name) }),
          put: value => { databases.set(name, value); return {}; }, delete: () => { databases.delete(name); return {}; } }) };
        queueMicrotask(() => tx.oncomplete());
        return tx;
      } };
      opening.onsuccess();
    });
    return opening;
  } };
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, ...options });
    if (url === '/api/mix/health') return Response.json(health);
    if (url === '/api/browser-materials/connect') return Response.json({ device_id: 'c'.repeat(32) });
    if (url.endsWith('/clips')) return Response.json({ clips: JSON.parse(options.body).clips.map(clip => ({ id: clip.id, state: 'indexed' })) });
    if (url.endsWith('/requests')) return Response.json({ requests: [] });
    if (url.endsWith('/heartbeat')) return Response.json({});
    if (url.startsWith('/api/mix/jobs')) return fetchJob ? fetchJob(url, options, calls) : Response.json(url === '/api/mix/jobs' ? { jobs: [] } : { id, state: 'completed', video_url: `/api/mix/jobs/${id}/video` });
    throw new Error('unexpected browser request ' + url);
  };
  const mod = await import(useShared ? '../design/mix-materials.js' : `../design/mix-materials.js?fixture=${Math.random()}`).catch(() => ({}));
  const ctx = { mode: 'mix', configs: { mix: { prompt: '用完整宣传文案匹配真实素材。', ratio: '9:16', quality: '1080p', subtitles: true, music: true, count: '3', duration: '30', files: [] } },
    esc: value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    icon: () => '', button: (action, text, cls = '', extra = '') => `<button class="${cls}" data-action="${action}" ${extra}>${text}</button>`,
    storeInfo: {}, modules: { mix: { names: [['日常混剪']] } }, assets: [], refresh() {}, toast() {} };
  return { mod, ctx, calls, nodes, root, events, storage, databases, restore() { mod.stopMixMaterials?.(); Object.assign(globalThis, original); } };
}

test('finished video and download paths accept only whitelisted same-origin job artifacts', async () => {
  const { safeMixArtifactUrl = () => '' } = await import('../design/mix-materials.js').catch(() => ({}));
  const good = `/api/mix/jobs/${id}/video`;
  assert.equal(safeMixArtifactUrl(good, 'https://workspace.example'), good);
  for (const bad of ['javascript:alert(1)', '//evil.example' + good, 'https://evil.example' + good, good + '?token=x', good + '#x', good.replace('/video', '/files'), good.replace(id, 'x'), good.replace('/video', '/a/../video'), good.replace('/video', '/%76ideo')]) assert.equal(safeMixArtifactUrl(bad, 'https://workspace.example'), '');
});

test('mix studio keeps its columns and labels the submitted text as promotional copy', async () => {
  const f = await fixture();
  try {
    const html = renderStudio('mix', f.ctx);
    assert.match(html, /studio-materials/);
    assert.match(html, /studio-preview/);
    assert.match(html, /studio-inspector/);
    assert.match(html, /studio-script-field">宣传文案/);
    assert.match(html, /data-action="mix-choose-folder"/);
    assert.match(html, /mix-material-status/);
    assert.match(html, /文案与配音自动确定/);
    assert.doesNotMatch(html, /最多 30 段/);
    assert.doesNotMatch(html, /data-studio-field="count"|data-studio-field="duration"|data-studio-field="music"/);
  } finally { f.restore(); }
});

test('completed render updates preview panels without replacing the copy editor', async () => {
  const f = await fixture({ useShared: true, fetchJob: async (url, options) => Response.json(options.method === 'POST'
    ? { id, state: 'done', video_url: `/api/mix/jobs/${id}/video` }
    : { jobs: [] }) });
  let fullRefreshes = 0;
  f.ctx.refresh = () => { fullRefreshes++; };
  f.nodes['.mix-preview'] = { outerHTML: '' };
  f.nodes['.studio-timeline'] = { outerHTML: '' };
  try {
    bindStudio('mix', f.ctx);
    await f.mod.initializeMixMaterials({ ...f.ctx, refreshMixPanels: undefined });
    assert.equal(fullRefreshes, 0);
    const before = fullRefreshes;
    const input = f.nodes['#studio-prompt'];
    input.input({ target: { value: '完整且真实的宣传文案。' } });
    f.mod.handleMixMaterialAction('studio-generate', { dataset: {} }, { ...f.ctx, refreshMixPanels: undefined });
    await settle(() => f.mod.getMixState().job?.state === 'done');
    assert.equal(fullRefreshes, before);
    assert.equal(f.nodes['#studio-prompt'], input);
    assert.match(f.nodes['.mix-preview'].outerHTML, new RegExp(`/api/mix/jobs/${id}/video`));
    assert.match(f.nodes['.mix-preview'].outerHTML, /下载成片/);
    assert.match(f.nodes['.studio-timeline'].outerHTML, /制作记录/);
    assert.equal(f.ctx.configs.mix.prompt, '完整且真实的宣传文案。');
  } finally { f.restore(); }
});

test('recursive restoration indexes every file while displaying a small catalog and footer status', async () => {
  const f = await fixture({ files: 36 });
  try {
    assert.equal(typeof f.mod.initializeMixMaterials, 'function');
    await f.mod.initializeMixMaterials(f.ctx);
    await settle(() => f.mod.getMixState().status.indexed === 36 && f.mod.getMixState().media.length === 30);
    const state = f.mod.getMixState();
    assert.equal(state.fileCount, 36);
    assert.equal(state.status.connected, true);
    assert.equal(Object.keys(f.databases.get('workbench-browser-materials:account-a').manifest).length, 36);
    assert.match(f.mod.renderMixMaterials(f.ctx), /mix-material-status/);
    assert.match(f.nodes['#mix-material-status'].innerHTML, /36/);
    assert.equal(f.nodes['[data-action="studio-generate"]'].disabled, false);
  } finally { f.restore(); }
});

test('saved jobs resume polling without submitting another render request', async () => {
  const f = await fixture({ pending: { id } });
  try {
    assert.equal(typeof f.mod.initializeMixMaterials, 'function');
    await f.mod.initializeMixMaterials(f.ctx);
    await settle(() => f.mod.getMixState().job?.state === 'completed');
    assert.ok(f.calls.some(call => call.url === '/api/mix/jobs/' + id));
    assert.equal(f.calls.some(call => call.method === 'POST' && call.url === '/api/mix/jobs'), false);
    assert.equal(f.mod.getMixState().view, 'result');
  } finally { f.restore(); }
});

test('source engine done and interrupted states stop polling and enable a new job', async () => {
  const f = await fixture({ pending: { id }, fetchJob: async url => Response.json(url === '/api/mix/jobs'
    ? { jobs: [] } : { id, state: 'done', video_url: `/api/mix/jobs/${id}/video` }) });
  try {
    await f.mod.initializeMixMaterials(f.ctx);
    assert.equal(f.mod.getMixState().view, 'result');
    assert.equal(f.mod.mixReadiness(f.ctx), '');
    assert.equal(f.mod.getMixState().timer, null);
  } finally { f.restore(); }
});

test('resume continues the saved job once without a new creation request or idempotency key', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const f = await fixture({ pending: { id }, fetchJob: async url => url.endsWith('/resume') ? pending
    : Response.json(url === '/api/mix/jobs' ? { jobs: [] } : { id, state: 'interrupted', error: '连接中断' }) });
  try {
    await f.mod.initializeMixMaterials(f.ctx);
    assert.match(f.mod.renderMixMaterials(f.ctx), /data-action="mix-resume-job"/);
    f.mod.handleMixMaterialAction('mix-resume-job', { dataset: {} }, f.ctx);
    f.mod.handleMixMaterialAction('mix-resume-job', { dataset: {} }, f.ctx);
    await settle(() => f.calls.some(call => call.url.endsWith('/resume')));
    const posts = f.calls.filter(call => call.method === 'POST' && call.url.startsWith('/api/mix/jobs'));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, `/api/mix/jobs/${id}/resume`);
    assert.equal(posts[0].headers['Idempotency-Key'], undefined);
    assert.equal(posts[0].body, '{}');
    release(Response.json({ id, state: 'queued' }));
    await settle(() => !f.mod.getMixState().busy && f.mod.getMixState().job.state === 'queued');
    assert.deepEqual(JSON.parse(f.storage.get('mix-active-job:account-a')), { id });
  } finally { release?.(Response.json({ id, state: 'queued' })); f.restore(); }
});

test('resume rejection exposes server detail and late account responses cannot restore the old job', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let attempt = 0;
  const f = await fixture({ pending: { id }, fetchJob: async url => url.endsWith('/resume')
    ? ++attempt === 1 ? Response.json({ detail: '请重新连接原素材文件夹' }, { status: 400 }) : pending
    : Response.json(url === '/api/mix/jobs' ? { jobs: [] } : { id, state: 'failed' }) });
  try {
    await f.mod.initializeMixMaterials(f.ctx);
    f.mod.handleMixMaterialAction('mix-resume-job', { dataset: {} }, f.ctx);
    await settle(() => f.mod.getMixState().error === '请重新连接原素材文件夹');
    assert.deepEqual(JSON.parse(f.storage.get('mix-active-job:account-a')), { id });
    f.mod.handleMixMaterialAction('mix-resume-job', { dataset: {} }, f.ctx);
    await settle(() => attempt === 2);
    globalThis.workspaceUser = { id: 'account-b' };
    release(Response.json({ id, state: 'queued' }));
    await settle(() => f.mod.getMixState().job === null);
    assert.equal(f.storage.has('mix-active-job:account-b'), false);
    assert.equal(f.calls.some(call => call.url === '/api/mix/jobs' && call.method === 'POST'), false);
  } finally { release?.(Response.json({ id, state: 'queued' })); f.restore(); }
});

test('running jobs block folder replacement and disconnect while allowing a permission reconnect', async () => {
  const f = await fixture({ pending: { id }, fetchJob: async url => Response.json(url === '/api/mix/jobs'
    ? { jobs: [] } : { id, state: 'waiting_materials' }) });
  try {
    await f.mod.initializeMixMaterials(f.ctx);
    let chooses = 0, disconnects = 0;
    f.mod.getMixState().client.choose = async options => { chooses++; assert.equal(options.reconnectOnly, true); };
    f.mod.getMixState().client.disconnect = async () => { disconnects++; };
    f.mod.handleMixMaterialAction('mix-choose-folder', { dataset: {} }, f.ctx);
    f.mod.handleMixMaterialAction('mix-disconnect', { dataset: {} }, f.ctx);
    assert.equal(chooses, 0);
    assert.equal(disconnects, 0);
    f.mod.getMixState().status.connected = false;
    f.mod.getMixState().status.needsPermission = true;
    f.mod.handleMixMaterialAction('mix-choose-folder', { dataset: {} }, f.ctx);
    assert.equal(chooses, 1);
  } finally { f.restore(); }
});

test('lost permission or locally unreadable old vectors never enable generation', async () => {
  const f = await fixture();
  try {
    await f.mod.initializeMixMaterials(f.ctx);
    const state = f.mod.getMixState();
    state.client.record.handle.values = async function* () { throw Object.assign(new Error('directory permission expired'), { name: 'NotAllowedError' }); };
    await state.client.scan();
    f.mod.bindMixMaterials(f.ctx);
    assert.match(f.mod.mixReadiness(f.ctx), /重新连接/);
    assert.match(f.mod.renderMixMaterials(f.ctx), /mix-choose-folder"[^>]*>重新连接/);
    assert.equal(f.nodes['[data-action="studio-generate"]'].disabled, true);
    state.client.record.handle.values = async function* () {
      yield { name: 'sub', kind: 'directory', async *values() {
        yield { name: 'video-0.mp4', kind: 'file', getFile: async () => { throw Object.assign(new Error('file no longer readable'), { name: 'NotReadableError' }); } };
      } };
    };
    await state.client.scan();
    assert.equal(state.status.needsPermission, false);
    f.mod.bindMixMaterials(f.ctx);
    assert.match(f.mod.mixReadiness(f.ctx), /读取|扫描/);
    assert.equal(f.nodes['[data-action="studio-generate"]'].disabled, true);
    assert.equal(state.status.indexed, 1);
    assert.equal(Object.keys(state.client.record.manifest).length, 1);
  } finally { f.restore(); }
});

test('opening old history cannot unlock or revoke a running task directory', async () => {
  const oldId = 'b'.repeat(32);
  const f = await fixture({ pending: { id }, fetchJob: async url => Response.json(url === '/api/mix/jobs'
    ? { jobs: [{ id, state: 'running' }, { id: oldId, state: 'done' }] }
    : { id, state: 'running' }) });
  try {
    await f.mod.initializeMixMaterials(f.ctx);
    f.mod.handleMixMaterialAction('mix-open-job', { dataset: { id: oldId } }, f.ctx);
    assert.equal(f.mod.getMixState().job.id, id);
    assert.equal(f.mod.mixFolderLocked(), true);
    f.mod.handleMixMaterialAction('mix-disconnect', { dataset: {} }, f.ctx);
    assert.equal(f.calls.some(call => call.method === 'DELETE'), false);
    assert.equal(f.mod.getMixState().status.connected, true);
  } finally { f.restore(); }
});

test('metadata rescan blocks generation until its guarded completion updates the button', async () => {
  const f = await fixture();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  try {
    await f.mod.initializeMixMaterials(f.ctx);
    const state = f.mod.getMixState();
    const changed = new Blob(['changed original video']);
    Object.defineProperties(changed, { name: { value: 'video-0.mp4' }, lastModified: { value: 2 } });
    state.client.record.handle.values = async function* () {
      yield { name: 'sub', kind: 'directory', async *values() {
        yield { name: changed.name, kind: 'file', getFile: async () => changed };
      } };
    };
    state.client.readDuration = () => pending;
    f.mod.handleMixMaterialAction('mix-scan', { dataset: {} }, f.ctx);
    await settle(() => state.client.scanning);
    assert.match(f.mod.mixReadiness(f.ctx), /扫描/);
    assert.equal(f.nodes['[data-action="studio-generate"]'].disabled, true);
    release(2);
    await settle(() => !state.client.scanning);
    await settle(() => !f.nodes['[data-action="studio-generate"]'].disabled);
    assert.equal(f.mod.mixReadiness(f.ctx), '');
  } finally { release?.(2); f.restore(); }
});

test('lost submission response retains one key and retries the same text and options', async () => {
  let submissions = 0;
  const f = await fixture({ fetchJob: async (url, options) => {
    if (options.method === 'POST') {
      submissions++;
      if (submissions === 1) throw new Error('lost acknowledgement');
      return Response.json({ id, state: 'rendering' });
    }
    return Response.json(url === '/api/mix/jobs' ? { jobs: [] } : { id, state: 'completed', video_url: `/api/mix/jobs/${id}/video` });
  } });
  try {
    assert.equal(typeof f.mod.initializeMixMaterials, 'function');
    await f.mod.initializeMixMaterials(f.ctx);
    await settle(() => f.mod.getMixState().status.indexed === 1);
    f.mod.handleMixMaterialAction('studio-generate', { dataset: {} }, f.ctx);
    f.mod.handleMixMaterialAction('studio-generate', { dataset: {} }, f.ctx);
    await settle(() => f.mod.getMixState().error.includes('lost acknowledgement'));
    const saved = JSON.parse(f.storage.get('mix-active-job:account-a'));
    assert.ok(saved.key);
    f.ctx.configs.mix.prompt = 'Changed after lost response';
    f.mod.handleMixMaterialAction('mix-retry-submit', { dataset: {} }, f.ctx);
    await settle(() => submissions === 2 && f.mod.getMixState().job?.id === id);
    const posts = f.calls.filter(call => call.url === '/api/mix/jobs' && call.method === 'POST');
    assert.equal(posts[0].headers['Idempotency-Key'], posts[1].headers['Idempotency-Key']);
    assert.equal(posts[0].body, posts[1].body);
    const payload = JSON.parse(posts[0].body);
    assert.equal(payload.text, '用完整宣传文案匹配真实素材。');
    assert.equal(payload.music, false);
    assert.equal(payload.count, 1);
    assert.equal(payload.duration, null);
    assert.equal(posts[0].credentials, 'same-origin');
  } finally { f.restore(); }
});

test('account change discards late health and task responses and old local previews', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const f = await fixture({ fetchJob: () => pending });
  try {
    assert.equal(typeof f.mod.initializeMixMaterials, 'function');
    const restoring = f.mod.initializeMixMaterials(f.ctx);
    await settle(() => f.calls.some(call => call.url === '/api/mix/jobs'));
    globalThis.workspaceUser = { id: 'account-b' };
    release(Response.json({ jobs: [{ id, state: 'completed', video_url: `/api/mix/jobs/${id}/video` }] }));
    await restoring;
    const state = f.mod.getMixState();
    assert.equal(state.job, null);
    assert.equal(state.media.length, 0);
    assert.equal(state.status.connected, false);
    assert.equal(f.storage.has('mix-active-job:account-b'), false);
  } finally { f.restore(); }
});

test('indexing can restore before TTS is configured and BFCache pageshow reconnects', async () => {
  const f = await fixture({ health: { browser_materials: true, configured: false, indexing_configured: true, missing: ['MIX_TTS_VOICE_ID'] } });
  try {
    assert.equal(typeof f.mod.initializeMixMaterials, 'function');
    await f.mod.initializeMixMaterials(f.ctx);
    await settle(() => f.mod.getMixState().status.indexed === 1);
    assert.equal(f.nodes['[data-action="studio-generate"]'].disabled, true);
    assert.match(f.nodes['#mix-material-status'].innerHTML, /MIX_TTS_VOICE_ID/);
    f.events.get('pagehide')();
    assert.equal(f.mod.getMixState().status.connected, false);
    f.events.get('pageshow')({ persisted: true });
    await settle(() => f.mod.getMixState().status.connected);
  } finally { f.restore(); }
});
