import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, readFile, realpath, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { createVideoHandler } from '../services/video/server.mjs';
import { createVideoProvider, generationBody, parseGeneration, videoConfig, PROMPT } from '../services/video/provider.mjs';
import { normalizePhoto, downloadVideo } from '../services/video/media.mjs';
import { alignmentSegments, speechTimeline, confirmSpeech } from '../services/video/speech.mjs';
import { createCreditsLedger } from '../services/credits/store.mjs';
import { createFalVideoProvider, FAL_MODEL } from '../services/video/fal.mjs';

const VIDEO = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(100)]);
const CONFIG = { enabled: true, publicOrigin: 'https://workspace.example', signingSecret: 'test-secret-not-for-production' };
const META = { duration: 4, width: 512, height: 768, audio: true };
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'video-replica-'));
  const wallet = createCreditsLedger({ storageDir: join(root, 'credits'), databaseUrl: null });
  await wallet.ready;
  const state = { creates: [], queries: 0, generations: 0, done: false, failed: false, review: 2, source: null };
  const provider = {
    async createMaterial(url, kind) { state.creates.push({ url, kind }); return { id: kind + '-id', status: state.review }; },
    async queryMaterial() { return state.review; },
    async generate(task) { state.generations++; state.body = generationBody(task); if (options.uncertain) throw new Error('Network disconnected'); return { taskId: 'provider-1' }; },
    async query() { state.queries++; if (options.query) return options.query(); return state.failed ? { failed: true } : state.done ? { url: 'https://cdn.example/result.mp4' } : {}; },
  };
  let app, handler, base;
  async function open(overrides = {}) {
    handler = createVideoHandler({ storageDir: join(root, 'video'), config: CONFIG, provider, credits: wallet,
      photo: async () => Buffer.from('photo'), probe: async () => META, download: async (_url, path) => writeFile(path, VIDEO),
      mute: async (_input, output) => writeFile(output, Buffer.from('silent-video')),
      pollIntervalMs: 15, ...options, ...overrides });
    await handler.ready;
    app = createServer((req, res) => { req.authenticatedUserId = req.headers['x-test-owner'] || 'alice'; void handler(req, res); });
    app.listen(0, '127.0.0.1'); await once(app, 'listening'); base = `http://127.0.0.1:${app.address().port}`;
  }
  async function close() { await handler.shutdown(); app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); }
  await open();
  t.after(async () => { await close(); await wallet.close(); await rm(root, { recursive: true, force: true }); });
  const call = (path, { body, method = body ? 'POST' : 'GET', owner = 'alice', headers = {} } = {}) => fetch(base + '/api/video-replica' + path, {
    method, headers: { 'x-test-owner': owner, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body && JSON.stringify(body) });
  async function init(id = randomUUID()) { const response = await call('/tasks', { body: { requestId: id } }); assert.equal(response.status, 201); return id; }
  async function upload(id) {
    for (const kind of ['video', 'photo']) {
      const response = await fetch(base + `/api/video-replica/tasks/${id}/${kind}`, { method: 'PUT', body: VIDEO });
      assert.equal(response.status, 200, await response.text());
    }
  }
  async function current(id) { return (await (await call(`/tasks/${id}`)).json()).task; }
  async function until(id, predicate) {
    for (let i = 0; i < 300; i++) { const task = await current(id); if (predicate(task)) return task; await delay(10); }
    assert.fail('Timed out: ' + JSON.stringify(await current(id)));
  }
  return { root, wallet, state, call, init, upload, current, until, close, open, get base() { return base; } };
}

test('Seedance 2.0 connection matches reference project and never returns credentials', async () => {
  const config = videoConfig({ VIDEO_API_BASE_URL: 'http://provider.example:19220', VIDEO_PROJECT_CODE: 'project', VIDEO_ACCESS_KEY: 'access', VIDEO_SECRET_KEY: 'secret', TEMP_ASSET_SIGNING_SECRET: 'sign' }, 'https://workspace.example');
  assert.equal(config.enabled, true);
  const requests = [];
  const provider = createVideoProvider(config, async (url, options) => {
    requests.push({ url: String(url), ...options, body: JSON.parse(options.body) });
    const path = new URL(url).pathname;
    return Response.json(path.endsWith('create') ? { success: true, data: { materialId: 'photo-id', status: 1 } }
      : path.endsWith('pageList') ? { success: true, data: { records: [{ materialId: 'wrong-id', status: 3 }, { materialId: 'photo-id', status: 2 }] } }
      : { success: true, data: { taskId: 'paid-id', status: 2, videoUrl: 'https://cdn.example/result.mp4' } });
  });
  assert.deepEqual(await provider.createMaterial('https://workspace.example/signed', 'photo'), { id: 'photo-id', status: 1 });
  await provider.createMaterial('https://workspace.example/signed-video', 'video');
  assert.equal(await provider.queryMaterial('photo-id'), 2);
  const task = { duration: 4, ratio: '9:16', materials: { photo: { id: 'photo-id' }, video: { id: 'video-id' } } };
  assert.equal((await provider.generate(task)).taskId, 'paid-id'); await provider.query('paid-id');
  assert.equal(requests[0].headers.projectCode, 'project'); assert.equal(requests[0].headers['X-Secret-Key'], 'secret');
  assert.equal(requests[0].body.type, 1); assert.equal(requests[0].body.fileType, 1); assert.equal(requests[1].body.fileType, 3);
  assert.equal(requests[3].body.modelId, 'doubao-seedance-2-0-260128');
  assert.equal(requests[3].body.prompt, PROMPT);
  assert.deepEqual(requests[3].body.payload, { params: { mode: 'fusion_video', resolution: '720p', scale: '9:16', duration: 4, generateAudio: true }, resources: ['asset://photo-id'], referVideoUrl: ['asset://video-id'] });
  assert.deepEqual(requests[4].body, { taskId: 'paid-id', abilityType: 'VIDEO' });
  assert.equal(parseGeneration({ data: { status: 3 } }).failed, true);
  assert.equal(parseGeneration({ data: { results: [{ video_url: 'https://cdn.example/clip.mp4' }] } }).url, 'https://cdn.example/clip.mp4');
  assert.equal(videoConfig({}).enabled, false);
});

