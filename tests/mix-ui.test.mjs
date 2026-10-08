import test from 'node:test';
import assert from 'node:assert/strict';
import BrowserMaterials from '../design/browser-materials.js';
import { renderStudio, bindStudio } from '../design/studios.js';

const id = 'a'.repeat(32);
const settle = async predicate => {
  for (let count = 0; count < 100 && !predicate(); count++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'browser UI did not finish expected work');
};

async function fixture({ files = 1, fetchJob, fetchAudio, fetchHealth, xhr, pending, useShared = false, health = { browser_materials: true, configured: true, indexing_configured: true, missing: [], voice_configured: true, default_voice_configured: true } } = {}) {
  const original = Object.fromEntries(['workspaceUser', 'document', 'window', 'location', 'indexedDB', 'localStorage', 'fetch', 'XMLHttpRequest'].map(key => [key, globalThis[key]]));
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
  if (xhr) globalThis.XMLHttpRequest = xhr;
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
    if (url === '/api/mix/health') return fetchHealth ? fetchHealth() : Response.json(health);
    if (url.startsWith('/api/mix/audio')) return fetchAudio ? fetchAudio(url, options, calls) : Response.json({ configured: true, missing: [], items: [] });
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

test('folder selection stays in the main upload area without an idle footer upload card', async () => {
  const f = await fixture({ useShared: true, files: 0, health: { configured: false, missing: ['RERANK_API_KEY'] } });
  try {
    f.databases.clear();
    await f.mod.initializeMixMaterials(f.ctx);
    const html = renderStudio('mix', f.ctx);
    const materials = html.slice(html.indexOf('<section class="studio-materials"'), html.indexOf('<section class="studio-preview'));
    assert.match(materials, /studio-add-material[^>]*>.*选择本地素材文件夹/);
    assert.doesNotMatch(f.mod.renderMixMaterials(f.ctx), /data-action="mix-choose-folder"|本地素材文件夹|RERANK_API_KEY|原视频保留/);
    assert.ok(materials.indexOf('mix-material-status') < materials.indexOf('studio-material-empty'));
  } finally { f.restore(); }
});

test('material preparation shows upload copy and actual progress through scanning, indexing and transfer', async () => {
  const f = await fixture({ files: 2 });
  try {
    await f.mod.initializeMixMaterials(f.ctx);
    const state = f.mod.getMixState();
    const clips = Object.values(state.client.record.manifest).flatMap(entry => entry.clips);
    clips[1].state = 'pending';
    state.client.scanning = true;
    state.client._report({ text: '正在向量化素材' });
    assert.match(f.nodes['#mix-material-status'].innerHTML, /素材正在上传/);
    assert.match(f.nodes['#mix-material-status'].innerHTML, /<progress aria-label="素材上传进度"><\/progress>/);
    state.client.scanning = false;
    state.client._report();
    assert.match(f.nodes['#mix-material-status'].innerHTML, /max="2" value="1"/);
    assert.doesNotMatch(f.nodes['#mix-material-status'].innerHTML, /向量化|索引|并行|AI 分析|data-action=/);
    assert.equal(f.nodes['#studio-generation-hint'].textContent.includes('索引'), false);
    state.client._report({ uploadTotal: 100, uploadBytes: 25 });
    assert.match(f.nodes['#mix-material-status'].innerHTML, /max="100" value="25"/);
    clips[1].state = 'indexed';
    state.client._report();
    assert.match(f.nodes['#mix-material-status'].innerHTML, /素材正在上传/);
    assert.match(f.nodes['#mix-material-status'].innerHTML, /max="100" value="25"/);
    state.client._report({ uploadTotal: 0, uploadBytes: 0 });
    assert.match(f.nodes['#mix-material-status'].innerHTML, /素材上传完成/);
    assert.match(f.nodes['#mix-material-status'].innerHTML, /max="2" value="2"/);
  } finally { f.restore(); }
});

test('queued and running video repairs remain in the upload progress until their files are ready', async () => {
  const f = await fixture();
  try {
    await f.mod.initializeMixMaterials(f.ctx);
    const { client } = f.mod.getMixState();
    client._schedule = () => {};
    clearTimeout(client.timer);
    const file = new Blob(['broken video']);
    Object.defineProperties(file, { name: { value: 'bad.mov' }, lastModified: { value: 1 } });
    client._queueRepair('bad.mov', file);
    client._report({ scanned: 2, error: 'bad.mov：等待处理' });
    let html = f.nodes['#mix-material-status'].innerHTML;
    assert.match(html, /素材正在上传/);
    assert.match(html, /max="2" value="1"/);
    assert.doesNotMatch(html, /素材上传完成/);
    assert.match(html, /data-action="mix-scan"[^>]*>重试未完成素材/);
    assert.doesNotMatch(html, /data-action="mix-disconnect"/);
    client.repairs.get('bad.mov').attempted = true;
    client.workers.set('repair:bad.mov', Promise.resolve());
    client._report();
    assert.match(f.nodes['#mix-material-status'].innerHTML, /素材正在上传/);
    client.workers.clear();
    client.repairs.get('bad.mov').failed = true;
    client.attempts.set('repair:bad.mov', 4);
    client._report({ error: 'bad.mov：视频无法转换' });
    html = f.nodes['#mix-material-status'].innerHTML;
    assert.doesNotMatch(html, /素材上传完成|素材正在上传/);
    assert.match(html, /data-action="mix-scan"[^>]*>重试未完成素材/);
  } finally { f.restore(); }
});

test('an exhausted analysis failure exposes a retry action instead of an endless upload', async () => {
  const f = await fixture();
  try {
    await f.mod.initializeMixMaterials(f.ctx);
    const { client } = f.mod.getMixState();
    client._schedule = () => {};
    clearTimeout(client.timer);
    const clip = Object.values(client.record.manifest)[0].clips[0];
    clip.state = 'error';
    client.attempts.set(clip.id, 4);
    client.retryAfter.set('clip:' + clip.id, Date.now() + 60000);
    client._report({ error: 'video-0.mp4：不支持的视频' });
    const html = f.nodes['#mix-material-status'].innerHTML;
    assert.doesNotMatch(html, /素材正在上传|素材上传完成/);
    assert.match(html, /data-action="mix-scan"[^>]*>重试未完成素材/);
  } finally { f.restore(); }
});

test('manual retry is available during automatic retry backoff and reuses completed materials', async () => {
  const f = await fixture({ files: 2 });
  try {
    await f.mod.initializeMixMaterials(f.ctx);
    const { client } = f.mod.getMixState();
    client._schedule = () => {};
    clearTimeout(client.timer);
    const clips = Object.values(client.record.manifest).flatMap(entry => entry.clips);
    const failed = clips[1];
    failed.state = 'error';
    client.attempts.set(failed.id, 2);
    client.retryAfter.set('clip:' + failed.id, Date.now() + 60000);
    client._report({ error: 'video-1.mp4：接口暂时不可用' });
    assert.equal(client.status.processing, true);
    const html = f.nodes['#mix-material-status'].innerHTML;
    assert.match(html, /素材正在上传/);
    assert.match(html, /data-action="mix-scan"[^>]*>重试未完成素材/);
    assert.doesNotMatch(html, /data-action="mix-disconnect"/);
    const analyzed = [], originalFetch = globalThis.fetch;
    client.sampleFrames = async () => ['frame'];
    globalThis.fetch = async (path, options) => {
      if (path.endsWith('/clips')) return Response.json({ clips: JSON.parse(options.body).clips.map(clip => ({
        id: clip.id, state: clip.id === failed.id ? 'pending' : 'indexed',
      })) });
      if (path.endsWith('/analyze')) { analyzed.push(JSON.parse(options.body).clip_id); return Response.json({ complete: true }); }
      return originalFetch(path, options);
    };
    f.mod.handleMixMaterialAction('mix-scan', { dataset: {} }, f.ctx);
    await settle(() => !client.scanning && failed.state === 'pending');
    assert.equal(client.retryAfter.has('clip:' + failed.id), false);
    await client._cycle(client.generation);
    await Promise.all(client.workers.values());
    assert.deepEqual(analyzed, [failed.id]);
    assert.equal(client.status.readyFiles, 2);
    assert.equal(client.status.error, '');
  } finally { f.restore(); }
});

test('HTML gateway failures preserve their HTTP status for automatic material retries', async () => {
  const f = await fixture();
  try {
    await f.mod.initializeMixMaterials(f.ctx);
    const { client } = f.mod.getMixState();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (path, options) => path.endsWith('/analyze') ?
      new Response('<!DOCTYPE html><html>Bad gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } }) : originalFetch(path, options);
    await assert.rejects(client._post(client._devicePath('/analyze'), {}, client.generation), error => {
      assert.equal(error.status, 502);
      assert.doesNotMatch(error.message, /Unexpected token|DOCTYPE/);
      return true;
    });
  } finally { f.restore(); }
});

test('an analysis request timeout remains retryable while the material connection is active', async () => {
  const f = await fixture();
  const originalTimeout = globalThis.setTimeout;
  let expire;
  try {
    await f.mod.initializeMixMaterials(f.ctx);
    const { client } = f.mod.getMixState();
    globalThis.setTimeout = (callback, delay, ...args) => {
      if (delay === 600000) { expire = callback; return originalTimeout(() => {}, delay); }
      return originalTimeout(callback, delay, ...args);
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (path, options) => path.endsWith('/analyze') ? new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('request timed out', 'AbortError')), { once: true });
    }) : originalFetch(path, options);
    const uploading = client._post(client._devicePath('/analyze'), {}, client.generation);
    expire();
    await assert.rejects(uploading, error => { assert.equal(error.status, 408); return true; });
    assert.equal(client.active, true);
  } finally { globalThis.setTimeout = originalTimeout; f.restore(); }
});

