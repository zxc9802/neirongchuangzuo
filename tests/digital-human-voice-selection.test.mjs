import test from 'node:test';
import assert from 'node:assert/strict';

const defaultVoice = { id: 'default_speaker_1', name: '默认推荐音色', isDefault: true, audioUrl: '/api/voices/default_speaker_1/audio' };
const uploadedVoice = { id: 'uploaded', name: '新上传声音', audioUrl: '/api/voices/uploaded/audio' };

async function loadPage({ voices = [uploadedVoice, defaultVoice], saved = {} } = {}) {
  const originals = Object.fromEntries(['document', 'window', 'localStorage', 'fetch'].map(key => [key, globalThis[key]]));
  const storage = new Map([['store-studio:digital-human:v1', JSON.stringify(saved)]]);
  const regions = new Map();
  const node = () => ({ innerHTML: '', children: [], setAttribute() {}, querySelector: () => ({ textContent: '' }) });
  const root = { isConnected: true, addEventListener() {}, querySelector(selector) {
    if (!regions.has(selector)) regions.set(selector, node());
    return regions.get(selector);
  } };
  globalThis.document = { querySelector: () => root };
  globalThis.window = {};
  globalThis.localStorage = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) };
  globalThis.fetch = async url => {
    if (url === '/api/session') return Response.json({ data: { user: { id: 'test' } } });
    if (url === '/api/digital-human/status') return Response.json({ ready: true, engines: [{ id: 'b', available: true }] });
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
    return JSON.parse(storage.get('store-studio:digital-human:v1'));
  } finally {
    mod.disposeDigitalHuman();
    Object.assign(globalThis, originals);
  }
}

test('first load selects the default voice even when uploaded voices precede it', async () => {
  assert.equal((await loadPage()).voiceId, defaultVoice.id);
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

test('an unavailable saved voice falls back to the configured default', async () => {
  assert.equal((await loadPage({ saved: { voiceId: 'deleted' } })).voiceId, defaultVoice.id);
});

test('an unconfigured default does not prevent choosing an available uploaded voice', async () => {
  assert.equal((await loadPage({ voices: [{ ...defaultVoice, audioUrl: '' }, uploadedVoice] })).voiceId, uploadedVoice.id);
});