const SPEECH = { engine: 'silero-vad+whisper-1', start: 1.25, end: 3.5, text: '你好世界',
  segments: [{ start: 1.25, end: 3.5, text: '你好世界', words: [{ word: '你好', start: 1.25, end: 2.2 }, { word: '世界', start: 2.2, end: 3.5 }] }] };
function fakeSpeech(overrides = {}) { return { enabled: true, detect: async () => [{ start: 0.2, end: 2.5 }],
  analyze: async () => SPEECH, align: async (_source, output) => { await writeFile(output, VIDEO); return { transcriptMatched: true }; }, ...overrides }; }
async function uploadVoice(app, id) {
  const response = await fetch(app.base + `/api/video-replica/tasks/${id}/voice`, { method: 'PUT', body: VIDEO });
  assert.equal(response.status, 200, await response.text());
}

test('voice reference requires analysis confirmation and reaches the provider as an audio material', async t => {
  const app = await fixture(t, { voice: async (_input, output) => { await writeFile(output, VIDEO); return { ready: true, duration: 3 }; }, speech: fakeSpeech() });
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id);
  assert.equal((await app.call(`/tasks/${id}/voice`, { owner: 'bob' })).status, 404);
  assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 409);
  assert.equal(app.state.generations, 0); assert.equal((await app.wallet.snapshot('alice')).held, 0);
  const analyzed = await app.call(`/tasks/${id}/analyze`, { body: {} });
  assert.equal(analyzed.status, 200); assert.equal((await analyzed.json()).task.speech.start, 1.25);
  assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 409);
  assert.equal((await app.call(`/tasks/${id}/start`, { body: { speechConfirmed: true } })).status, 202);
  await app.until(id, task => task.status === 'running');
  assert.deepEqual(app.state.body.payload.referAudioUrl, ['asset://voice-id']);
  assert.match(app.state.body.prompt, /1\.250 秒/); assert.match(app.state.body.prompt, /你好世界/);
  const signed = new URL(app.state.creates.find(item => item.kind === 'voice').url);
  const response = await fetch(app.base + signed.pathname + signed.search);
  assert.equal(response.headers.get('content-type'), 'audio/wav'); assert.equal(response.status, 200);
  const signedVideo = new URL(app.state.creates.find(item => item.kind === 'video').url);
  const providerVideo = await fetch(app.base + signedVideo.pathname + signedVideo.search);
  assert.equal(await providerVideo.text(), 'silent-video');
  assert.deepEqual(Buffer.from(await (await app.call(`/tasks/${id}/video`)).arrayBuffer()), VIDEO);
  app.state.done = true;
  const completed = await app.until(id, task => task.status === 'completed');
  assert.equal(completed.audioCheck.afterOffsetMs, 0); assert.equal(completed.audioCheck.lipSync, 'needs_preview');
  assert.equal(app.state.generations, 1);
});

test('selecting H3 Max persists its queue through restart and never uses the default provider', async t => {
  let app; const requests = [];
  const falProvider = createFalVideoProvider({ falKey: 'private-fal-key' }, async (url, options) => {
    requests.push({ url: String(url), ...options });
    if (options.method === 'POST') return Response.json({ request_id: 'fal-live-test',
      status_url: 'https://queue.fal.run/minimax/h3-max/requests/fal-live-test/status', response_url: 'https://queue.fal.run/minimax/h3-max/requests/fal-live-test' });
    return Response.json(String(url).endsWith('/status') ? { status: app.state.done ? 'COMPLETED' : 'IN_PROGRESS' } : { video: { url: 'https://v3.fal.media/result.mp4' } });
  });
  app = await fixture(t, { config: { ...CONFIG, falEnabled: true, falKey: 'private-fal-key' }, falProvider,
    voice: async (_input, output) => { await writeFile(output, VIDEO); return { ready: true, duration: 3 }; }, speech: fakeSpeech() });
  const config = await (await app.call('/config')).json();
  assert.deepEqual(config.models.map(model => [model.name, model.enabled]), [['Max模型', true], ['MiniMax H3 Max', true]]);
  assert.ok(!JSON.stringify(config).includes('private-fal-key'));
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id); await app.call(`/tasks/${id}/analyze`, { body: {} });
  await app.call(`/tasks/${id}/start`, { body: { model: FAL_MODEL, speechConfirmed: true } });
  const running = await app.until(id, task => task.status === 'running');
  assert.equal(running.model, FAL_MODEL); assert.equal(running.modelName, 'MiniMax H3 Max');
  const body = JSON.parse(requests.find(request => request.method === 'POST').body);
  assert.equal(body.reference_image_urls.length, 1); assert.equal(body.reference_audio_urls.length, 1);
  const signed = new URL(body.reference_video_urls[0]);
  assert.equal(await (await fetch(app.base + signed.pathname + signed.search)).text(), 'silent-video');
  await app.call(`/tasks/${id}/start`, { body: { model: 'doubao-seedance-2-0-260128' } });
  assert.equal((await app.current(id)).model, FAL_MODEL);
  await app.close(); await app.open(); app.state.done = true;
  const completed = await app.until(id, task => task.status === 'completed' && task.billing.status === 'settled');
  assert.equal(completed.model, FAL_MODEL); assert.equal(completed.resolution, '768p');
  assert.deepEqual(Buffer.from(await (await app.call(`/tasks/${id}/result`)).arrayBuffer()), VIDEO);
  assert.equal(requests.filter(request => request.method === 'POST').length, 1);
  assert.equal(app.state.generations, 0); assert.equal(app.state.creates.length, 0);
  assert.equal((await app.wallet.snapshot('alice')).available, 955);
});

test('unsupported and unconfigured replica models cannot start or reserve points', async t => {
  const app = await fixture(t);
  assert.equal((await app.call('/tasks', { body: { requestId: randomUUID(), model: FAL_MODEL } })).status, 503);
  assert.equal((await app.call('/tasks', { body: { requestId: randomUUID(), model: 'unknown' } })).status, 400);
  const id = await app.init(); await app.upload(id);
  assert.equal((await app.call(`/tasks/${id}/start`, { body: { model: FAL_MODEL } })).status, 503);
  assert.equal((await app.current(id)).status, 'draft');
  assert.equal(app.state.generations, 0); assert.equal((await app.wallet.snapshot('alice')).held, 0);
});