test('voice and music libraries remain in the inspector and escape audio names', async () => {
  const voice = 'd'.repeat(32), music = 'e'.repeat(32);
  const f = await fixture({ useShared: true, fetchAudio: async url => Response.json({ configured: true, missing: [], items: [{
    id: url.includes('kind=voice') ? voice : music, kind: url.includes('kind=voice') ? 'voice' : 'music',
    name: '<script>alert(1)</script>.mp3', duration: 15, bytes: 100,
    url: `/api/mix/audio/${url.includes('kind=voice') ? voice : music}/stream`,
  }] }) });
  try {
    await f.mod.initializeMixMaterials(f.ctx);
    f.ctx.configs.mix.voice_id = voice;
    f.ctx.configs.mix.music_id = music;
    const html = renderStudio('mix', f.ctx);
    assert.match(html, /合成人声/);
    assert.match(html, /保留素材原声/);
    assert.match(html, /音色库/);
    assert.match(html, /背景音乐库/);
    assert.match(html, new RegExp(`/api/mix/audio/${voice}/stream`));
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>|音乐暂未开放/);
  } finally { f.restore(); }
});

test('original audio generation needs neither TTS nor a default voice and sends chosen music ID', async () => {
  const music = 'e'.repeat(32);
  const f = await fixture({ health: { configured: true, indexing_configured: true, voice_configured: false, default_voice_configured: false, voice_missing: ['INDEXTTS_302_API_KEY'] },
    fetchAudio: async url => Response.json({ configured: true, missing: [], items: url.includes('kind=music') ? [{ id: music, kind: 'music', name: '音乐.mp3', url: `/api/mix/audio/${music}/stream` }] : [] }) });
  try {
    await f.mod.initializeMixMaterials(f.ctx);
    assert.match(f.mod.mixReadiness(f.ctx), /配音/);
    f.ctx.configs.mix.voice_mode = 'original';
    f.ctx.configs.mix.music_id = music;
    assert.equal(f.mod.mixReadiness(f.ctx), '');
    f.mod.handleMixMaterialAction('studio-generate', { dataset: {} }, f.ctx);
    await settle(() => f.calls.some(call => call.url === '/api/mix/jobs' && call.method === 'POST'));
    const body = JSON.parse(f.calls.find(call => call.url === '/api/mix/jobs' && call.method === 'POST').body);
    assert.equal(body.voice_mode, 'original');
    assert.equal(body.voice_id, null);
    assert.equal(body.music_id, music);
    assert.equal(body.music, true);
  } finally { f.restore(); }
});

