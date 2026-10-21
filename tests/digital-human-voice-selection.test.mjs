import test from 'node:test';
import assert from 'node:assert/strict';

const defaultVoice = { id: 'default_speaker_1', name: '默认推荐音色', isDefault: true, audioUrl: '/api/voices/default_speaker_1/audio' };
const uploadedVoice = { id: 'uploaded', name: '新上传声音', audioUrl: '/api/voices/uploaded/audio' };

async function loadPage({ voices = [uploadedVoice, defaultVoice], saved = {}, selectEngine, inspect } = {}) {
  const originals = Object.fromEntries(['document', 'window', 'localStorage', 'fetch'].map(key => [key, globalThis[key]]));
  const storage = new Map([['store-studio:digital-human:v1', JSON.stringify(saved)]]);
  const regions = new Map();
  const node = () => ({ innerHTML: '', children: [], setAttribute() {}, querySelector: () => ({ textContent: '' }) });
  const listeners = {};
  const root = { isConnected: true, addEventListener(event, callback) { listeners[event] = callback; }, querySelector(selector) {
    if (!regions.has(selector)) regions.set(selector, node());
    return regions.get(selector);
  } };
  globalThis.document = { querySelector: () => root };
  globalThis.window = {};
  globalThis.localStorage = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) };
  globalThis.fetch = async url => {
    if (url === '/api/session') return Response.json({ data: { user: { id: 'test' } } });
    if (url === '/api/digital-human/status') return Response.json({ ready: true, engines: [{ id: 'b', label: 'qy-标准', available: true }, { id: 'd', label: 'qy-旗舰', available: true }, { id: 'e', label: 'qy-至臻', available: true }] });
    if (url === '/api/voices') return Response.json({ voices });
    if (String(url).startsWith('/api/digital-human/library')) return Response.json({ items: [], counts: {}, hasMore: false });
    throw new Error('Unexpected request: ' + url);
  };
  const mod = await import(`../design/digital-human.js?voice-test=${Math.random()}`);
  const ctx = { configs: { avatar: { prompt: '口播测试' } }, storeInfo: {}, esc: value => String(value ?? ''), icon: () => '', button: () => '' };
  try {
    mod.renderDigitalHuman(ctx);
    mod.bindDigitalHuman(ctx);
    for (let n = 0; n < 100 && !regions.get('#dh-voice')?.innerHTML.includes('新上传声音'); n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.match(regions.get('#dh-voice')?.innerHTML || '', /新上传声音/, 'voice list must finish loading');
    if (selectEngine) listeners.change({ target: { dataset: { dhOption: 'engine' }, value: selectEngine } });
    const markup = mod.renderDigitalHuman(ctx);
    assert.ok(markup.indexOf('id="dh-engine"') < markup.indexOf('<details class="dh-advanced">'), 'model choices are visible without expanding advanced settings');
    assert.doesNotMatch(markup.match(/<details class="dh-advanced">[\s\S]*?<\/details>/)[0], /data-dh-option="engine"/);
    for (const label of ['qy-标准', 'qy-旗舰', 'qy-至臻']) assert.ok(markup.includes(label));
    const engineSelect = markup.match(/<select id="dh-engine-select"[\s\S]*?<\/select>/)?.[0];
    assert.ok(engineSelect, 'model choices use a dropdown');
    assert.equal((engineSelect.match(/<option /g) || []).length, 3);
    inspect?.({ regions, listeners, ctx, render: () => mod.renderDigitalHuman(ctx) });
    return JSON.parse(storage.get('store-studio:digital-human:v1'));
  } finally {
    mod.disposeDigitalHuman();
    Object.assign(globalThis, originals);
  }
}

test('first load selects the default voice even when uploaded voices precede it', async () => {
  assert.equal((await loadPage()).voiceId, defaultVoice.id);
});

test('Malaysian generation prices follow engine, script duration and speaking speed', async () => {
  await loadPage({ inspect: ({ regions, listeners, ctx, render }) => {
    ctx.configs.avatar.prompt = '字'.repeat(344);
    assert.match(render(), /约 86 秒 · 预计 1763 积分（RM 8.6）/);
    for (const [engine, text] of [
      ['d', '约 86 秒 · 预计 2116 积分（RM 10.32）'],
      ['e', '约 86 秒 · 预计 17630 积分（RM 86）'],
      ['b', '约 86 秒 · 预计 1763 积分（RM 8.6）'],
    ]) {
      listeners.change({ target: { dataset: { dhOption: 'engine' }, value: engine } });
      assert.equal(regions.get('#dh-credit-estimate').textContent, text);
    }
    listeners.change({ target: { dataset: { dhOption: 'toneProfile' }, value: 'high' } });
    assert.equal(regions.get('#dh-credit-estimate').textContent, '约 72 秒 · 预计 1476 积分（RM 7.2）');
    ctx.configs.avatar.prompt = '';
    assert.match(render(), /id="dh-credit-estimate"[^>]*>RM 0.1\/秒 · 约 20.5 积分\/秒<\/p>/);
  } });
});

test('new drafts use the upstream emotion intensity while saved choices are retained', async () => {
  assert.equal((await loadPage()).emotionIntensity, 0.8);
  assert.equal((await loadPage({ saved: { emotionIntensity: 0.35, emotionReferenceVersion: 1 } })).emotionIntensity, 0.35);
});

test('legacy drafts adopt the reference emotion without losing script or selected voice', async () => {
  const result = await loadPage({ saved: { emotionIntensity: 0.5, voiceId: uploadedVoice.id } });
  assert.equal(result.emotionIntensity, 0.8);
  assert.equal(result.emotionReferenceVersion, 1);
  assert.equal(result.voiceId, uploadedVoice.id);
  assert.equal(result.script, '口播测试');
});

test('a saved user voice selection is retained', async () => {
  assert.equal((await loadPage({ saved: { voiceId: uploadedVoice.id } })).voiceId, uploadedVoice.id);
});

test('the standard engine is the default, and all active model choices survive selection and reload', async () => {
  assert.equal((await loadPage()).engine, 'b');
  for (const engine of ['b', 'd', 'e']) {
    const saved = await loadPage({ selectEngine: engine });
    assert.equal(saved.engine, engine);
    assert.equal((await loadPage({ saved })).engine, engine);
  }
});

test('retired A and C drafts switch to the standard engine', async () => {
  for (const engine of ['a', 'c']) assert.equal((await loadPage({ saved: { engine } })).engine, 'b');
});

test('an unavailable saved voice falls back to the configured default', async () => {
  assert.equal((await loadPage({ saved: { voiceId: 'deleted' } })).voiceId, defaultVoice.id);
});

test('an unconfigured default does not prevent choosing an available uploaded voice', async () => {
  assert.equal((await loadPage({ voices: [{ ...defaultVoice, audioUrl: '' }, uploadedVoice] })).voiceId, uploadedVoice.id);
});