test('a replacement video invalidates voice analysis and a broken audio processor refunds credits', async t => {
  const app = await fixture(t, { voice: async (_input, output) => { await writeFile(output, VIDEO); return { ready: true, duration: 3 }; }, speech: fakeSpeech({ align: async () => { throw new Error('FFmpeg failed'); } }) });
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id); await app.call(`/tasks/${id}/analyze`, { body: {} });
  await fetch(app.base + `/api/video-replica/tasks/${id}/video`, { method: 'PUT', body: VIDEO });
  assert.equal((await app.current(id)).speech, undefined);
  assert.equal((await app.call(`/tasks/${id}/start`, { body: { speechConfirmed: true } })).status, 409);
  await app.call(`/tasks/${id}/analyze`, { body: {} });
  await app.call(`/tasks/${id}/start`, { body: { speechConfirmed: true } }); app.state.done = true;
  const failed = await app.until(id, task => task.status === 'failed' && task.billing?.status === 'released');
  assert.equal(failed.code, 'VIDEO_SPEECH_FAILED'); assert.equal(failed.resultUrl, null);
  assert.equal((await app.wallet.snapshot('alice')).available, 1000); assert.equal(app.state.generations, 1);
});

test('transcript differences never block delivery and preserve generated audio when alignment is unsafe', async t => {
  const timeline = text => ({ ...SPEECH, text, segments: [{ ...SPEECH.segments[0], text,
    words: [{ word: text, start: 1.25, end: 3.5 }] }] });
  const source = timeline('现在九块九，欢迎大家购买。真的好吃');
  for (const [name, raw, aligned, failedStage] of [
    ['rewritten script', timeline('完全不同的台词重复好多内容'.repeat(10)), source],
    ['changed price', timeline('现在九十九，欢迎大家购买。真的好吃'), source],
    ['missing phrase', timeline('现在九块九'), source],
    ['aligned difference', source, timeline('已经变成完全不同的台词')],
    ['unrecognized generated speech', source, source, 'generated.mp4'],
    ['unrecognized aligned speech', source, source, 'result.tmp'],
    ['unmatched timing', source, { ...source, segments: [{ ...source.segments[0], start: 2 }] }],
  ]) await t.test(name, async t => {
    const app = await fixture(t, { voice: async (_input, output) => { await writeFile(output, VIDEO); return { ready: true, duration: 3 }; },
      speech: fakeSpeech({ analyze: async path => {
        if (failedStage && path.endsWith(failedStage)) throw Object.assign(new Error('台词识别不完整'), { code: 'VIDEO_SPEECH_INVALID' });
        return path.endsWith('source.mp4') ? source : path.endsWith('generated.mp4') ? raw : aligned;
      }, align: async (_source, output, original, generated) => {
        alignmentSegments(original, generated); await writeFile(output, Buffer.from('altered-audio')); return { transcriptMatched: true };
      } }) });
    const id = await app.init(); await app.upload(id); await uploadVoice(app, id);
    await app.call(`/tasks/${id}/analyze`, { body: {} });
    await app.call(`/tasks/${id}/start`, { body: { speechConfirmed: true } }); app.state.done = true;
    const completed = await app.until(id, task => ['completed', 'failed'].includes(task.status) && ['settled', 'released'].includes(task.billing.status));
    assert.equal(completed.status, 'completed', completed.error);
    assert.equal(completed.audioCheck.corrected, false);
    assert.equal(completed.audioCheck.transcriptMatched, null);
    assert.equal(completed.audioCheck.afterOffsetMs, null);
    assert.match(completed.audioCheck.warning, /保留.*生成.*声音/);
    assert.deepEqual(Buffer.from(await (await app.call(`/tasks/${id}/result`)).arrayBuffer()), VIDEO);
    assert.equal(completed.billing.chargedPoints, 45);
    await app.close(); await app.open();
    assert.equal((await app.current(id)).status, 'completed');
    assert.equal((await app.wallet.snapshot('alice')).available, 955);
    assert.equal(app.state.generations, 1);
  });
});

test('advisory transcript checks still reject invalid result files', async t => {
  let resultProbes = 0;
  const app = await fixture(t, { voice: async (_input, output) => { await writeFile(output, VIDEO); return { ready: true, duration: 3 }; },
    probe: async path => ({ ...META, audio: !path.endsWith('result.tmp') || ++resultProbes === 1 }),
    speech: fakeSpeech({ align: async () => { throw Object.assign(new Error('台词差异'), { code: 'VIDEO_SPEECH_INVALID' }); } }) });
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id); await app.call(`/tasks/${id}/analyze`, { body: {} });
  await app.call(`/tasks/${id}/start`, { body: { speechConfirmed: true } }); app.state.done = true;
  const failed = await app.until(id, task => task.status === 'failed' && task.billing.status === 'released');
  assert.equal(failed.code, 'VIDEO_RESULT_INVALID'); assert.equal(failed.resultUrl, null);
  assert.equal((await app.wallet.snapshot('alice')).available, 1000);
});

test('minor ASR differences deliver a real result and settle once without concealing either verification stage', async t => {
  const text = '这款饼干又薄又脆打开包装就能闻到浓浓的香味吃起来清爽可口适合大家分享真的超级好吃香酥美味全家都爱分享';
  const minor = text.replace('包装', '包妆').replace('香味', '香卫').replace('可口', '可扣').replace('大家', '大加').replace('分享', '分响');
  const timeline = value => ({ ...SPEECH, text: value, segments: [{ ...SPEECH.segments[0], text: value,
    words: [{ word: value, start: 1.25, end: 3.5 }] }] });
  for (const [raw, aligned] of [[minor, text], [text, minor], [minor, minor]]) await t.test(`${raw === text ? 'exact' : 'minor'} raw, ${aligned === text ? 'exact' : 'minor'} aligned`, async t => {
    const app = await fixture(t, { voice: async (_input, output) => { await writeFile(output, VIDEO); return { ready: true, duration: 3 }; },
      speech: fakeSpeech({ analyze: async path => timeline(path.endsWith('source.mp4') ? text : path.endsWith('generated.mp4') ? raw : aligned),
        align: async (_source, output, original, generated) => { alignmentSegments(original, generated); await writeFile(output, VIDEO); return { transcriptMatched: true }; } }) });
    const id = await app.init(); await app.upload(id); await uploadVoice(app, id);
    await app.call(`/tasks/${id}/analyze`, { body: {} });
    await app.call(`/tasks/${id}/start`, { body: { speechConfirmed: true } }); app.state.done = true;
    const completed = await app.until(id, task => task.status === 'completed' && task.billing.status === 'settled');
    assert.equal(completed.audioCheck.transcriptMatched, false);
    assert.equal(completed.audioCheck.transcriptDifferences, 5);
    assert.equal(completed.audioCheck.afterOffsetMs, 0);
    assert.deepEqual(Buffer.from(await (await app.call(`/tasks/${id}/result`)).arrayBuffer()), VIDEO);
    assert.equal(completed.billing.chargedPoints, 45);
    await app.close(); await app.open();
    assert.equal((await app.current(id)).status, 'completed');
    assert.equal((await app.wallet.snapshot('alice')).available, 955);
    assert.equal(app.state.generations, 1);
  });
});