test('uploaded voice removes the default-reference requirement, stale IDs cannot be submitted', async () => {
  const voice = 'd'.repeat(32);
  const f = await fixture({ health: { configured: true, indexing_configured: true, voice_configured: true, default_voice_configured: false },
    fetchAudio: async url => Response.json({ configured: true, missing: [], items: url.includes('kind=voice') ? [{ id: voice, kind: 'voice', name: '人声.wav', url: `/api/mix/audio/${voice}/stream` }] : [] }) });
  try {
    await f.mod.initializeMixMaterials(f.ctx);
    assert.match(f.mod.mixReadiness(f.ctx), /音色/);
    f.ctx.configs.mix.voice_id = voice;
    assert.equal(f.mod.mixReadiness(f.ctx), '');
    f.ctx.configs.mix.voice_id = 'f'.repeat(32);
    assert.match(f.mod.mixReadiness(f.ctx), /音色/);
    f.ctx.configs.mix.voice_id = voice;
    globalThis.workspaceUser = { id: 'account-b' };
    f.mod.getMixState();
    assert.equal(f.mod.getMixState().audio.voice.length, 0);
    assert.equal(f.ctx.configs.mix.voice_id, '');
  } finally { f.restore(); }
});

test('audio previews accept only own-site opaque-ID stream paths', async () => {
  const { safeMixAudioUrl = () => '' } = await import('../design/mix-materials.js');
  const good = `/api/mix/audio/${'d'.repeat(32)}/stream`;
  assert.equal(safeMixAudioUrl(good, 'https://workspace.example'), good);
  for (const bad of ['https://evil.example/a.wav', '//evil.example' + good, good + '?token=x', good.replace('/stream', '/%73tream'), 'javascript:alert(1)']) {
    assert.equal(safeMixAudioUrl(bad, 'https://workspace.example'), '');
  }
});