test('voice analysis rejects silence, unaligned words, rewritten scripts and excessive speed changes', () => {
  assert.throws(() => speechTimeline({ words: SPEECH.segments[0].words }, [], 4), /未识别/);
  assert.throws(() => speechTimeline({ words: [{ word: '你好', start: 1, end: 0 }] }, [{ start: 1, end: 2 }], 4), /时间戳/);
  const zeroCharacter = speechTimeline({ words: [{ word: '欢', start: 1, end: 1 }, { word: '迎', start: 1, end: 1.5 }] }, [{ start: 1, end: 1.5 }], 2);
  assert.equal(zeroCharacter.text, '欢迎'); assert.equal(zeroCharacter.segments[0].words[0].start, 1);
  assert.throws(() => alignmentSegments(SPEECH, { ...SPEECH, text: '台词改变' }), /台词/);
  const long = { ...SPEECH, segments: [{ ...SPEECH.segments[0], start: 0, end: 9 }] };
  assert.throws(() => alignmentSegments(SPEECH, long), /语速/);
  const generated = { ...SPEECH, segments: [{ ...SPEECH.segments[0], start: 0.5, end: 2.75 }] };
  assert.deepEqual(alignmentSegments(SPEECH, generated)[0], { start: 0.5, end: 2.75, targetStart: 1.25, targetEnd: 3.5, rate: 1 });
});

test('alignment removes generated pauses inside an originally continuous phrase', () => {
  const generated = { start: 0.5, text: '你好世界', segments: [
    { start: 0.5, end: 1.5, words: [{ word: '你好', start: 0.5, end: 1.5 }] },
    { start: 2.1, end: 3.1, words: [{ word: '世界', start: 2.1, end: 3.1 }] },
  ] };
  const [segment] = alignmentSegments(SPEECH, generated);
  assert.deepEqual(segment.parts, [{ start: 0.5, end: 1.5 }, { start: 2.1, end: 3.1 }]);
  assert.ok(Math.abs(segment.rate - 2 / 2.25) < 1e-12);
  assert.equal(segment.targetStart, 1.25);
  assert.equal(segment.targetEnd, 3.5);
});

test('ASR words crossing a real pause cannot expand VAD intervals into artificial overlap', () => {
  const result = speechTimeline({ words: [
    { word: '你好', start: 0, end: 1.6 },
    { word: '世界', start: 1.4, end: 2.2 },
  ] }, [{ start: 0, end: 1 }, { start: 1.5, end: 2.5 }], 3);
  assert.equal(result.text, '你好世界');
  assert.deepEqual(result.segments.map(({ start, end }) => ({ start, end })), [{ start: 0, end: 1 }, { start: 1.5, end: 2.5 }]);
  assert.deepEqual(result.segments.map(segment => segment.words[0]), [
    { word: '你好', start: 0, end: 1 }, { word: '世界', start: 1.5, end: 2.2 },
  ]);
  assert.throws(() => speechTimeline({ words: SPEECH.segments[0].words }, [{ start: 0, end: 2 }, { start: 1.5, end: 3 }], 4), /检测区间无效/);
  assert.throws(() => speechTimeline({ words: [{ word: '不匹配', start: 2.5, end: 3 }] }, [{ start: 0, end: 1 }], 4), /不一致/);
});

test('an untranscribed short closing phrase cannot disappear from the speech timeline', () => {
  const intervals = [{ start: 0, end: 9.28 }, { start: 11.232, end: 12.282 }];
  assert.throws(() => speechTimeline({ words: [{ word: '又薄又脆', start: 8, end: 9.28 }] }, intervals, 12.3), cause => {
    assert.equal(cause.code, 'VIDEO_SPEECH_INVALID');
    assert.match(cause.message, /台词识别不完整/);
    assert.deepEqual(cause.unmatchedVadIntervals, [intervals[1]]);
    return true;
  });
});

test('a split consonant tail stays with its transcribed word without hiding another phrase', () => {
  const words = [{ word: '又薄又脆', start: 11.58, end: 12.8 }, { word: '真的超好吃', start: 13.88, end: 14.86 }];
  const intervals = [{ start: 5.056, end: 12.544 }, { start: 12.832, end: 12.96 }, { start: 14.08, end: 15.104 }];
  const result = speechTimeline({ words }, intervals, 15.104);
  assert.equal(result.text, '又薄又脆真的超好吃');
  assert.deepEqual(result.segments.map(({ start, end }) => ({ start, end })), [
    { start: 5.056, end: 12.96 }, { start: 14.08, end: 15.104 },
  ]);
  assert.throws(() => speechTimeline({ words }, [intervals[0], { start: 13.1, end: 13.228 }, intervals[2]], 15.104), /台词识别不完整/);
});

test('confirmed speech changes text while retaining measured boundaries and original word timestamps', () => {
  const corrected = confirmSpeech(SPEECH, [{ text: '你好老板', start: 0, end: 99 }]);
  assert.equal(corrected.text, '你好老板');
  assert.equal(SPEECH.text, '你好世界');
  assert.equal(corrected.segments[0].start, SPEECH.segments[0].start);
  assert.equal(corrected.segments[0].end, SPEECH.segments[0].end);
  assert.deepEqual(corrected.segments[0].words, SPEECH.segments[0].words);
  for (const segments of [[], [{ text: '' }], [{ text: '。。。' }], [{ text: 'a'.repeat(2001) }], [{ text: 42 }]]) {
    assert.throws(() => confirmSpeech(SPEECH, segments), /台词/);
  }
});