test('audio upload reports byte progress, selects the result and rejects repeated submission', async () => {
  const uploads = [];
  class Xhr {
    upload = {};
    headers = {};
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(key, value) { this.headers[key] = value; }
    send(file) { this.file = file; uploads.push(this); }
    abort() { this.onabort?.(); }
  }
  const f = await fixture({ xhr: Xhr });
  const file = new Blob(['audio']);
  Object.defineProperty(file, 'name', { value: '我的音色.wav' });
  try {
    await f.mod.initializeMixMaterials(f.ctx);
    assert.equal(typeof f.mod.uploadMixAudio, 'function');
    const uploading = f.mod.uploadMixAudio('voice', file, f.ctx);
    await settle(() => uploads.length === 1);
    await f.mod.uploadMixAudio('voice', file, f.ctx);
    assert.equal(uploads.length, 1);
    uploads[0].upload.onprogress({ lengthComputable: true, loaded: 3, total: 5 });
    assert.deepEqual(f.mod.getMixState().audio.progress, { loaded: 3, total: 5 });
    assert.match(uploads[0].url, /kind=voice/);
    assert.equal(uploads[0].file, file);
    const voice = 'd'.repeat(32);
    uploads[0].status = 200;
    uploads[0].responseText = JSON.stringify({ item: { id: voice, kind: 'voice', name: file.name, duration: 15, bytes: 100, url: `/api/mix/audio/${voice}/stream` } });
    uploads[0].onload();
    await uploading;
    assert.equal(f.ctx.configs.mix.voice_id, voice);
    assert.equal(f.mod.getMixState().audio.busy, false);
    assert.equal(f.mod.getMixState().audio.voice.length, 1);
  } finally { f.restore(); }
});