test('draft correction is persisted and the supplier receives the confirmed rather than the original ASR text', async t => {
  const corrected = confirmSpeech(SPEECH, [{ text: '你好老板' }]);
  const app = await fixture(t, { voice: async (_input, output) => { await writeFile(output, VIDEO); return { ready: true, duration: 3 }; },
    speech: fakeSpeech({ analyze: async path => path.endsWith('source.mp4') ? SPEECH : corrected }) });
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id);
  await app.call(`/tasks/${id}/analyze`, { body: {} });
  assert.equal((await app.call(`/tasks/${id}/speech`, { body: { segments: [] } })).status, 422);
  assert.equal((await app.call(`/tasks/${id}/speech`, { owner: 'bob', body: { segments: [{ text: '你好老板' }] } })).status, 404);
  const saved = await app.call(`/tasks/${id}/speech`, { body: { segments: [{ text: '你好老板', start: 0 }] } });
  assert.equal(saved.status, 200);
  const disk = JSON.parse(await readFile(join(app.root, 'video', id, 'task.json'), 'utf8'));
  assert.equal(disk.originalSpeech.text, '你好世界'); assert.equal(disk.speech.text, '你好老板');
  assert.equal(disk.speech.start, SPEECH.start);
  await app.call(`/tasks/${id}/start`, { body: { speechConfirmed: true } });
  await app.until(id, task => task.status === 'running');
  assert.match(app.state.body.prompt, /你好老板/); assert.doesNotMatch(app.state.body.prompt, /你好世界/);
  assert.equal((await app.call(`/tasks/${id}/speech`, { body: { segments: [{ text: '你好世界' }] } })).status, 409);
  app.state.done = true; await app.until(id, task => task.status === 'completed');
  assert.equal(app.state.generations, 1);
});

test('a failed voice check can recheck the existing media after restart and settle exactly one delivery', async t => {
  let valid = false;
  const app = await fixture(t, { voice: async (_input, output) => { await writeFile(output, VIDEO); return { ready: true, duration: 3 }; },
    speech: fakeSpeech({ align: async (_source, output) => {
      if (!valid) throw new Error('FFmpeg failed');
      await writeFile(output, VIDEO); return { transcriptMatched: true };
    } }) });
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id); await app.call(`/tasks/${id}/analyze`, { body: {} });
  await app.call(`/tasks/${id}/start`, { body: { speechConfirmed: true } }); app.state.done = true;
  const failed = await app.until(id, task => task.status === 'failed' && task.billing?.status === 'released');
  assert.equal(failed.canRecheck, true); assert.equal(failed.resultUrl, null);
  assert.equal((await app.wallet.snapshot('alice')).available, 1000);
  await app.close(); await app.open();
  assert.equal((await app.current(id)).canRecheck, true);
  assert.equal((await app.call(`/tasks/${id}/recheck`, { owner: 'bob', body: {} })).status, 404);
  valid = true;
  const responses = await Promise.all([app.call(`/tasks/${id}/recheck`, { body: {} }), app.call(`/tasks/${id}/recheck`, { body: {} })]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 202]);
  const completed = await app.until(id, task => task.status === 'completed');
  assert.equal(completed.billing.chargedPoints, 45);
  assert.equal((await app.wallet.snapshot('alice')).available, 955);
  assert.equal(app.state.generations, 1); assert.equal(app.state.creates.length, 3);
  for (let i = 0; i < 3; i++) await app.call(`/tasks/${id}/recheck`, { body: {} });
  assert.equal(app.state.generations, 1); assert.equal((await app.wallet.snapshot('alice')).available, 955);
  const disk = JSON.parse(await readFile(join(app.root, 'video', id, 'task.json'), 'utf8'));
  assert.equal((await app.wallet.reservation('alice', id)).status, 'released');
  assert.equal((await app.wallet.reservation('alice', disk.billingTaskId)).status, 'settled');
});

test('failed rechecks release each recovery hold without another video generation or premature asset', async t => {
  const app = await fixture(t, { voice: async (_input, output) => { await writeFile(output, VIDEO); return { ready: true, duration: 3 }; },
    speech: fakeSpeech({ align: async () => { throw new Error('FFmpeg failed'); } }) });
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id); await app.call(`/tasks/${id}/analyze`, { body: {} });
  await app.call(`/tasks/${id}/start`, { body: { speechConfirmed: true } }); app.state.done = true;
  await app.until(id, task => task.status === 'failed' && task.billing?.status === 'released');
  for (let i = 0; i < 2; i++) {
    assert.equal((await app.call(`/tasks/${id}/recheck`, { body: {} })).status, 202);
    await app.until(id, task => task.status === 'failed' && task.billing?.status === 'released');
    assert.equal((await app.wallet.snapshot('alice')).available, 1000);
    assert.equal((await app.call(`/tasks/${id}/result`)).status, 409);
  }
  assert.equal(app.state.generations, 1);
});

test('a lost recovery reservation acknowledgement is refunded before a second attempt can start', async t => {
  const app = await fixture(t, { voice: async (_input, output) => { await writeFile(output, VIDEO); return { ready: true, duration: 3 }; },
    speech: fakeSpeech({ align: async () => { throw new Error('FFmpeg failed'); } }) });
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id); await app.call(`/tasks/${id}/analyze`, { body: {} });
  await app.call(`/tasks/${id}/start`, { body: { speechConfirmed: true } }); app.state.done = true;
  await app.until(id, task => task.status === 'failed' && task.billing?.status === 'released');
  await app.close();
  await app.open({ credits: { ...app.wallet, reserve: async request => { await app.wallet.reserve(request); throw new Error('Acknowledgement lost'); } } });
  assert.equal((await app.call(`/tasks/${id}/recheck`, { body: {} })).status, 503);
  const failed = await app.until(id, task => task.status === 'failed' && task.billing?.status === 'released');
  assert.equal(failed.canRecheck, true);
  const disk = JSON.parse(await readFile(join(app.root, 'video', id, 'task.json'), 'utf8'));
  assert.equal((await app.wallet.reservation('alice', disk.billingTaskId)).status, 'released');
  assert.equal((await app.wallet.snapshot('alice')).held, 0);
  assert.equal(app.state.generations, 1);
});

test('a pending refund blocks recheck and keeps the original hold addressable', async t => {
  const app = await fixture(t, { voice: async (_input, output) => { await writeFile(output, VIDEO); return { ready: true, duration: 3 }; },
    speech: fakeSpeech({ align: async () => { throw new Error('FFmpeg failed'); } }) });
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id); await app.call(`/tasks/${id}/analyze`, { body: {} });
  await app.close();
  await app.open({ credits: { ...app.wallet, release: async () => { throw new Error('Refund unavailable'); } } });
  await app.call(`/tasks/${id}/start`, { body: { speechConfirmed: true } }); app.state.done = true;
  const failed = await app.until(id, task => task.status === 'failed' && task.billing?.status === 'release_pending');
  assert.equal(failed.canRecheck, false);
  assert.equal((await app.call(`/tasks/${id}/recheck`, { body: {} })).status, 409);
  const disk = JSON.parse(await readFile(join(app.root, 'video', id, 'task.json'), 'utf8'));
  assert.equal(disk.billingTaskId, undefined); assert.equal(disk.recheckAttempt, undefined);
  assert.equal((await app.wallet.reservation('alice', id)).status, 'reserved');
  await app.close(); await app.open();
  await app.until(id, task => task.billing?.status === 'released');
  assert.equal((await app.wallet.snapshot('alice')).held, 0);
  assert.equal(app.state.generations, 1);
});

test('restart refunds a committed recovery hold from its persisted reserve-pending journal without replaying generation', async t => {
  const app = await fixture(t, { voice: async (_input, output) => { await writeFile(output, VIDEO); return { ready: true, duration: 3 }; },
    speech: fakeSpeech({ align: async () => { throw new Error('FFmpeg failed'); } }) });
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id); await app.call(`/tasks/${id}/analyze`, { body: {} });
  await app.call(`/tasks/${id}/start`, { body: { speechConfirmed: true } }); app.state.done = true;
  await app.until(id, task => task.status === 'failed' && task.billing?.status === 'released');
  await app.close();
  const originalReservation = await app.wallet.reservation('alice', id);
  const taskPath = join(app.root, 'video', id, 'task.json');
  const journal = JSON.parse(await readFile(taskPath, 'utf8'));
  const recoveryId = `video-recheck:${id}:1`;
  journal.recheckAttempt = 1; journal.billingTaskId = recoveryId; journal.recheckStartedAt = Date.now();
  journal.status = 'reserving'; journal.error = ''; delete journal.code;
  journal.billing = { status: 'reserve_pending', reservedPoints: 0, chargedPoints: 0, exempt: false };
  await writeFile(taskPath, JSON.stringify(journal));
  await app.wallet.reserve({ userId: 'alice', taskId: recoveryId, kind: 'video', units: journal.duration });
  assert.equal((await app.wallet.snapshot('alice')).held, 45);
  const releases = [], queriesBeforeRestart = app.state.queries, materialsBeforeRestart = app.state.creates.length;
  await app.open({ credits: { ...app.wallet, release: async request => { releases.push(request.taskId); return app.wallet.release(request); } } });
  assert.deepEqual(releases, [recoveryId]);
  const failed = await app.current(id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.code, 'VIDEO_INTERRUPTED');
  assert.equal(failed.billing.status, 'released'); assert.equal(failed.canRecheck, true); assert.equal(failed.resultUrl, null);
  assert.equal((await app.wallet.reservation('alice', recoveryId)).status, 'released');
  assert.deepEqual(await app.wallet.reservation('alice', id), originalReservation);
  const wallet = await app.wallet.snapshot('alice'); assert.equal(wallet.held, 0); assert.equal(wallet.available, 1000);
  const recovered = JSON.parse(await readFile(taskPath, 'utf8'));
  assert.equal(recovered.billingTaskId, recoveryId); assert.equal(recovered.recheckAttempt, 1);
  assert.deepEqual(recovered.speech, journal.speech);
  assert.deepEqual(await readFile(join(app.root, 'video', id, 'generated.mp4')), VIDEO);
  await app.close(); await app.open();
  assert.equal((await app.current(id)).billing.status, 'released');
  assert.equal((await app.wallet.snapshot('alice')).held, 0);
  assert.equal(app.state.generations, 1); assert.equal(app.state.queries, queriesBeforeRestart);
  assert.equal(app.state.creates.length, materialsBeforeRestart); assert.deepEqual(releases, [recoveryId]);
});

test('two materials, signed source access, playable range response and exactly-once billing', async t => {
  const app = await fixture(t);
  const id = await app.init(); await app.upload(id);
  assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 202);
  await app.until(id, task => task.status === 'running');
  assert.equal((await app.wallet.snapshot('alice')).held, 45);
  assert.equal(app.state.creates.length, 2); assert.equal(app.state.generations, 1);
  const source = new URL(app.state.creates.find(item => item.kind === 'video').url);
  const downloaded = await fetch(app.base + source.pathname + source.search);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), VIDEO);
  assert.equal((await fetch(app.base + source.pathname)).status, 403);
  assert.equal((await fetch(app.base + source.pathname + source.search.replace('signature=', 'signature=0'))).status, 403);
  assert.equal((await app.call(`/tasks/${id}`, { owner: 'bob' })).status, 404);
  assert.equal((await app.call(`/tasks/${id}/video`, { owner: 'bob' })).status, 404);
  assert.equal((await app.call(`/tasks/${id}/photo`, { owner: 'bob' })).status, 404);
  assert.equal((await app.call(`/tasks/${id}/video`)).status, 200);
  assert.equal((await app.call(`/tasks/${id}/photo`)).status, 200);
  assert.deepEqual((await (await app.call('/tasks', { owner: 'bob' })).json()).tasks, []);
  assert.equal((await app.call(`/tasks/${id}/result`)).status, 409);
  const current = await app.current(id);
  assert.equal(JSON.stringify(current).includes('provider-1'), false); assert.equal(JSON.stringify(current).includes('sign'), false);
  app.state.done = true;
  const task = await app.until(id, value => value.status === 'completed');
  assert.equal(task.billing.chargedPoints, 45); assert.equal((await app.wallet.snapshot('alice')).available, 955);
  const range = await app.call(`/tasks/${id}/result`, { headers: { Range: 'bytes=0-11' } });
  assert.equal(range.status, 206); assert.equal(range.headers.get('content-type'), 'video/mp4');
  assert.equal((await range.arrayBuffer()).byteLength, 12);
  assert.equal((await app.call(`/tasks/${id}/result`, { owner: 'bob' })).status, 404);
  for (let i = 0; i < 3; i++) assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 200);
  assert.equal(app.state.generations, 1); assert.equal((await app.wallet.snapshot('alice')).available, 955);
});