test('deletion conflicts keep the selected track and account changes abort pending audio uploads', async () => {
  const music = 'e'.repeat(32);
  const uploads = [];
  class Xhr {
    upload = {};
    open() {}
    setRequestHeader() {}
    send() { uploads.push(this); }
    abort() { this.aborted = true; this.onabort?.(); }
  }
  const f = await fixture({ xhr: Xhr, fetchAudio: async (url, options) => options.method === 'DELETE'
    ? Response.json({ detail: '音频正被混剪任务使用' }, { status: 409 })
    : Response.json({ configured: true, missing: [], items: url.includes('kind=music') ? [{ id: music, kind: 'music', name: '音乐.mp3', url: `/api/mix/audio/${music}/stream` }] : [] }) });
  try {
    await f.mod.initializeMixMaterials(f.ctx);
    f.ctx.configs.mix.music_id = music;
    f.mod.handleMixMaterialAction('mix-audio-delete', { dataset: { id: music, kind: 'music' } }, f.ctx);
    await settle(() => f.mod.getMixState().audio.error === '音频正被混剪任务使用');
    assert.equal(f.ctx.configs.mix.music_id, music);
    assert.equal(f.mod.getMixState().audio.music.length, 1);
    const file = new Blob(['audio']);
    Object.defineProperty(file, 'name', { value: '人声.wav' });
    const uploading = f.mod.uploadMixAudio('voice', file, f.ctx);
    await settle(() => uploads.length === 1);
    globalThis.workspaceUser = { id: 'account-b' };
    f.mod.getMixState();
    await uploading;
    assert.equal(uploads[0].aborted, true);
    assert.equal(f.mod.getMixState().audio.voice.length, 0);
    assert.equal(f.ctx.configs.mix.music_id, '');
  } finally { f.restore(); }
});

test('a failed audio-library load can be retried without refreshing the page', async () => {
  let failed = true;
  const f = await fixture({ fetchAudio: async () => {
    if (failed) throw new Error('音频库连接中断');
    return Response.json({ configured: true, missing: [], items: [] });
  } });
  try {
    await f.mod.initializeMixMaterials(f.ctx);
    assert.equal(f.mod.getMixState().audio.configured, null);
    assert.equal(f.mod.getMixState().audio.error, '音频库连接中断');
    assert.match(f.mod.renderMixAudio(f.ctx), /data-action="mix-audio-refresh"/);
    failed = false;
    f.mod.handleMixMaterialAction('mix-audio-refresh', { dataset: {} }, f.ctx);
    await settle(() => f.mod.getMixState().audio.configured === true);
    assert.equal(f.mod.getMixState().audio.error, '');
  } finally { f.restore(); }
});

test('an audio-library request timeout releases loading and permits a retry', async () => {
  let timedOut = true;
  const f = await fixture({ fetchAudio: async () => {
    if (timedOut) throw new DOMException('request timed out', 'AbortError');
    return Response.json({ configured: true, missing: [], items: [] });
  } });
  try {
    await f.mod.initializeMixMaterials(f.ctx);
    assert.equal(f.mod.getMixState().audio.loading, false);
    assert.match(f.mod.getMixState().audio.error, /超时/);
    timedOut = false;
    f.mod.handleMixMaterialAction('mix-audio-refresh', { dataset: {} }, f.ctx);
    await settle(() => f.mod.getMixState().audio.configured === true);
    assert.equal(f.mod.getMixState().audio.loading, false);
  } finally { f.restore(); }
});