test('provider completion accepts message URLs without a video extension', async () => {
  const url = 'https://cdn.example/download/result?token=test';
  const config = { video: { base: 'https://provider.example' } };
  for (const data of [{ status: 2, message: url }, { status: 2, result: { message: url } }]) {
    const provider = createVideoProvider(config, async () => Response.json({ success: true, data }));
    const result = await provider.query('provider-1');
    assert.equal(result.url, url);
    assert.equal(result.completed, true);
  }
  assert.equal(parseGeneration({ data: { status: 1, message: 'processing' } }).url, undefined);
});

test('completed replies without media are visible and recover on the original task after restart', async t => {
  let reply = { status: 2, message: 'https://cdn.example/download/result?token=test' };
  const config = { video: { base: 'https://provider.example' } };
  const provider = createVideoProvider(config, async () => Response.json({ success: true, data: reply }));
  const app = await fixture(t, { query: () => provider.query('provider-1') });
  const id = await app.init(); await app.upload(id);
  reply = { status: 2, message: 'Result is being prepared' };
  await app.call(`/tasks/${id}/start`, { body: {} });
  const waiting = await app.until(id, task => task.code === 'VIDEO_RESULT_PENDING');
  assert.equal(waiting.status, 'running');
  assert.match(waiting.error, /完成.*成片/);
  assert.ok(waiting.startedAt >= waiting.createdAt);
  assert.ok(waiting.lastCheckedAt >= waiting.startedAt);
  assert.equal(waiting.resultUrl, null);
  assert.equal((await app.wallet.snapshot('alice')).held, 45);
  await app.close();
  reply = { status: 2, message: 'https://cdn.example/download/result?token=test' };
  await app.open();
  const completed = await app.until(id, task => task.status === 'completed');
  assert.equal(completed.error, ''); assert.equal(completed.code, undefined);
  assert.equal(completed.billing.chargedPoints, 45);
  assert.equal(app.state.generations, 1);
});

test('unlimited zero-balance account completes a person replica without charges and still waits for settlement', async t => {
  const app = await fixture(t);
  await app.wallet.reserve({ userId: 'alice', taskId: 'spent_initial', kind: 'image', units: 20 });
  await app.wallet.settle({ userId: 'alice', taskId: 'spent_initial', units: 20 });
  await app.wallet.setUnlimited('alice', true);
  const id = await app.init(); await app.upload(id);
  assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 202);
  const running = await app.until(id, task => task.status === 'running');
  assert.equal(running.billing.exempt, true); assert.equal(running.billing.reservedPoints, 0);
  assert.equal(running.estimatedPoints, 0);
  assert.equal((await app.call(`/tasks/${id}/result`)).status, 409);
  app.state.done = true;
  const completed = await app.until(id, task => task.status === 'completed');
  assert.equal(completed.billing.status, 'settled'); assert.equal(completed.billing.chargedPoints, 0);
  assert.equal((await app.call(`/tasks/${id}/result`)).status, 200);
  assert.equal((await app.wallet.snapshot('alice')).available, 0);
  assert.equal((await app.wallet.snapshot('alice')).held, 0);
  assert.equal((await app.wallet.snapshot('bob')).unlimited, false);
  assert.equal(app.state.generations, 1);
});

test('missing inputs, invalid duration and cross-origin requests never dispatch', async t => {
  const app = await fixture(t, { probe: async () => ({ ...META, duration: 20 }) });
  assert.equal((await app.call('/tasks', { body: { requestId: randomUUID() }, headers: { Origin: 'https://evil.example' } })).status, 403);
  const id = await app.init();
  assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 400);
  const invalid = await fetch(app.base + `/api/video-replica/tasks/${id}/video`, { method: 'PUT', body: VIDEO });
  assert.equal(invalid.status, 400); assert.equal((await app.current(id)).video, undefined);
  assert.equal(app.state.generations, 0); assert.equal((await app.wallet.snapshot('alice')).held, 0);
});

test('failed material review returns reserved credits without a video generation call', async t => {
  const app = await fixture(t); app.state.review = 3;
  const id = await app.init(); await app.upload(id); await app.call(`/tasks/${id}/start`, { body: {} });
  const task = await app.until(id, value => value.status === 'failed' && value.billing?.status === 'released');
  assert.equal(task.code, 'VIDEO_REVIEW_REJECTED'); assert.equal(app.state.generations, 0);
  assert.equal((await app.wallet.snapshot('alice')).available, 1000);
});

test('insufficient balance prevents material and model calls', async t => {
  const app = await fixture(t);
  await app.wallet.reserve({ userId: 'alice', taskId: 'other', kind: 'image', units: 20 });
  const id = await app.init(); await app.upload(id);
  assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 402);
  assert.equal(app.state.creates.length, 0); assert.equal(app.state.generations, 0);
});

test('confirmed provider failure releases the hold, while downloads retry without regenerating', async t => {
  const app = await fixture(t);
  const first = await app.init(); await app.upload(first); app.state.failed = true;
  await app.call(`/tasks/${first}/start`, { body: {} });
  await app.until(first, task => task.status === 'failed' && task.billing?.status === 'released');
  assert.equal((await app.wallet.snapshot('alice')).available, 1000);
  app.state.failed = false; app.state.done = true; let attempts = 0;
  await app.close();
  await app.open({ download: async (_url, path) => { if (++attempts === 1) throw new Error('Download interrupted'); await writeFile(path, VIDEO); } });
  const second = await app.init(); await app.upload(second); await app.call(`/tasks/${second}/start`, { body: {} });
  await app.until(second, task => task.status === 'completed');
  assert.equal(attempts, 2); assert.equal(app.state.generations, 2);
  assert.equal((await app.wallet.snapshot('alice')).available, 955);
});

test('restart resumes provider polling without a second paid submission', async t => {
  const app = await fixture(t);
  const id = await app.init(); await app.upload(id); await app.call(`/tasks/${id}/start`, { body: {} });
  await app.until(id, task => task.status === 'running');
  await app.close(); app.state.done = true; await app.open();
  await app.until(id, task => task.status === 'completed');
  assert.equal(app.state.generations, 1); assert.equal((await app.wallet.snapshot('alice')).available, 955);
});