test('typing copy only binds new audio controls and keeps the existing player', async () => {
  const f = await fixture();
  let replacements = 0, bindings = 0;
  const input = { dataset: { mixAudioField: 'voice_mode' }, addEventListener() { bindings++; } };
  const audioRoot = { set innerHTML(value) { replacements++; }, querySelectorAll: selector => selector === '[data-mix-audio-field]' ? [input] : [] };
  try {
    await f.mod.initializeMixMaterials(f.ctx);
    f.nodes['#mix-audio-settings'] = audioRoot;
    f.mod.bindMixMaterials(f.ctx);
    f.mod.bindMixMaterials(f.ctx);
    assert.equal(replacements, 0);
    assert.equal(bindings, 1);
  } finally { f.restore(); }
});

test('an account handoff after request validation cannot publish the old health response', async () => {
  let nextHealth, newAccountLoading, first = true;
  const waiting = new Promise(resolve => { nextHealth = resolve; });
  const f = await fixture({ fetchHealth: () => {
    if (!first) return waiting;
    first = false;
    return { ok: true, status: 200, json: async () => {
      queueMicrotask(() => queueMicrotask(() => {
        globalThis.workspaceUser = { id: 'account-b' };
        f.mod.stopMixMaterials();
        newAccountLoading = f.mod.initializeMixMaterials(f.ctx);
      }));
      return { configured: true, marker: 'old-account-a' };
    } };
  } });
  try {
    await f.mod.initializeMixMaterials(f.ctx);
    await settle(() => f.mod.getMixState().ownerKey === 'mix-active-job:account-b');
    assert.equal(f.mod.getMixState().health, null);
    nextHealth(Response.json({ configured: true, marker: 'new-account-b' }));
    await newAccountLoading;
    assert.equal(f.mod.getMixState().health.marker, 'new-account-b');
  } finally { nextHealth(Response.json({ configured: true })); f.restore(); }
});

test('audio uploads prevent resuming an interrupted job until upload completion', async () => {
  const uploads = [];
  class Xhr {
    upload = {};
    open() {}
    setRequestHeader() {}
    send() { uploads.push(this); }
    abort() { this.onabort?.(); }
  }
  const f = await fixture({ xhr: Xhr, pending: { id }, fetchJob: async url => Response.json(url === '/api/mix/jobs'
    ? { jobs: [] } : { id, state: url.endsWith('/resume') ? 'running' : 'interrupted' }) });
  try {
    await f.mod.initializeMixMaterials(f.ctx);
    const file = new Blob(['audio']);
    Object.defineProperty(file, 'name', { value: '人声.wav' });
    const uploading = f.mod.uploadMixAudio('voice', file, f.ctx);
    await settle(() => uploads.length === 1);
    f.mod.handleMixMaterialAction('mix-resume-job', { dataset: {} }, f.ctx);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.calls.some(call => call.url.endsWith('/resume')), false);
    assert.match(f.mod.renderMixMaterials(f.ctx), /disabled title="正在保存音频/);
    uploads[0].abort();
    await uploading;
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

test('recursive restoration indexes every file while displaying a small catalog and upload completion', async () => {
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
    assert.match(f.nodes['#mix-material-status'].innerHTML, /素材上传完成/);
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
    assert.match(f.mod.renderMixMaterials(f.ctx), /请点击上方按钮重新连接素材文件夹/);
    assert.doesNotMatch(f.mod.renderMixMaterials(f.ctx), /data-action="mix-choose-folder"/);
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
    assert.match(f.mod.mixReadiness(f.ctx), /素材正在上传/);
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
    assert.doesNotMatch(f.nodes['#mix-material-status'].innerHTML, /MIX_TTS_VOICE_ID/);
    assert.equal(f.nodes['#studio-generation-hint'].textContent, '生成服务尚未配置完成');
    f.events.get('pagehide')();
    assert.equal(f.mod.getMixState().status.connected, false);
    f.events.get('pageshow')({ persisted: true });
    await settle(() => f.mod.getMixState().status.connected);
  } finally { f.restore(); }
});