test('uncertain paid submission is never replayed and its hold is returned', async t => {
  const app = await fixture(t, { uncertain: true });
  const id = await app.init(); await app.upload(id); await app.call(`/tasks/${id}/start`, { body: {} });
  const task = await app.until(id, task => task.status === 'failed' && task.billing?.status === 'released');
  assert.equal(task.code, 'VIDEO_SUBMISSION_UNCERTAIN');
  await app.close(); await app.open(); await app.call(`/tasks/${id}/start`, { body: {} });
  assert.equal(app.state.generations, 1); assert.equal((await app.wallet.snapshot('alice')).available, 1000);
});

test('settlement retries keep the output private and never charge twice after a lost acknowledgement', async t => {
  const app = await fixture(t); let blocked = true;
  await app.close();
  await app.open({ credits: { ...app.wallet, settle: async values => { await app.wallet.settle(values); if (blocked) throw new Error('Lost acknowledgement'); return app.wallet.reservation(values.userId, values.taskId); }, reservation: async (...values) => { const item = await app.wallet.reservation(...values); if (blocked && item?.status === 'settled') throw new Error('Offline'); return item; } } });
  const id = await app.init(); await app.upload(id); app.state.done = true; await app.call(`/tasks/${id}/start`, { body: {} });
  await app.until(id, task => task.status === 'settling');
  assert.equal((await app.call(`/tasks/${id}/result`)).status, 409);
  blocked = false;
  await app.until(id, task => task.status === 'completed');
  assert.equal((await app.wallet.snapshot('alice')).available, 955);
});

test('three-day expiry removes media while keeping deduplication and billing records', async t => {
  let time = Date.now(); const app = await fixture(t, { now: () => time });
  const id = await app.init(); await app.upload(id); app.state.done = true; await app.call(`/tasks/${id}/start`, { body: {} });
  await app.until(id, task => task.status === 'completed');
  time += 3 * 86400_000 + 1;
  assert.equal((await app.call(`/tasks/${id}/result`)).status, 410);
  await delay(50);
  await assert.rejects(readFile(join(app.root, 'video', id, 'result.mp4')), { code: 'ENOENT' });
  assert.equal((await app.current(id)).status, 'expired');
  assert.equal((await app.wallet.snapshot('alice')).available, 955);
  assert.equal(app.state.generations, 1);
});

test('three-day expiry erases private voice, ASR, VAD and download artifacts while retaining the text task and settled bill', async t => {
  let time = Date.now();
  const app = await fixture(t, { now: () => time,
    voice: async (_input, output) => { await writeFile(output, VIDEO); return { ready: true, duration: 3 }; }, speech: fakeSpeech() });
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id); await app.call(`/tasks/${id}/analyze`, { body: {} });
  await app.call(`/tasks/${id}/start`, { body: { speechConfirmed: true } }); app.state.done = true;
  await app.until(id, task => task.status === 'completed');
  const taskFolder = join(app.root, 'video', id), taskPath = join(taskFolder, 'task.json');
  let completed;
  const settlementDeadline = performance.now() + 15_000;
  do {
    completed = JSON.parse(await readFile(taskPath, 'utf8'));
    if (completed.billing?.status === 'settled') break;
    await delay(50);
  } while (performance.now() < settlementDeadline);
  assert.equal(completed.billing?.status, 'settled');
  const reservation = await app.wallet.reservation('alice', id);
  const privateArtifacts = ['photo.jpg', 'source.mp4', 'reference.wav', 'voice.tmp.wav', 'generated.mp4', 'result.mp4',
    'upload.tmp', 'result.tmp', 'result.tmp.download.json', 'verification-source.json', 'verification-generated.json',
    'verification-aligned.json', 'source.mp4.asr.wav', 'source.mp4.vad.pcm', 'reference.wav.vad.pcm', 'voice.tmp.wav.vad.pcm',
    'generated.mp4.asr.wav', 'generated.mp4.vad.pcm', 'result.tmp.asr.wav', 'result.tmp.vad.pcm', 'result.tmp.aligned.pcm'];
  await Promise.all(privateArtifacts.map(name => writeFile(join(taskFolder, name), `private material: ${name}`)));
  time += 3 * 86400_000 + 1;
  for (const kind of ['photo', 'video', 'voice', 'result']) assert.equal((await app.call(`/tasks/${id}/${kind}`)).status, 410);
  let expired;
  const cleanupDeadline = performance.now() + 15_000;
  do {
    expired = JSON.parse(await readFile(taskPath, 'utf8'));
    if (expired.cleaned) break;
    await delay(50);
  } while (performance.now() < cleanupDeadline);
  assert.equal(expired.cleaned, true);
  assert.deepEqual(await readdir(taskFolder), ['task.json']);
  assert.equal(expired.status, 'expired'); assert.equal(expired.id, id); assert.equal(expired.userId, 'alice');
  assert.deepEqual(expired.speech, completed.speech); assert.deepEqual(expired.originalSpeech, completed.originalSpeech);
  assert.equal(expired.completedAt, completed.completedAt); assert.deepEqual(expired.billing, completed.billing);
  assert.deepEqual(await app.wallet.reservation('alice', id), reservation);
  const current = await app.current(id);
  assert.equal(current.sourcePhotoUrl, null); assert.equal(current.sourceVideoUrl, null); assert.equal(current.sourceVoiceUrl, null);
  assert.equal(current.resultUrl, null); assert.equal(current.canRecheck, false);
  assert.equal((await app.wallet.snapshot('alice')).available, 955); assert.equal(app.state.generations, 1);
});

test('photo validation rejects small or non-image files and strips metadata into JPEG', async () => {
  await assert.rejects(normalizePhoto(Buffer.from('<svg></svg>')), { code: 'VIDEO_PHOTO_INVALID' });
  const small = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#fff' } }).png().toBuffer();
  await assert.rejects(normalizePhoto(small), { code: 'VIDEO_PHOTO_INVALID' });
  const valid = await sharp({ create: { width: 300, height: 400, channels: 3, background: '#fff' } }).png().toBuffer();
  assert.equal((await sharp(await normalizePhoto(valid)).metadata()).format, 'jpeg');
});

test('result download rejects private addresses and non-HTTP URLs before writing files', async () => {
  for (const url of ['http://127.0.0.1/video.mp4', 'https://10.0.0.1/video.mp4', 'file:///etc/passwd', 'https://example.com:8443/video.mp4']) {
    await assert.rejects(downloadVideo(url, '/not-written.mp4'));
  }
});
