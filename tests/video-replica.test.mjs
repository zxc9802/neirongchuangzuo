import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile, readFile, realpath, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { createVideoHandler } from '../services/video/server.mjs';
import { createVideoProvider, generationBody, parseGeneration, videoConfig, PROMPT, VideoError, PIXVERSE_MODEL, WAN_MODEL, WAN3_MODEL, WAN3_FAST_MODEL } from '../services/video/provider.mjs';
import { wan3GenerationBody } from '../services/video/wan3.mjs';
import { createWan3Storage } from '../services/video/wan3-storage.mjs';
import { createSubtitleRemoval } from '../services/video/subtitle-removal.mjs';
import { planSegments } from '../services/video/segments.mjs';
import { normalizePhoto, downloadVideo, probeVideo } from '../services/video/media.mjs';
import { alignmentSegments, speechTimeline, confirmSpeech } from '../services/video/speech.mjs';
import { createCreditsLedger } from '../services/credits/store.mjs';
import { createFalVideoProvider, FAL_MODEL } from '../services/video/fal.mjs';
import { generationPrice } from '../design/malaysian-prices.js';

const VIDEO = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(100)]);
const CONFIG = { enabled: true, publicOrigin: 'https://workspace.example', signingSecret: 'test-secret-not-for-production' };
const META = { duration: 4, width: 512, height: 800, audio: true };
const PREMIUM_MODEL = 'doubao-seedance-2-5-260628';
const FAST_MODEL = 'doubao-seedance-2-0-fast-260128', MINI_MODEL = 'doubao-seedance-2-0-mini-260615';
const TEST_BALANCE = 100_000;
const REPLICA_PRICES = [
  ['doubao-seedance-2-0-260128', 'qiya-2.0', 1],
  [PREMIUM_MODEL, 'qiya-2.5', 1.5],
  [FAST_MODEL, 'qiya-2.0-f1', 0.8],
  [MINI_MODEL, 'qiya-20-m1', 0.5],
];
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'video-replica-'));
  const balance = options.balance ?? TEST_BALANCE, at = Date.now();
  await mkdir(join(root, 'credits'));
  await writeFile(join(root, 'credits', 'wallets.json'), JSON.stringify({ version: 1, users: { alice: {
    wallet: { available: balance, held: 0, createdAt: at, updatedAt: at }, reservations: {},
    ledger: [{ userId: 'alice', eventKey: 'welcome', kind: 'welcome', availableDelta: 1000, heldDelta: 0, availableAfter: 1000, heldAfter: 0 },
      ...(balance === 1000 ? [] : [{ userId: 'alice', eventKey: 'test-funding', kind: 'test-funding', availableDelta: balance - 1000, heldDelta: 0, availableAfter: balance, heldAfter: 0 }])],
  } } }));
  const wallet = createCreditsLedger({ storageDir: join(root, 'credits'), databaseUrl: null, costMode:options.costMode===true });
  await wallet.ready;
  const state = { creates: [], queries: 0, generations: 0, done: false, failed: false, review: 2, source: null,
    cosUploads: [], cosSigns: [], cosDeletes: [] };
  const provider = {
    async createMaterial(url, kind) { state.creates.push({ url, kind }); return { id: kind + '-id', status: state.review }; },
    async queryMaterial(id) { return options.queryMaterial ? options.queryMaterial(id) : state.review; },
    async generate(task) { state.generations++; state.body = generationBody(task); if (options.uncertain) throw new Error('Network disconnected'); return options.generate ? options.generate(task) : { taskId: 'provider-1' }; },
    async query() { state.queries++; if (options.query) return options.query(); return state.failed ? { failed: true } : state.done ? { url: 'https://cdn.example/result.mp4' } : {}; },
  };
  let app, handler, base;
  async function open(overrides = {}) {
    handler = createVideoHandler({ storageDir: join(root, 'video'), config: CONFIG, provider, credits: wallet,
      photo: async () => Buffer.from('photo'), probe: async input => ({ ...META, duration: options.narration && input.endsWith('upload.tmp') ? 6 : META.duration }),
      download: async (_url, path) => writeFile(path, VIDEO),
      captions: { extract: async () => null },
      narration: null, lipsync: null, voiceConversion: null, subtitleRemoval: null,
      providerStorage: { upload: async input => `https://fal.media/${input.split('/').at(-1)}` },
      wan3Storage: {
        upload: async (id, kind, path, type) => { state.cosUploads.push({ id, kind, path, type, bytes: await readFile(path) }); },
        url: async (id, kind) => {
          state.cosSigns.push({ id, kind });
          return `https://bucket.cos.ap-shanghai.myqcloud.com/workspace-video/wan3/${id}/${kind}.${['photo', 'product', 'background'].includes(kind) ? 'jpg' : kind === 'voice' ? 'wav' : 'mp4'}?signature=${state.cosSigns.length}`;
        },
        remove: async (id, kind) => { state.cosDeletes.push({ id, kind }); },
      },
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
  // Existing task/recovery tests exercise the explicit legacy parameters.
  async function init(id = randomUUID()) { const response = await call('/tasks', { body: { requestId: id, voiceEngine: 'seedance', sourceAudioMode: 'original' } }); assert.equal(response.status, 201); return id; }
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

for (const audio of [true, false]) test(`deep replicas deliver only after full-screen cleanup and resume its receipt, audio=${audio}`, async t => {
  let finished = false, submissions = 0, restores = 0;
  const clean = createSubtitleRemoval({
    provider: { assertConfigured() {}, authorize: async () => {}, submit: async () => { submissions++; return 'cleanup-paid-1'; },
      query: async () => ({ task_id: 'cleanup-paid-1', status: finished ? 'success' : 'processing', progress: 50, metering: 4 }) },
    storage: { assertConfigured() {}, upload: async (_id, path) => { assert.equal(await readFile(path, 'utf8'), 'audio-finalized'); },
      submissionUrls: async () => ({ videoUrl: 'private-source', uploadUrl: 'private-destination' }), outputUrl: async () => 'https://cos.example/clean.mp4', remove: async () => {} },
    download: async (_url, path) => writeFile(path, 'clean-video'), probe: async () => ({ ...META, audio }),
    restoreAudio: async (input, clean, output) => { restores++; assert.equal(await readFile(input, 'utf8'), 'audio-finalized');
      assert.equal(await readFile(clean, 'utf8'), 'clean-video'); await writeFile(output, 'clean-final'); } });
  const app = await fixture(t, { subtitleRemoval: clean, probe: async () => ({ ...META, audio }),
    restoreAudio: async (_input, _generated, output) => writeFile(output, 'audio-finalized') });
  const id = randomUUID(); await app.call('/tasks', { body: { requestId: id, mode: 'deep', replacements: {} } });
  await fetch(app.base + `/api/video-replica/tasks/${id}/video`, { method: 'PUT', body: VIDEO });
  assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 202);
  await app.until(id, task => task.status === 'running'); app.state.done = true;
  const cleaning = await app.until(id, task => task.status === 'cleaning' && task.subtitleRemoval?.stage === 'processing');
  assert.equal(cleaning.resultUrl, null); assert.equal(cleaning.subtitleRemoval.progress, 50);
  assert.doesNotMatch(JSON.stringify(cleaning), /private-source|private-destination|cleanup-paid-1/);
  await app.close(); await app.open(); finished = true;
  const completed = await app.until(id, task => task.status === 'completed');
  assert.equal(completed.captionCheck.method, 'all_area'); assert.equal(submissions, 1); assert.equal(app.state.generations, 1); assert.equal(restores, 1);
  assert.equal(await (await app.call(`/tasks/${id}/result`)).text(), 'clean-final');
});

test('missing cleanup configuration rejects deep start before paid generation or credit reservation', async t => {
  const app = await fixture(t, { subtitleRemoval: createSubtitleRemoval({ env: {} }) });
  const id = randomUUID(); await app.call('/tasks', { body: { requestId: id, mode: 'deep', replacements: {} } });
  await fetch(app.base + `/api/video-replica/tasks/${id}/video`, { method: 'PUT', body: VIDEO });
  assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 503);
  const task = await app.current(id); assert.equal(task.status, 'draft'); assert.equal(task.billing, undefined); assert.equal(app.state.generations, 0);
});

for (const uncertain of [true, false]) test(`cleanup ${uncertain ? 'uncertain' : 'failed'} remains held across restart without resubmitting`, async t => {
  const clean = { assertConfigured() {}, advance: async task => {
    if (uncertain) task.subtitleRemoval.submitting = true; else task.subtitleRemoval.failed = true;
    throw new VideoError('清理任务未确认', 502, uncertain ? 'VIDEO_CLEANUP_UNCERTAIN' : 'VIDEO_CLEANUP_FAILED');
  } };
  const app = await fixture(t, { subtitleRemoval: clean, restoreAudio: async (_source, _generated, output) => writeFile(output, VIDEO) });
  const id = randomUUID(); await app.call('/tasks', { body: { requestId: id, mode: 'deep', replacements: {} } });
  await fetch(app.base + `/api/video-replica/tasks/${id}/video`, { method: 'PUT', body: VIDEO });
  await app.call(`/tasks/${id}/start`, { body: {} }); await app.until(id, task => task.status === 'running'); app.state.done = true;
  const held = await app.until(id, task => task.status === 'waiting'); assert.equal(held.canResume, false); assert.equal(held.resultUrl, null);
  await app.close(); await app.open(); await app.call(`/tasks/${id}/resume`, { body: {} });
  assert.equal((await app.current(id)).status, 'waiting'); assert.equal(app.state.generations, 1);
});

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
  assert.deepEqual(await provider.queryMaterial('photo-id'), { status: 2 });
  const task = { duration: 4, ratio: '9:16', materials: { photo: { id: 'photo-id' }, video: { id: 'video-id' } } };
  assert.equal((await provider.generate(task)).taskId, 'paid-id'); await provider.query('paid-id');
  assert.equal(requests[0].headers.projectCode, 'project'); assert.equal(requests[0].headers['X-Secret-Key'], 'secret');
  assert.equal(requests[0].body.type, 1); assert.equal(requests[0].body.fileType, 1); assert.equal(requests[1].body.fileType, 3);
  assert.equal(requests[3].body.modelId, 'doubao-seedance-2-0-260128');
  assert.equal(requests[3].body.prompt, PROMPT);
  assert.deepEqual(requests[3].body.payload, { params: { mode: 'fusion_video', resolution: '720p', scale: 'adaptive', duration: -1, generateAudio: true }, resources: ['asset://photo-id'], referVideoUrl: ['asset://video-id'] });
  assert.deepEqual(requests[4].body, { taskId: 'paid-id', abilityType: 'VIDEO' });
  assert.equal(parseGeneration({ data: { status: 3 } }).failed, true);
  assert.equal(parseGeneration({ data: { results: [{ video_url: 'https://cdn.example/clip.mp4' }] } }).url, 'https://cdn.example/clip.mp4');
  assert.equal(videoConfig({}).enabled, false);
});

for (const model of [PREMIUM_MODEL, FAST_MODEL, MINI_MODEL]) test(`${model} reuses the same endpoint, credentials and generation payload`, async () => {
  const requests = [];
  const provider = createVideoProvider({ video: { base: 'https://provider.example', project: 'project', access: 'access', secret: 'secret' } },
    async (url, options) => { requests.push({ url: String(url), headers: options.headers, body: JSON.parse(options.body) }); return Response.json({ data: { taskId: 'paid-id' } }); });
  const task = { duration: 30, ratio: '9:16', materials: { photo: { id: 'photo-id' }, video: { id: 'video-id' } } };
  await provider.generate(task); await provider.generate({ ...task, model });
  assert.equal(requests[1].body.modelId, model);
  assert.deepEqual(requests[1], { ...requests[0], body: { ...requests[0].body, modelId: model } });
});

for (const [sourceDuration, generatedDuration] of [[15.1, 20], [20, 20], [20.1, 25], [25.1, 30], [30, 30]]) {
  test(`premium replica accepts ${sourceDuration} seconds and preserves its model through generation and restart`, async t => {
    const app = await fixture(t, { probe: async () => ({ ...META, duration: sourceDuration }) });
    const id = randomUUID();
    assert.equal((await app.call('/tasks', { body: { requestId: id, model: PREMIUM_MODEL, voiceEngine: 'seedance', sourceAudioMode: 'original' } })).status, 201);
    await app.upload(id);
    assert.equal((await app.current(id)).duration, generatedDuration);
    await app.close(); await app.open();
    assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 202);
    const running = await app.until(id, task => task.status === 'running');
    assert.equal(running.model, PREMIUM_MODEL); assert.equal(running.modelName, 'qiya-2.5');
    assert.equal(app.state.body.modelId, PREMIUM_MODEL); assert.equal(app.state.body.payload.params.duration, -1);
    assert.equal(app.state.body.payload.params.scale, 'adaptive'); assert.equal(running.duration, generatedDuration);
    assert.equal(app.state.generations, 1);
    app.state.done = true;
    assert.equal((await app.until(id, task => task.status === 'completed')).model, PREMIUM_MODEL);
  });
}

for (const [model, duration, limit] of [['doubao-seedance-2-0-260128', 60.1, 60], [PREMIUM_MODEL, 60.1, 60], [FAST_MODEL, 60.1, 60], [MINI_MODEL, 60.1, 60]]) {
  test(`replica rejects a ${duration}-second video for its ${limit}-second edition before billing`, async t => {
    const app = await fixture(t, { probe: async () => ({ ...META, duration }) });
    const id = randomUUID();
    await app.call('/tasks', { body: { requestId: id, model, voiceEngine: 'seedance', sourceAudioMode: 'original' } });
    const response = await fetch(app.base + `/api/video-replica/tasks/${id}/video`, { method: 'PUT', body: VIDEO });
    assert.equal(response.status, 400); assert.match((await response.json()).error, new RegExp('2–' + limit));
    assert.equal((await app.current(id)).video, undefined); assert.equal((await app.wallet.snapshot('alice')).held, 0);
    assert.equal(app.state.generations, 0);
  });
}

test('draft edition switches recalculate automatic splitting and lock after submission', async t => {
  let duration = 4;
  const app = await fixture(t, { probe: async () => ({ ...META, duration }), scenes: async () => ({ cuts: [] }) });
  const id = await app.init(); await app.upload(id);
  assert.equal((await app.call(`/tasks/${id}/model`, { body: { model: PREMIUM_MODEL } })).status, 200);
  await app.close(); await app.open();
  assert.equal((await app.current(id)).model, PREMIUM_MODEL);
  duration = 20; await app.upload(id);
  assert.equal((await app.call(`/tasks/${id}/model`, { body: { model: 'doubao-seedance-2-0-260128' } })).status, 200);
  const draft = await app.current(id);
  assert.equal(draft.segments.total, 2); assert.equal(draft.video.duration, 20); assert.equal(draft.status, 'draft');
  assert.equal((await app.wallet.snapshot('alice')).held, 0);
  assert.equal((await app.call(`/tasks/${id}/model`, { body: { model: PREMIUM_MODEL } })).status, 200);
  assert.equal((await app.current(id)).segments, undefined);
  assert.equal((await app.call(`/tasks/${id}/model`, { body: { model: 'unknown' } })).status, 400);
  assert.equal((await app.call(`/tasks/${id}/model`, { body: { model: PREMIUM_MODEL }, owner: 'bob' })).status, 404);
  assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 202);
  await app.until(id, task => task.status === 'running');
  assert.equal((await app.call(`/tasks/${id}/model`, { body: { model: 'doubao-seedance-2-0-260128' } })).status, 409);
  assert.equal((await app.current(id)).model, PREMIUM_MODEL); assert.equal(app.state.generations, 1);
});

for (const [model, duration, limit] of [[REPLICA_PRICES[0][0], 80.266016, 60], [PREMIUM_MODEL, 80.266016, 60], [WAN3_MODEL, 80.266016, 60]]) {
  test(`${model} reports a ${Math.round(duration)}-second reference as a duration error, not a pixel error`, async t => {
    const app = await fixture(t, { config: { ...CONFIG, wan3Enabled: true },
      probe: async () => ({ ...META, duration, width: 576, height: 1024 }) });
    const id = randomUUID();
    await app.call('/tasks', { body: { requestId: id, model, voiceEngine: 'seedance' } });
    const response = await fetch(app.base + `/api/video-replica/tasks/${id}/video`, { method: 'PUT', body: VIDEO });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.code, 'VIDEO_DURATION_INVALID');
    assert.match(body.error, new RegExp(`${Number(duration.toFixed(2))} 秒`));
    assert.match(body.error, new RegExp('2–' + limit + ' 秒'));
    assert.match(body.error, /截取/);
    assert.doesNotMatch(body.error, /像素|宽高/);
    assert.equal((await app.current(id)).video, undefined);
    assert.equal(await app.wallet.reservation('alice', id), null);
    assert.equal(app.state.generations, 0);
  });
}

test('a short reference requests more duration without suggesting it should be trimmed', async t => {
  const app = await fixture(t, { probe: async () => ({ ...META, duration: 1.5 }) }), id = await app.init();
  const response = await fetch(app.base + `/api/video-replica/tasks/${id}/video`, { method: 'PUT', body: VIDEO });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, 'VIDEO_DURATION_INVALID');
  assert.match(body.error, /1\.5 秒/); assert.match(body.error, /至少 2 秒/);
  assert.doesNotMatch(body.error, /截取|像素|宽高/);
});

test('a Wan dimension rejection does not suggest a valid duration is wrong', async t => {
  const app = await fixture(t, { config: { ...CONFIG, wan3Enabled: true },
    probe: async () => ({ ...META, width: 200, height: 400 }) }), id = randomUUID();
  await app.call('/tasks', { body: { requestId: id, model: WAN3_MODEL, voiceEngine: 'seedance' } });
  const response = await fetch(app.base + `/api/video-replica/tasks/${id}/video`, { method: 'PUT', body: VIDEO });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, 'VIDEO_DIMENSIONS_INVALID');
  assert.match(body.error, /200×400 像素/); assert.doesNotMatch(body.error, /秒|截取/);
});

for (const [model] of REPLICA_PRICES) test(`${model} normalizes uploaded reference pixels before registering the video`, async t => {
  const app = await fixture(t, { probe: probeVideo });
  const source = join(app.root, 'small.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=s=350x350:r=30:d=2',
    '-c:v', 'libx264', '-threads', '1', source]);
  const id = randomUUID();
  await app.call('/tasks', { body: { requestId: id, model, voiceEngine: 'seedance', sourceAudioMode: 'original' } });
  const uploaded = await fetch(app.base + `/api/video-replica/tasks/${id}/video`, { method: 'PUT', body: await readFile(source) });
  assert.equal(uploaded.status, 200, await uploaded.text());
  const draft = await app.current(id);
  assert.ok(draft.video.width * draft.video.height >= 407696, JSON.stringify(draft.video));
  assert.equal(draft.video.width, draft.video.height);
  const normalized = await readFile(join(app.root, 'video', id, 'source.mp4'));
  await fetch(app.base + `/api/video-replica/tasks/${id}/photo`, { method: 'PUT', body: VIDEO });
  assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 202);
  await app.until(id, task => task.status === 'running');
  const reference = new URL(app.state.creates.find(item => item.kind === 'video').url);
  const served = await fetch(app.base + reference.pathname + reference.search);
  assert.equal(served.status, 200);
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), await readFile(join(app.root, 'video', id, 'source.mp4')));
  assert.deepEqual(await readFile(join(app.root, 'video', id, 'source.mp4')), normalized);
  assert.ok((await probeVideo(join(app.root, 'video', id, 'source.mp4'))).width >= 640);
});

test('Seedance also accepts a reference with a side below 300 pixels', async t => {
  const app = await fixture(t, { probe: probeVideo }), id = await app.init();
  const source = join(app.root, 'small.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=s=160x240:r=30:d=2',
    '-c:v', 'libx264', '-threads', '1', source]);
  const response = await fetch(app.base + `/api/video-replica/tasks/${id}/video`, { method: 'PUT', body: await readFile(source) });
  assert.equal(response.status, 200, await response.text());
  const { video } = await app.current(id);
  assert.ok(video.width >= 300 && video.height >= 300 && video.width * video.height >= 407696);
});

test('switching a Wan draft to Seedance normalizes before billing and preserves confirmed speech', async t => {
  const app = await fixture(t, { probe: probeVideo, config: { ...CONFIG, wan3Enabled: true } });
  const source = join(app.root, 'small.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=s=350x350:r=30:d=2',
    '-c:v', 'libx264', '-threads', '1', source]);
  const bytes = await readFile(source), id = randomUUID();
  await app.call('/tasks', { body: { requestId: id, model: WAN3_MODEL, voiceEngine: 'seedance' } });
  assert.equal((await fetch(app.base + `/api/video-replica/tasks/${id}/video`, { method: 'PUT', body: bytes })).status, 200);
  assert.deepEqual(await readFile(join(app.root, 'video', id, 'source.mp4')), bytes, 'Wan uploads keep their own pixel policy');
  await fetch(app.base + `/api/video-replica/tasks/${id}/photo`, { method: 'PUT', body: VIDEO });
  await app.close();
  const path = join(app.root, 'video', id, 'task.json'), saved = JSON.parse(await readFile(path));
  saved.speech = { source: 'subtitles', text: '用户确认的台词', segments: [] }; saved.speechConfirmedAt = 123;
  saved.captionsChecked = true; saved.captions = { width: 350, height: 350, cues: [] };
  await writeFile(path, JSON.stringify(saved)); await app.open();
  assert.equal((await app.call(`/tasks/${id}/model`, { body: { model: PREMIUM_MODEL } })).status, 200);
  assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 202);
  const running = await app.until(id, task => task.status === 'running');
  assert.equal(running.video.width, 640); assert.equal(running.video.height, 640);
  assert.equal(running.speech.text, '用户确认的台词');
  assert.equal(JSON.parse(await readFile(path)).speechConfirmedAt, 123);
  assert.equal(app.state.generations, 1);
});

test('an old Seedance draft with invalid pixels is repaired after restart', async t => {
  const app = await fixture(t), id = await app.init(); await app.upload(id);
  await app.close();
  const source = join(app.root, 'video', id, 'source.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=s=160x240:r=30:d=2',
    '-c:v', 'libx264', '-threads', '1', source]);
  const path = join(app.root, 'video', id, 'task.json'), saved = JSON.parse(await readFile(path));
  saved.video = await probeVideo(source); await writeFile(path, JSON.stringify(saved)); await app.open();
  assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 202);
  const running = await app.until(id, task => task.status === 'running');
  assert.ok(running.video.width * running.video.height >= 407696);
  assert.deepEqual(running.video, await probeVideo(source));
});

test('failed pixel normalization leaves the previous source intact and never bills or dispatches', async t => {
  let metadata = META;
  const app = await fixture(t, { probe: async () => metadata }), id = await app.init(); await app.upload(id);
  const source = join(app.root, 'video', id, 'source.mp4'), original = await readFile(source);
  metadata = { ...META, width: 350, height: 350 };
  const response = await fetch(app.base + `/api/video-replica/tasks/${id}/video`, { method: 'PUT', body: VIDEO });
  assert.equal(response.status, 422); assert.equal((await response.json()).code, 'VIDEO_NORMALIZE_FAILED');
  assert.deepEqual((await app.current(id)).video, META);
  assert.deepEqual(await readFile(source), original);
  await app.close();
  const path = join(app.root, 'video', id, 'task.json'), saved = JSON.parse(await readFile(path));
  saved.video = metadata; await writeFile(path, JSON.stringify(saved)); await app.open();
  const started = await app.call(`/tasks/${id}/start`, { body: {} });
  assert.equal(started.status, 422); assert.equal((await started.json()).code, 'VIDEO_NORMALIZE_FAILED');
  assert.equal((await app.current(id)).status, 'draft');
  assert.equal(await app.wallet.reservation('alice', id), null);
  assert.equal(app.state.creates.length, 0); assert.equal(app.state.generations, 0);
  assert.deepEqual(await readFile(source), original);
});

for (const [model, name] of REPLICA_PRICES) test(`${name} quotes, reserves and settles its model price across restart exactly once`, async t => {
  const pricing = generationPrice('video', model), points = pricing.pointsPerSecond * 4;
  const app = await fixture(t, { costMode: true }), id = randomUUID();
  assert.equal((await app.call('/tasks', { body: { requestId: id, model, voiceEngine: 'seedance', sourceAudioMode: 'original' } })).status, 201); await app.upload(id);
  assert.equal((await app.current(id)).estimatedPoints, points);
  assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 202);
  const running = await app.until(id, task => task.status === 'running');
  assert.equal(running.modelName, name); assert.equal(app.state.body.modelId, model);
  const record = await app.wallet.reservation('alice', id);
  assert.equal(record.pricingKey, pricing.key);
  assert.equal(record.reservedUnits, 4);
  assert.equal((await app.wallet.snapshot('alice')).held, points);
  await app.close(); await app.open();
  assert.equal((await app.current(id)).estimatedPoints, points);
  app.state.done = true;
  const done = await app.until(id, task => task.status === 'completed' && task.billing.status === 'settled');
  assert.equal(done.billing.chargedPoints, points); assert.equal(done.billing.mode, 'model_price');
  await app.call(`/tasks/${id}/start`, { body: {} });
  assert.equal(app.state.generations, 1); assert.equal((await app.wallet.snapshot('alice')).available, TEST_BALANCE - points);
});

test('switching a draft recalculates its quote for every replica model', async t => {
  const app = await fixture(t, { costMode: true }), id = await app.init(); await app.upload(id);
  for (const [model, name] of REPLICA_PRICES) {
    const response = await app.call(`/tasks/${id}/model`, { body: { model } });
    assert.equal(response.status, 200);
    const { task } = await response.json();
    assert.equal(task.modelName, name); assert.equal(task.estimatedPoints, generationPrice('video', model).pointsPerSecond * 4);
    assert.equal((await app.wallet.snapshot('alice')).held, 0);
  }
});

test('an already submitted premium task without a price snapshot keeps its original 1 CNY rate', async t => {
  const app = await fixture(t, { costMode: true }), id = await app.init(); await app.upload(id); await app.close();
  const scope = { userId: 'alice', taskId: id };
  await app.wallet.reserveCost(scope);
  await app.wallet.prepareCostCall({ ...scope, receiptId: 'seedance', quoteCny: 4, provider: 'video-replica',
    metadata: { model: PREMIUM_MODEL, currency: 'CNY', unitPrice: 1 } });
  const path = join(app.root, 'video', id, 'task.json'), task = JSON.parse(await readFile(path, 'utf8'));
  Object.assign(task, { model: PREMIUM_MODEL, status: 'running', startedAt: Date.now(), providerId: 'old-premium',
    providerDispatched: true, seedanceCostPrepared: true, billing: { mode: 'api_cost', status: 'reserved', reservedPoints: 500 } });
  await writeFile(path, JSON.stringify(task)); await app.open();
  assert.equal((await app.current(id)).estimatedPoints, 500);
  app.state.done = true;
  const done = await app.until(id, task => task.status === 'completed' && task.billing.status === 'settled');
  assert.equal(done.billing.chargedPoints, 500); assert.equal(done.billing.costCny, 4);
  assert.equal(app.state.generations, 0);
});

for (const [model, duration, status, points] of [[PREMIUM_MODEL, 8, 402, 0], [MINI_MODEL, 4, 202, 820]]) test(`${model} checks affordability at its own rate`, async t => {
  const app = await fixture(t, { costMode: true, balance: 1000, probe: async () => ({ ...META, duration }) }), id = await app.init(); await app.upload(id);
  const response = await app.call(`/tasks/${id}/start`, { body: { model } });
  assert.equal(response.status, status);
  if (status === 202) await app.until(id, task => task.status === 'running');
  assert.equal((await app.wallet.snapshot('alice')).held, points);
  assert.equal(app.state.generations, status === 202 ? 1 : 0);
});

const SPEECH = { engine: 'silero-vad+whisper-1', start: 1.25, end: 3.5, text: '你好世界',
  segments: [{ start: 1.25, end: 3.5, text: '你好世界', words: [{ word: '你好', start: 1.25, end: 2.2 }, { word: '世界', start: 2.2, end: 3.5 }] }] };
function fakeSpeech(overrides = {}) { return { enabled: true, detect: async () => [{ start: 0.2, end: 2.5 }],
  analyze: async () => SPEECH, align: async (_source, output) => { await writeFile(output, VIDEO); return { transcriptMatched: true }; }, ...overrides }; }
async function uploadVoice(app, id) {
  const response = await fetch(app.base + `/api/video-replica/tasks/${id}/voice`, { method: 'PUT', body: VIDEO });
  assert.equal(response.status, 200, await response.text());
}

async function localizedReplica(t, { source = 'zh', target = 'en', confidence = .99, outputLanguage = target,
  uncertain = false, disconnected = false } = {}) {
  const counts = { conversions: 0, translations: 0, lipSubmits: 0, lipQueries: 0 }, text = 'Hello everyone';
  const app = await fixture(t, { speech: fakeSpeech({ analyze: async path => ({ ...structuredClone(SPEECH),
    text, language: path.endsWith('localized-voice.wav') ? outputLanguage : source, languageConfidence: confidence }) }),
    voice: async (_input, output) => { await writeFile(output, VIDEO); return { duration: 3 }; },
    voiceConversion: { enabled: true, advance: async (task, folder, save) => {
      counts.conversions++; task.voiceConversion = { ready: true, duration: 4 };
      await writeFile(join(folder, 'converted-voice.wav'), 'ORIGINAL'); await save();
    }, mux: async (_video, audio, output) => writeFile(output, await readFile(audio)) },
    localization: { enabled: !disconnected, advance: async (task, folder, save) => {
      counts.translations++; task.localization = { ready: true, duration: 4, text, segments: [{ status: 'ready' }] };
      await writeFile(join(folder, 'localized-voice.wav'), 'TRANSLATED'); await save();
    }, mux: async (_video, audio, output) => writeFile(output, await readFile(audio)) },
    heygen: { enabled: !disconnected, submit: async () => {
      counts.lipSubmits++;
      if (uncertain) throw new VideoError('Submission uncertain', 502, 'VIDEO_LIPSYNC_UNCERTAIN');
      return { id: 'ls_test', provider: 'heygen' };
    }, query: async () => { counts.lipQueries++; return app.state.lipDone ? 'https://files.heygen.ai/output.mp4' : null; } },
  });
  const id = randomUUID();
  assert.equal((await app.call('/tasks', { body: { requestId: id, targetLanguage: target } })).status, 201);
  await app.upload(id); await uploadVoice(app, id);
  return { ...app, id, counts };
}

async function restoreStartedTranslation(app, targetLanguage, overrides = {}) {
  await app.close();
  const path = join(app.root, 'video', app.id, 'task.json'), task = JSON.parse(await readFile(path, 'utf8'));
  const pricingKey = generationPrice('video', task.model).key;
  const record = await app.wallet.reserve({ userId: 'alice', taskId: app.id, kind: 'video', units: task.duration, pricingKey });
  Object.assign(task, { targetLanguage, status: 'preparing', startedAt: Date.now(), recoveryPolicy: 1,
    recoveryDeadline: Date.now() + 30 * 60_000, pricingKey,
    billing: { status: record.status, reservedPoints: record.reservedPoints, chargedPoints: record.chargedPoints, mode: 'model_price', pricingKey } });
  await writeFile(path, JSON.stringify(task)); await app.open(overrides);
}

for (const source of ['zh', 'en', 'ms']) for (const target of ['zh', 'en', 'ms']) {
  test(`source ${source} keeps original conversion despite cached target ${target}, including restart`, async t => {
    const app = await localizedReplica(t, { source, target });
    await app.close(); await app.open();
    assert.equal((await app.current(app.id)).targetLanguage, undefined);
    assert.equal((await app.call(`/tasks/${app.id}/start`, { body: { targetLanguage: target } })).status, 202);
    const running = await app.until(app.id, task => task.status === 'running');
    assert.equal(running.languageRouting, undefined); assert.equal(running.targetLanguage, undefined);
    assert.equal(running.speech, undefined);
    assert.equal(app.counts.conversions, 1); assert.equal(app.counts.translations, 0);
    await app.close(); await app.open();
    app.state.done = true;
    const completed = await app.until(app.id, task => task.status === 'completed');
    assert.equal(completed.audioCheck.lipSync, 'needs_preview');
    assert.equal(app.counts.lipSubmits, 0); assert.equal(app.counts.conversions, 1);
    assert.equal(app.state.generations, 1);
    assert.equal(Buffer.from(await (await app.call(`/tasks/${app.id}/result`)).arrayBuffer()).toString(), 'ORIGINAL');
  });
}

for (const overrides of [{ source: 'und' }, { source: 'ind', confidence: .3 }]) {
  test(`source language uncertainty does not block original conversion: ${JSON.stringify(overrides)}`, async t => {
    const app = await localizedReplica(t, { ...overrides, disconnected: true });
    app.state.done = true;
    await app.call(`/tasks/${app.id}/start`, { body: {} });
    assert.equal((await app.until(app.id, task => task.status === 'completed')).audioCheck.engine, 'chatterbox');
    assert.equal(app.counts.conversions, 1); assert.equal(app.counts.translations, 0); assert.equal(app.counts.lipSubmits, 0);
  });
}

test('an already-started legacy HeyGen submission stays held after restart without a second paid call', async t => {
  const app = await localizedReplica(t, { uncertain: true });
  app.state.done = true;
  await restoreStartedTranslation(app, 'en');
  assert.equal((await app.until(app.id, task => task.status === 'waiting')).canResume, false);
  await app.close(); await app.open();
  await app.call(`/tasks/${app.id}/resume`, { body: {} });
  assert.equal((await app.current(app.id)).status, 'waiting');
  assert.equal(app.counts.lipSubmits, 1); assert.equal(app.state.generations, 1);
});

test('an already-started Malay translation finishes with its original audio and paid-job state', async t => {
  const app = await localizedReplica(t, { source: 'zh', target: 'ms', outputLanguage: 'ind' });
  app.state.done = true; app.state.lipDone = true;
  await restoreStartedTranslation(app, 'ms');
  assert.equal((await app.until(app.id, task => task.status === 'completed')).audioCheck.language, 'ms');
  assert.equal(app.counts.lipSubmits, 1);
});

test('legacy translation delivers without output ASR or duration comparisons', async t => {
  const app = await localizedReplica(t);
  app.state.done = true; app.state.lipDone = true;
  await restoreStartedTranslation(app, 'en', { speech: fakeSpeech({ analyze: async path => {
    assert(path.endsWith('source.mp4'), 'Generated narration must not be transcribed again');
    return { ...structuredClone(SPEECH), language: 'zh', languageConfidence: .99 };
  } }), probe: async path => ({ ...META, duration: path.endsWith('lipsync.mp4') ? 2 : 3 }) });
  const completed = await app.until(app.id, task => task.status === 'completed');
  assert.equal(completed.audioCheck.language, 'en');
  assert.equal(completed.actualDuration, 3);
  assert.equal(app.counts.lipSubmits, 1); assert.equal(app.state.generations, 1);
});

test('old draft language choices are cleared at start and the retired language endpoint cannot re-enable translation', async t => {
  const app = await localizedReplica(t);
  const config = await (await app.call('/config')).json();
  assert.equal(config.languages, undefined); assert.equal(config.localizationEnabled, undefined);
  assert.equal((await app.call(`/tasks/${app.id}/language`, { body: { targetLanguage: 'ms' } })).status, 410);
  await app.close();
  const path = join(app.root, 'video', app.id, 'task.json'), task = JSON.parse(await readFile(path, 'utf8'));
  Object.assign(task, { targetLanguage: 'ms', languageRouting: { source: 'zh', target: 'ms', translate: true },
    languageDetection: { pending: true }, localization: { failed: true } });
  await writeFile(path, JSON.stringify(task)); await app.open();
  assert.equal((await app.current(app.id)).targetLanguage, 'ms');
  assert.equal((await app.call(`/tasks/${app.id}/start`, { body: { targetLanguage: 'xx' } })).status, 202);
  const running = await app.until(app.id, task => task.status === 'running');
  assert.equal(running.targetLanguage, undefined); assert.equal(running.localizationProgress, undefined);
  assert.equal(app.counts.conversions, 1); assert.equal(app.counts.translations, 0);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  for (const key of ['targetLanguage', 'languageRouting', 'languageDetection', 'localization']) assert.equal(saved[key], undefined);
});

const CAPTIONS = { engine: 'rapidocr', kind: 'burned', width: 512, height: 768, cues: [
  { start: 0.3, end: 1.5, text: '生腌真好吃', box: [100, 550, 412, 600] },
  { start: 2, end: 3.5, text: '只要9.9元', box: [100, 550, 412, 600] },
] };

test('original captions supply the script and final subtitles even without a reference voice', async t => {
  let extracts = 0, cleaned = 0, rendered;
  const app = await fixture(t, { speech: fakeSpeech({ detect: async () => [{ start: 0.16, end: 1.4 }, { start: 2.1, end: 3.4 }],
    analyze: async () => { assert.fail('Caption text must not come from ASR'); } }), captions: {
    extract: async () => { extracts++; return structuredClone(CAPTIONS); },
    clean: async (_input, output) => { cleaned++; await writeFile(output, Buffer.from('clean-video')); },
    render: async (_input, output, captions) => { rendered = captions; await writeFile(output, VIDEO); },
  } });
  const id = await app.init(); await app.upload(id);
  const analyzed = (await (await app.call(`/tasks/${id}/analyze`, { body: {} })).json()).task;
  assert.equal(analyzed.speech.source, 'subtitles'); assert.equal(analyzed.speech.start, 0.16);
  assert.equal(analyzed.speech.text, '生腌真好吃只要9.9元'); assert.deepEqual(analyzed.captions, CAPTIONS);
  const edited = (await (await app.call(`/tasks/${id}/speech`, { body: { segments: [{ text: '生腌特别好吃' }, { text: '只要9.9元' }] } })).json()).task;
  assert.equal(edited.speech.text, '生腌特别好吃只要9.9元');
  assert.deepEqual(edited.speech.segments.map(segment => [segment.start, segment.end]), [[0.16, 1.4], [2.1, 3.4]]);
  assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 202);
  await app.until(id, task => task.status === 'running');
  assert.match(app.state.body.prompt, /台词来自原视频字幕/); assert.match(app.state.body.prompt, /生腌特别好吃/);
  assert.equal('referAudioUrl' in app.state.body.payload, false);
  const signed = new URL(app.state.creates.find(item => item.kind === 'video').url);
  assert.deepEqual(Buffer.from(await (await fetch(app.base + signed.pathname + signed.search)).arrayBuffer()), VIDEO);
  assert.deepEqual(Buffer.from(await (await app.call(`/tasks/${id}/video`)).arrayBuffer()), VIDEO);
  app.state.done = true;
  const completed = await app.until(id, task => task.status === 'completed');
  assert.equal(completed.captionCheck.rendered, true); assert.equal(completed.captionCheck.cueCount, 2);
  assert.equal(rendered.cues[0].text, '生腌特别好吃'); assert.equal(rendered.cues[0].start, .3);
  assert.equal(extracts, 1); assert.equal(cleaned, 0); assert.equal(app.state.generations, 1);
  assert.equal(completed.billing.status, 'settled');
});

test('captions with no source audio still provide narration and changing the source invalidates them', async t => {
  const app = await fixture(t, { probe: async () => ({ ...META, audio: false }),
    captions: { extract: async () => structuredClone(CAPTIONS) },
    speech: fakeSpeech({ analyze: async () => assert.fail('No ASR needed'), detect: async () => assert.fail('No audio') }) });
  const id = await app.init(); await app.upload(id);
  const analyzed = (await (await app.call(`/tasks/${id}/analyze`, { body: {} })).json()).task;
  assert.equal(analyzed.speech.text, '生腌真好吃只要9.9元'); assert.equal(analyzed.speech.start, .3);
  await fetch(app.base + `/api/video-replica/tasks/${id}/video`, { method: 'PUT', body: VIDEO });
  const replaced = await app.current(id);
  assert.equal(replaced.captions, undefined); assert.equal(replaced.speech, undefined); assert.equal(replaced.captionsChecked, undefined);
});

test('preserved model subtitles retain their delivery metadata and playable media', async t => {
  const check = { rendered: false, preserved: true, source: 'model', cueCount: 2 };
  const app = await fixture(t, { speech: fakeSpeech(), captions: {
    extract: async () => structuredClone(CAPTIONS),
    render: async (input, output) => { await writeFile(output, await readFile(input)); return check; },
  } });
  const id = await app.init(); await app.upload(id);
  await app.call(`/tasks/${id}/start`, { body: {} });
  await app.until(id, task => task.status === 'running'); app.state.done = true;
  const completed = await app.until(id, task => task.status === 'completed' && task.billing.status === 'settled');
  assert.deepEqual(completed.captionCheck, check);
  assert.deepEqual(Buffer.from(await (await app.call(`/tasks/${id}/result`)).arrayBuffer()), VIDEO);
  assert.equal(completed.speech.text, '生腌真好吃只要9.9元');
  assert.equal(app.state.generations, 1);
});

test('caption extraction and rendering failures deliver the playable model result without extra generation', async t => {
  for (const stage of ['extract', 'render']) await t.test(stage, async t => {
    const app = await fixture(t, { captions: {
      extract: async () => { if (stage === 'extract') throw new Error('OCR unavailable'); return structuredClone(CAPTIONS); },
      render: async (_input, output) => { if (stage === 'render') throw new Error('Renderer unavailable'); await writeFile(output, VIDEO); },
    } });
    const id = await app.init(); await app.upload(id);
    assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 202);
    await app.until(id, task => task.status === 'running'); app.state.done = true;
    const completed = await app.until(id, task => task.status === 'completed');
    assert.equal(app.state.generations, 1); assert.equal(completed.billing.status, 'settled');
    assert.deepEqual(Buffer.from(await (await app.call(`/tasks/${id}/result`)).arrayBuffer()), VIDEO);
    if (stage === 'render') assert.equal(completed.captionCheck.rendered, false);
    assert.match(completed.captionCheck.warning, /字幕/);
  });
});

test('uploaded voice uses caption words and preserves the original emotional audio and subtitle pixels', async t => {
  let alignmentReference;
  const app = await fixture(t, { voice: async (_input, output) => { await writeFile(output, VIDEO); return { ready: true, duration: 3 }; },
    speech: fakeSpeech({ detect: async () => [{ start: .16, end: 3.5 }],
      align: async (_input, output, original) => { alignmentReference = original; await writeFile(output, VIDEO); return {}; } }),
    captions: { extract: async () => structuredClone(CAPTIONS), clean: async () => assert.fail('Do not inpaint the model input'),
      render: async (_input, output) => writeFile(output, VIDEO) } });
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id);
  await app.call(`/tasks/${id}/start`, { body: {} });
  const running = await app.until(id, task => task.status === 'running');
  assert.equal(running.speech.source, 'subtitles');
  assert.deepEqual(app.state.body.payload.referAudioUrl, ['asset://voice-id']);
  assert.match(app.state.body.prompt, /生腌真好吃只要9.9元/);
  const signed = new URL(app.state.creates.find(item => item.kind === 'video').url);
  assert.deepEqual(Buffer.from(await (await fetch(app.base + signed.pathname + signed.search)).arrayBuffer()), VIDEO);
  app.state.done = true; const completed = await app.until(id, task => task.status === 'completed');
  assert.equal(alignmentReference.text, '生腌真好吃只要9.9元'); assert.equal(completed.captionCheck.rendered, true);
});

test('direct voice replacement gives the model a compliant source with its unmodified emotional audio track', async t => {
  const app = await fixture(t, { probe: probeVideo,
    voice: async (_input, output) => { await writeFile(output, VIDEO); return { ready: true, duration: 3 }; }, speech: fakeSpeech() });
  const source = join(app.root, 'emotional-source.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x960:r=25:d=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-af', 'volume=0.3:enable=between(t\\,1\\,2)',
    '-c:v', 'libx264', '-threads', '2', '-c:a', 'aac', source]);
  const input = await readFile(source), id = await app.init();
  for (const [kind, bytes] of [['video', input], ['photo', VIDEO]]) {
    const response = await fetch(app.base + `/api/video-replica/tasks/${id}/${kind}`, { method: 'PUT', body: bytes });
    assert.equal(response.status, 200);
  }
  await uploadVoice(app, id); await app.call(`/tasks/${id}/start`, { body: {} });
  await app.until(id, task => task.status === 'running');
  const signed = new URL(app.state.creates.find(item => item.kind === 'video').url);
  const supplied = Buffer.from(await (await fetch(app.base + signed.pathname + signed.search)).arrayBuffer());
  assert.deepEqual(supplied, input, 'The model must receive the original audio and picture bytes');
  const copy = join(app.root, 'supplied.mp4'); await writeFile(copy, supplied);
  assert.equal((await probeVideo(copy)).audio, true);
  assert.deepEqual(app.state.body.payload.referAudioUrl, ['asset://voice-id']);
  assert.equal(app.state.generations, 1);
});

test('reference voice detection no longer rejects empty or short speech detection', async t => {
  for (const intervals of [[], [{ start: 0.2, end: 0.3 }]]) await t.test(JSON.stringify(intervals), async t => {
    const app = await fixture(t, { voice: async (_input, output) => { await writeFile(output, VIDEO); return { ready: true, duration: 3 }; },
      speech: fakeSpeech({ detect: async () => intervals }) });
    const id = await app.init(); await app.upload(id); await uploadVoice(app, id);
    assert.equal((await app.call(`/tasks/${id}/analyze`, { body: {} })).status, 200);
    assert.equal((await app.call(`/tasks/${id}/start`, { body: { speechConfirmed: true } })).status, 202);
    await app.until(id, task => task.status === 'running'); assert.equal(app.state.generations, 1);
  });
});

test('one-click voice generation analyzes automatically and reaches the provider as an audio material', async t => {
  const app = await fixture(t, { voice: async (_input, output) => { await writeFile(output, VIDEO); return { ready: true, duration: 3 }; }, speech: fakeSpeech() });
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id);
  assert.equal((await app.call(`/tasks/${id}/voice`, { owner: 'bob' })).status, 404);
  assert.equal((await app.current(id)).speech, undefined);
  assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 202);
  assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 200);
  const running = await app.until(id, task => task.status === 'running');
  assert.equal(running.speech.start, 1.25);
  assert.deepEqual(app.state.body.payload.referAudioUrl, ['asset://voice-id']);
  assert.match(app.state.body.prompt, /1\.250 秒/); assert.match(app.state.body.prompt, /你好世界/);
  const signed = new URL(app.state.creates.find(item => item.kind === 'voice').url);
  const response = await fetch(app.base + signed.pathname + signed.search);
  assert.equal(response.headers.get('content-type'), 'audio/wav'); assert.equal(response.status, 200);
  const signedVideo = new URL(app.state.creates.find(item => item.kind === 'video').url);
  const providerVideo = await fetch(app.base + signedVideo.pathname + signedVideo.search);
  assert.deepEqual(Buffer.from(await providerVideo.arrayBuffer()), VIDEO);
  assert.deepEqual(Buffer.from(await (await app.call(`/tasks/${id}/video`)).arrayBuffer()), VIDEO);
  app.state.done = true;
  const completed = await app.until(id, task => task.status === 'completed');
  assert.equal(completed.audioCheck.afterOffsetMs, 0); assert.equal(completed.audioCheck.lipSync, 'needs_preview');
  assert.equal(app.state.generations, 1);
});

test('start returns before slow caption analysis and repeated starts generate only once', async t => {
  let release, entered;
  const waiting = new Promise(resolve => { release = resolve; });
  const analyzing = new Promise(resolve => { entered = resolve; });
  let extracts = 0;
  t.after(release);
  const app = await fixture(t, { captions: { extract: async () => { extracts++; entered(); await waiting; return null; } } });
  const id = await app.init(); await app.upload(id);
  const response = await app.call(`/tasks/${id}/start`, { body: {} });
  assert.equal(response.status, 202); assert.equal((await response.json()).task.status, 'preparing');
  await analyzing;
  assert.equal((await app.current(id)).status, 'preparing'); assert.equal(app.state.generations, 0);
  const duplicate = app.call(`/tasks/${id}/start`, { body: {} });
  release(); assert.equal((await duplicate).status, 200);
  await app.until(id, task => task.status === 'running');
  assert.equal(extracts, 1); assert.equal(app.state.generations, 1);
});

test('a restart resumes automatic preparation and retains one reservation and one generation', async t => {
  const app = await fixture(t, { voice: async (_input, output) => { await writeFile(output, VIDEO); return { ready: true, duration: 3 }; }, speech: fakeSpeech() });
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id); await app.close();
  const path = join(app.root, 'video', id, 'task.json');
  const task = JSON.parse(await readFile(path, 'utf8'));
  task.billing = await app.wallet.reserve({ userId: 'alice', taskId: id, kind: 'video', units: task.duration });
  task.status = 'preparing'; task.startedAt = Date.now();
  await writeFile(path, JSON.stringify(task)); await app.open();
  const running = await app.until(id, task => task.status === 'running');
  assert.equal(running.speech.start, 1.25); assert.equal(app.state.generations, 1);
  assert.equal((await app.wallet.snapshot('alice')).held, 45);
  assert.deepEqual(app.state.body.payload.referAudioUrl, ['asset://voice-id']);
  app.state.done = true; await app.until(id, task => task.status === 'completed' && task.billing.status === 'settled');
  assert.equal((await app.wallet.snapshot('alice')).available, TEST_BALANCE - 45);
});

test('failed automatic voice preparation releases the hold without a model dispatch', async t => {
  const app = await fixture(t, { voice: async (_input, output) => { await writeFile(output, VIDEO); return { ready: true, duration: 3 }; },
    speech: fakeSpeech({ analyze: async () => { throw Object.assign(new Error('ASR unavailable'), { code: 'VIDEO_SPEECH_FAILED' }); } }) });
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id);
  assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 202);
  const failed = await app.until(id, task => task.status === 'failed' && task.billing?.status === 'released');
  assert.equal(failed.code, 'VIDEO_SPEECH_FAILED'); assert.equal(app.state.generations, 0);
  assert.equal((await app.wallet.snapshot('alice')).available, TEST_BALANCE);
});

test('previously submitted H3 Max tasks can still finish without creating another generation', async t => {
  const requests = [];
  const falProvider = createFalVideoProvider({ falKey: 'private-fal-key' }, async (url, options) => {
    requests.push({ url: String(url), ...options });
    assert.equal(options.method, 'GET');
    return Response.json(String(url).endsWith('/status') ? { status: 'COMPLETED' } : { video: { url: 'https://v3.fal.media/result.mp4' } });
  });
  const app = await fixture(t, { config: { ...CONFIG, falKey: 'private-fal-key' }, falProvider });
  const id = await app.init(); await app.upload(id); await app.close();
  const path = join(app.root, 'video', id, 'task.json');
  const task = JSON.parse(await readFile(path, 'utf8'));
  const reservation = await app.wallet.reserve({ userId: 'alice', taskId: id, kind: 'video', units: task.duration });
  Object.assign(task, { model: FAL_MODEL, status: 'running', startedAt: Date.now(), providerId: 'fal-live-test',
    falQueue: { status: 'https://queue.fal.run/minimax/h3-max/requests/fal-live-test/status', result: 'https://queue.fal.run/minimax/h3-max/requests/fal-live-test' },
    billing: { status: reservation.status, reservedPoints: reservation.reservedPoints, chargedPoints: reservation.chargedPoints } });
  await writeFile(path, JSON.stringify(task)); await app.open();
  const completed = await app.until(id, task => task.status === 'completed' && task.billing.status === 'settled');
  assert.equal(completed.model, FAL_MODEL); assert.equal(completed.modelName, '极速模型'); assert.equal(completed.resolution, '768p');
  assert.deepEqual(Buffer.from(await (await app.call(`/tasks/${id}/result`)).arrayBuffer()), VIDEO);
  assert.ok(requests.length >= 2); assert.ok(requests.every(request => request.method === 'GET'));
  assert.equal(app.state.generations, 0); assert.equal(app.state.creates.length, 0);
  assert.equal((await app.wallet.snapshot('alice')).available, TEST_BALANCE - 45);
});

test('previously submitted Wan tasks still download and settle actual costs without another generation', async t => {
  const requests = [];
  const app = await fixture(t, { costMode: true, config: { ...CONFIG, falEnabled: true, falKey: 'test-key' },
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), method: options.method });
      assert.equal(options.method, 'GET');
      return Response.json(String(url).endsWith('/status') ? { status: 'COMPLETED' }
        : { video: { url: 'https://fal.media/wan-result.mp4' } }, { headers: { 'x-fal-billable-units': '6' } });
    } });
  const id = await app.init(); await app.upload(id); await app.close();
  const path = join(app.root, 'video', id, 'task.json');
  const task = JSON.parse(await readFile(path, 'utf8'));
  const scope = { userId: 'alice', taskId: id };
  await app.wallet.reserveCost(scope);
  await app.wallet.prepareCostCall({ ...scope, receiptId: 'wan-saved', quoteCny: 5, provider: 'fal',
    metadata: { model: WAN_MODEL, currency: 'USD', unitPrice: 0.08, fx: 5 } });
  const reservation = await app.wallet.finishCostCall({ ...scope, receiptId: 'wan-saved',
    providerRequestId: 'wan-saved', uncertain: true });
  Object.assign(task, { model: WAN_MODEL, status: 'running', startedAt: Date.now(),
    providerId: 'wan-saved', providerDispatched: true,
    falQueue: { status: 'https://queue.fal.run/fal-ai/wan/requests/wan-saved/status',
      result: 'https://queue.fal.run/fal-ai/wan/requests/wan-saved' },
    billing: { mode: 'api_cost', status: reservation.status, reservedPoints: reservation.reservedPoints,
      chargedPoints: reservation.chargedPoints } });
  await writeFile(path, JSON.stringify(task)); await app.open();
  const completed = await app.until(id, task => task.status === 'completed' && task.billing.status === 'settled');
  assert.equal(completed.model, WAN_MODEL); assert.equal(completed.modelName, 'Wan 2.2 人物替换');
  assert.equal(completed.billing.costCny, 2.4); assert.equal(completed.billing.chargedPoints, 300);
  assert.deepEqual(Buffer.from(await (await app.call(`/tasks/${id}/result`)).arrayBuffer()), VIDEO);
  assert.ok(requests.length >= 2); assert.ok(requests.every(request => request.method === 'GET'));
  assert.equal(app.state.generations, 0); assert.equal(app.state.creates.length, 0);
  assert.equal((await app.wallet.snapshot('alice')).held, 0);
});

test('all four Seedance editions are offered and removed models cannot start or reserve points even with a fal key', async t => {
  const app = await fixture(t, { costMode: true, config: { ...CONFIG, falEnabled: true, falKey: 'private-fal-key' } });
  const config = await (await app.call('/config')).json();
  assert.deepEqual(config.models.slice(0, 4).map(model => [model.id, model.name, model.cnyPerSecond]), REPLICA_PRICES);
  assert.deepEqual(config.models.map(model => [model.enabled, model.maxDuration]), [[true, 15], [true, 30], [true, 15], [true, 15], [false, 15], [false, 15]]);
  assert.deepEqual(config.models[1].durations, [4, 5, 6, 8, 10, 12, 15, 20, 25, 30]);
  assert.equal(config.models[0].description, '单段最多15秒，整条最多60秒，1元/秒');
  assert.equal(config.models[1].description, '单段最多30秒，整条最多60秒，1.5元/秒');
  assert.deepEqual(config.models.map(model => model.extendedDuration), [60, 60, 60, 60, 60, 60]);
  assert.equal(config.model, 'doubao-seedance-2-0-260128');
  assert.ok(!JSON.stringify(config).includes('private-fal-key'));
  const id = await app.init(); await app.upload(id);
  for (const model of [FAL_MODEL, WAN_MODEL, 'unknown']) {
    for (const path of ['/tasks', `/tasks/${id}/model`, `/tasks/${id}/start`]) {
      const response = await app.call(path, { body: { requestId: randomUUID(), model } });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, 'VIDEO_MODEL_INVALID');
    }
  }
  assert.equal((await app.current(id)).status, 'draft');
  assert.equal(app.state.generations, 0); assert.equal((await app.wallet.snapshot('alice')).held, 0);
});

test('a fal key alone does not enable the direct-voice creation UI while legacy requests remain compatible', async t => {
  const app = await fixture(t, { costMode: true, config: { ...CONFIG, enabled: false, falEnabled: true, falKey: 'private-fal-key' } });
  const config = await (await app.call('/config')).json();
  assert.equal(config.enabled, false);
  assert.deepEqual(config.models.filter(model => model.enabled).map(model => model.id), []);
  assert.equal((await app.call('/tasks', { body: { requestId: randomUUID() } })).status, 503);
  assert.equal((await app.call('/tasks', { body: { requestId: randomUUID(), model: PIXVERSE_MODEL } })).status, 201);
  assert.equal((await app.call('/tasks', { body: { requestId: randomUUID(), model: WAN_MODEL } })).status, 400);
});

for (const model of [FAL_MODEL, WAN_MODEL]) test(`an old ${model} draft can replace its video before starting with the standard edition`, async t => {
  const app = await fixture(t);
  const id = await app.init(); await app.upload(id); await app.close();
  const path = join(app.root, 'video', id, 'task.json');
  const task = JSON.parse(await readFile(path, 'utf8'));
  task.model = model; await writeFile(path, JSON.stringify(task)); await app.open();
  await app.upload(id);
  assert.equal((await app.current(id)).model, 'doubao-seedance-2-0-260128');
  assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 202);
  const running = await app.until(id, task => task.status === 'running');
  assert.equal(running.model, 'doubao-seedance-2-0-260128'); assert.equal(app.state.generations, 1);
});

test('a replacement video invalidates voice analysis and a broken audio processor refunds credits', async t => {
  const app = await fixture(t, { voice: async (_input, output) => { await writeFile(output, VIDEO); return { ready: true, duration: 3 }; }, speech: fakeSpeech({ align: async () => { throw new Error('FFmpeg failed'); } }) });
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id); await app.call(`/tasks/${id}/analyze`, { body: {} });
  await fetch(app.base + `/api/video-replica/tasks/${id}/video`, { method: 'PUT', body: VIDEO });
  assert.equal((await app.current(id)).speech, undefined);
  assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 202);
  const running = await app.until(id, task => task.status === 'running');
  assert.equal(running.speech.start, 1.25); app.state.done = true;
  const failed = await app.until(id, task => task.status === 'failed' && task.billing?.status === 'released');
  assert.equal(failed.code, 'VIDEO_SPEECH_FAILED'); assert.equal(failed.resultUrl, null);
  assert.equal((await app.wallet.snapshot('alice')).available, TEST_BALANCE); assert.equal(app.state.generations, 1);
});

test('transcript differences never block delivery and preserve generated audio when alignment is unsafe', async t => {
  const timeline = text => ({ ...SPEECH, text, segments: [{ ...SPEECH.segments[0], text,
    words: [{ word: text, start: 1.25, end: 3.5 }] }] });
  const source = timeline('现在九块九，欢迎大家购买。真的好吃');
  for (const [name, raw, aligned, failedStage, failedCode = 'VIDEO_SPEECH_INVALID'] of [
    ['rewritten script', timeline('完全不同的台词重复好多内容'.repeat(10)), source],
    ['changed price', timeline('现在九十九，欢迎大家购买。真的好吃'), source],
    ['missing phrase', timeline('现在九块九'), source],
    ['aligned difference', source, timeline('已经变成完全不同的台词')],
    ['unrecognized generated speech', source, source, 'generated.mp4'],
    ['unrecognized aligned speech', source, source, 'result.tmp'],
    ['recognizer unavailable', source, source, 'generated.mp4', 'VIDEO_SPEECH_FAILED'],
    ['recognizer still pending', source, source, 'result.tmp', 'VIDEO_TRANSCRIPTION_PENDING'],
    ['unmatched timing', source, { ...source, segments: [{ ...source.segments[0], start: 2 }] }],
  ]) await t.test(name, async t => {
    const app = await fixture(t, { voice: async (_input, output) => { await writeFile(output, VIDEO); return { ready: true, duration: 3 }; },
      speech: fakeSpeech({ analyze: async path => {
        if (failedStage && path.endsWith(failedStage)) throw Object.assign(new Error('台词识别不完整'), { code: failedCode });
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
    assert.equal(completed.billing.chargedPoints, 1640);
    await app.close(); await app.open();
    assert.equal((await app.current(id)).status, 'completed');
    assert.equal((await app.wallet.snapshot('alice')).available, TEST_BALANCE - 1640);
    assert.equal(app.state.generations, 1);
  });
});

for (const metadata of [{ ...META, audio: false }, { ...META, duration: 0.5 }, { ...META, duration: 6 }]) {
  test(`downloaded result with audio=${metadata.audio} and duration=${metadata.duration} is delivered`, async t => {
    const app = await fixture(t, { probe: async path => path.endsWith('result.tmp') ? metadata : META });
    const id = await app.init(); await app.upload(id);
    await app.call(`/tasks/${id}/start`, { body: {} }); app.state.done = true;
    const completed = await app.until(id, task => ['completed', 'failed'].includes(task.status) && ['settled', 'released'].includes(task.billing.status));
    assert.equal(completed.status, 'completed', completed.error);
    assert.equal(completed.actualDuration, metadata.duration);
    assert.equal(completed.billing.status, 'settled');
    const response = await app.call(`/tasks/${id}/result`);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), VIDEO);
    assert.equal(app.state.generations, 1);
  });

  test(`final result with audio=${metadata.audio} and duration=${metadata.duration} is delivered after speech processing`, async t => {
    let resultProbes = 0;
    const app = await fixture(t, { voice: async (_input, output) => { await writeFile(output, VIDEO); return { ready: true, duration: 3 }; },
      probe: async path => path.endsWith('result.tmp') && ++resultProbes > 1 ? metadata : META,
      speech: fakeSpeech({ align: async () => { throw Object.assign(new Error('台词差异'), { code: 'VIDEO_SPEECH_INVALID' }); } }) });
    const id = await app.init(); await app.upload(id); await uploadVoice(app, id); await app.call(`/tasks/${id}/analyze`, { body: {} });
    await app.call(`/tasks/${id}/start`, { body: { speechConfirmed: true } }); app.state.done = true;
    const completed = await app.until(id, task => ['completed', 'failed'].includes(task.status) && ['settled', 'released'].includes(task.billing.status));
    assert.equal(completed.status, 'completed', completed.error);
    assert.equal(completed.actualDuration, metadata.duration);
    assert.equal(completed.billing.status, 'settled');
    const response = await app.call(`/tasks/${id}/result`);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), VIDEO);
    assert.equal(app.state.generations, 1);
  });
}

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
    assert.equal(completed.billing.chargedPoints, 1640);
    await app.close(); await app.open();
    assert.equal((await app.current(id)).status, 'completed');
    assert.equal((await app.wallet.snapshot('alice')).available, TEST_BALANCE - 1640);
    assert.equal(app.state.generations, 1);
  });
});

test('voice analysis tolerates missing detection and unreliable ASR times while alignment stays conservative', () => {
  const undetected = speechTimeline({ words: SPEECH.segments[0].words }, [], 4);
  assert.equal(undetected.text, '你好世界'); assert.equal(undetected.start, 1.25); assert.equal(undetected.end, 3.5);
  assert.equal(undetected.timingSource, 'asr');
  const untimed = speechTimeline({ words: [{ word: '你好', start: 1, end: 0 }] }, [{ start: 1, end: 2 }], 4);
  assert.equal(untimed.text, '你好'); assert.match(untimed.warning, /核对/);
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
  const overlapping = speechTimeline({ words: SPEECH.segments[0].words }, [{ start: 0, end: 2 }, { start: 1.5, end: 3 }], 4);
  assert.equal(overlapping.text, '你好世界'); assert.equal(overlapping.timingSource, 'asr');
  const mismatched = speechTimeline({ words: [{ word: '不匹配', start: 2.5, end: 3 }] }, [{ start: 0, end: 1 }], 4);
  assert.equal(mismatched.text, '不匹配'); assert.match(mismatched.warning, /核对/);
});

test('untranscribed closing speech allows editable confirmation without discarding its time range', () => {
  const intervals = [{ start: 0, end: 9.28 }, { start: 11.232, end: 12.282 }];
  const result = speechTimeline({ words: [{ word: '又薄又脆', start: 8, end: 9.28 }] }, intervals, 12.3);
  assert.equal(result.text, '又薄又脆'); assert.equal(result.end, 12.282);
  assert.equal(result.segments.length, 1); assert.match(result.warning, /核对/);
  const confirmed = confirmSpeech(result, [{ text: '又薄又脆真的超好吃' }]);
  assert.equal(confirmed.text, '又薄又脆真的超好吃'); assert.equal(confirmed.end, 12.282);
});

test('empty recognition and many VAD intervals do not reject the analysis result', () => {
  const empty = speechTimeline({ text: '', words: [] }, [], 4);
  assert.equal(empty.segments.length, 1); assert.equal(empty.start, 0); assert.equal(empty.end, 4);
  assert.equal(empty.text, ''); assert.equal(empty.timingSource, 'manual');
  const confirmed = confirmSpeech(empty, [{ text: '手动填写原台词' }]);
  assert.equal(confirmed.text, '手动填写原台词');
  const intervals = Array.from({ length: 31 }, (_, i) => ({ start: i * 0.1, end: i * 0.1 + 0.05 }));
  const many = speechTimeline({ text: '你好' }, intervals, 4);
  assert.equal(many.text, '你好'); assert.equal(many.segments.length, 1);
});

test('a split consonant tail stays with its transcribed word without hiding another phrase', () => {
  const words = [{ word: '又薄又脆', start: 11.58, end: 12.8 }, { word: '真的超好吃', start: 13.88, end: 14.86 }];
  const intervals = [{ start: 5.056, end: 12.544 }, { start: 12.832, end: 12.96 }, { start: 14.08, end: 15.104 }];
  const result = speechTimeline({ words }, intervals, 15.104);
  assert.equal(result.text, '又薄又脆真的超好吃');
  assert.deepEqual(result.segments.map(({ start, end }) => ({ start, end })), [
    { start: 5.056, end: 12.96 }, { start: 14.08, end: 15.104 },
  ]);
  const unmatched = speechTimeline({ words }, [intervals[0], { start: 13.1, end: 13.228 }, intervals[2]], 15.104);
  assert.equal(unmatched.text, '又薄又脆真的超好吃'); assert.equal(unmatched.end, 15.104); assert.match(unmatched.warning, /核对/);
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
  let valid = false, clock = Date.now();
  const generationStartedAt = clock;
  const app = await fixture(t, { now: () => clock, voice: async (_input, output) => { await writeFile(output, VIDEO); return { ready: true, duration: 3 }; },
    speech: fakeSpeech({ align: async (_source, output) => {
      if (!valid) throw new Error('FFmpeg failed');
      clock += 20_000;
      await writeFile(output, VIDEO); return { transcriptMatched: true };
    } }) });
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id); await app.call(`/tasks/${id}/analyze`, { body: {} });
  await app.call(`/tasks/${id}/start`, { body: { speechConfirmed: true } }); app.state.done = true;
  const failed = await app.until(id, task => task.status === 'failed' && task.billing?.status === 'released');
  assert.equal(failed.canRecheck, true); assert.equal(failed.resultUrl, null);
  assert.equal((await app.wallet.snapshot('alice')).available, TEST_BALANCE);
  await app.close(); await app.open();
  assert.equal((await app.current(id)).canRecheck, true);
  assert.equal((await app.call(`/tasks/${id}/recheck`, { owner: 'bob', body: {} })).status, 404);
  valid = true; clock += 300_000;
  const responses = await Promise.all([app.call(`/tasks/${id}/recheck`, { body: {} }), app.call(`/tasks/${id}/recheck`, { body: {} })]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 202]);
  const completed = await app.until(id, task => task.status === 'completed');
  assert.equal(completed.generationStartedAt, generationStartedAt);
  assert.equal(completed.startedAt, generationStartedAt + 300_000);
  assert.equal(completed.completedAt - completed.generationStartedAt, 320_000);
  assert.equal(completed.billing.chargedPoints, 1640);
  assert.equal((await app.wallet.snapshot('alice')).available, TEST_BALANCE - 1640);
  assert.equal(app.state.generations, 1); assert.equal(app.state.creates.length, 3);
  for (let i = 0; i < 3; i++) await app.call(`/tasks/${id}/recheck`, { body: {} });
  assert.equal(app.state.generations, 1); assert.equal((await app.wallet.snapshot('alice')).available, TEST_BALANCE - 1640);
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
    assert.equal((await app.wallet.snapshot('alice')).available, TEST_BALANCE);
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
  const wallet = await app.wallet.snapshot('alice'); assert.equal(wallet.held, 0); assert.equal(wallet.available, TEST_BALANCE);
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
  assert.equal((await app.wallet.snapshot('alice')).held, 1640);
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
  assert.equal(task.billing.chargedPoints, 1640); assert.equal((await app.wallet.snapshot('alice')).available, TEST_BALANCE - 1640);
  const range = await app.call(`/tasks/${id}/result`, { headers: { Range: 'bytes=0-11' } });
  assert.equal(range.status, 206); assert.equal(range.headers.get('content-type'), 'video/mp4');
  assert.equal((await range.arrayBuffer()).byteLength, 12);
  assert.equal((await app.call(`/tasks/${id}/result`, { owner: 'bob' })).status, 404);
  for (let i = 0; i < 3; i++) assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 200);
  assert.equal(app.state.generations, 1); assert.equal((await app.wallet.snapshot('alice')).available, TEST_BALANCE - 1640);
});

test('the same account can keep more than five unsubmitted replica drafts', async t => {
  const app = await fixture(t);
  const ids = [];
  for (let i = 0; i < 8; i++) ids.push(await app.init());
  const tasks = (await (await app.call('/tasks')).json()).tasks;
  assert.equal(tasks.length, ids.length);
  assert.ok(tasks.every(task => task.status === 'draft'));
  assert.equal(app.state.generations, 0);
  assert.equal((await app.wallet.snapshot('alice')).held, 0);
});

test('the same account can generate separate replicas concurrently without duplicate submissions', async t => {
  const app = await fixture(t);
  const ids = [await app.init(), await app.init()];
  for (const id of ids) await app.upload(id);
  const responses = await Promise.all(ids.map(id => app.call(`/tasks/${id}/start`, { body: {} })));
  assert.deepEqual(responses.map(response => response.status), [202, 202]);
  for (const id of ids) await app.until(id, task => task.status === 'running');
  assert.equal(app.state.generations, 2);
  assert.equal((await app.wallet.snapshot('alice')).held, 3280);
  for (const id of ids) assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 200);
  app.state.done = true;
  for (const id of ids) await app.until(id, task => task.status === 'completed');
  assert.equal(app.state.generations, 2);
  assert.equal((await app.wallet.snapshot('alice')).available, TEST_BALANCE - 3280);
  assert.equal((await app.wallet.snapshot('alice')).held, 0);
});

test('an existing replica can be rechecked while another task runs for the same account', async t => {
  let valid = false;
  const app = await fixture(t, { voice: async (_input, output) => { await writeFile(output, VIDEO); return { ready: true, duration: 3 }; },
    speech: fakeSpeech({ align: async (_source, output) => {
      if (!valid) throw new Error('FFmpeg failed');
      await writeFile(output, VIDEO); return { transcriptMatched: true };
    } }) });
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id);
  await app.call(`/tasks/${id}/analyze`, { body: {} });
  await app.call(`/tasks/${id}/start`, { body: { speechConfirmed: true } }); app.state.done = true;
  await app.until(id, task => task.status === 'failed' && task.billing?.status === 'released');
  app.state.done = false; valid = true;
  const other = await app.init(); await app.upload(other);
  await app.call(`/tasks/${other}/start`, { body: {} });
  await app.until(other, task => task.status === 'running');
  assert.equal((await app.call(`/tasks/${id}/recheck`, { body: {} })).status, 202);
  await app.until(id, task => task.status === 'completed');
  assert.equal((await app.current(other)).status, 'running');
  assert.equal(app.state.generations, 2);
  assert.equal((await app.wallet.snapshot('alice')).held, 1640);
  assert.equal((await app.wallet.snapshot('alice')).available, TEST_BALANCE - 3280);
});

test('material queries recover on the fifth retry without recreating assets or replaying generation', async t => {
  let queries = 0;
  const app = await fixture(t, { queryMaterial: async id => {
    if (id === 'photo-id' && ++queries <= 5) throw new VideoError('Temporary provider failure', 502,
      queries % 2 ? 'VIDEO_PROVIDER_REJECTED' : 'VIDEO_PROVIDER_UNAVAILABLE');
    return 2;
  } });
  app.state.review = 1;
  const id = await app.init(); await app.upload(id);
  await app.call(`/tasks/${id}/start`, { body: {} });
  const running = await app.until(id, task => ['running', 'failed'].includes(task.status));
  assert.equal(running.status, 'running', running.error); assert.equal(queries, 6);
  assert.equal(running.error, ''); assert.equal(running.code, undefined);
  assert.deepEqual(app.state.creates.map(material => material.kind), ['photo', 'video']);
  assert.equal(app.state.generations, 1);
  app.state.done = true; await app.until(id, task => task.status === 'completed' && task.billing.status === 'settled');
  assert.equal(app.state.generations, 1); assert.equal((await app.wallet.snapshot('alice')).available, TEST_BALANCE - 1640);
});

test('material queries stop after five retries and release the hold without starting generation', async t => {
  let queries = 0;
  const app = await fixture(t, { queryMaterial: async () => {
    queries++; throw new VideoError('Temporary provider refusal', 502, 'VIDEO_PROVIDER_REJECTED');
  } });
  app.state.review = 1;
  const id = await app.init(); await app.upload(id);
  await app.call(`/tasks/${id}/start`, { body: {} });
  const failed = await app.until(id, task => task.status === 'failed' && task.billing.status === 'released');
  assert.equal(queries, 6); assert.equal(failed.code, 'VIDEO_MATERIAL_QUERY_FAILED');
  assert.match(failed.error, /重试 5 次/);
  assert.equal(app.state.creates.length, 1); assert.equal(app.state.generations, 0);
  assert.equal((await app.wallet.snapshot('alice')).available, TEST_BALANCE);
  await delay(60); assert.equal(queries, 6);
});

test('material query retry counts survive a restart', async t => {
  let queries = 0;
  const app = await fixture(t, { pollIntervalMs: 1000, queryMaterial: async () => {
    queries++; throw new VideoError('Temporary provider refusal', 502, 'VIDEO_PROVIDER_REJECTED');
  } });
  app.state.review = 1;
  const id = await app.init(); await app.upload(id);
  await app.call(`/tasks/${id}/start`, { body: {} });
  const pending = await app.until(id, task => task.code === 'VIDEO_MATERIAL_QUERY_RETRYING' || task.status === 'failed');
  assert.equal(pending.status, 'reviewing'); assert.equal(queries, 1);
  assert.match(pending.error, /1\/5/);
  await app.close(); await app.open({ pollIntervalMs: 15 });
  await app.until(id, task => task.status === 'failed' && task.billing.status === 'released');
  assert.equal(queries, 6); assert.equal(app.state.creates.length, 1); assert.equal(app.state.generations, 0);
});

test('an explicit rejected material review fails immediately without query retries', async t => {
  let queries = 0;
  const app = await fixture(t, { queryMaterial: async () => { queries++; return 3; } });
  app.state.review = 1;
  const id = await app.init(); await app.upload(id);
  await app.call(`/tasks/${id}/start`, { body: {} });
  const failed = await app.until(id, task => task.status === 'failed' && task.billing.status === 'released');
  assert.equal(queries, 1); assert.equal(failed.code, 'VIDEO_REVIEW_REJECTED');
  assert.equal(app.state.generations, 0); assert.equal((await app.wallet.snapshot('alice')).available, TEST_BALANCE);
});

test('material review keeps waiting beyond three minutes and the active asset retention window', async t => {
  let time = Date.now(); const app = await fixture(t, { now: () => time });
  app.state.review = 1;
  const id = await app.init(); await app.upload(id);
  await app.call(`/tasks/${id}/start`, { body: {} });
  for (let i = 0; i < 100 && app.state.creates.length < 2; i++) await delay(10);
  assert.equal(app.state.creates.length, 2);
  for (const advance of [181_000, 4 * 86400_000]) {
    time += advance; await delay(60);
    assert.equal((await app.current(id)).status, 'reviewing');
    assert.equal((await app.wallet.snapshot('alice')).held, 1640);
    assert.equal((await app.call(`/tasks/${id}/video`)).status, 200);
    for (const material of app.state.creates) {
      const source = new URL(material.url);
      assert.equal((await fetch(app.base + source.pathname + source.search)).status, 200);
    }
  }
  app.state.review = 2; app.state.done = true;
  await app.until(id, task => task.status === 'completed');
  assert.equal(app.state.generations, 1);
});

test('running replicas survive a day-long wait and restart after the active asset retention window', async t => {
  let time = Date.now(); const app = await fixture(t, { now: () => time });
  const id = await app.init(); await app.upload(id);
  await app.call(`/tasks/${id}/start`, { body: {} });
  await app.until(id, task => task.status === 'running');
  time += 25 * 3600_000; await delay(60);
  assert.equal((await app.current(id)).status, 'running');
  time += 3 * 86400_000;
  await app.close(); await app.open(); await delay(60);
  assert.equal((await app.current(id)).status, 'running');
  assert.equal((await app.wallet.snapshot('alice')).held, 1640);
  assert.equal((await app.call(`/tasks/${id}/video`)).status, 200);
  const source = new URL(app.state.creates.find(item => item.kind === 'video').url);
  assert.equal((await fetch(app.base + source.pathname + source.search)).status, 200);
  assert.equal((await fetch(app.base + source.pathname)).status, 403);
  app.state.done = true;
  const completed = await app.until(id, task => task.status === 'completed');
  assert.equal(completed.expiresAt, time + 3 * 86400_000);
  assert.equal((await app.call(`/tasks/${id}/result`)).status, 200);
  assert.equal((await fetch(app.base + source.pathname + source.search)).status, 403);
  assert.equal(app.state.generations, 1);
  assert.equal((await app.wallet.snapshot('alice')).available, TEST_BALANCE - 1640);
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
  assert.equal((await app.wallet.snapshot('alice')).held, 1640);
  await app.close();
  reply = { status: 2, message: 'https://cdn.example/download/result?token=test' };
  await app.open();
  const completed = await app.until(id, task => task.status === 'completed');
  assert.equal(completed.error, ''); assert.equal(completed.code, undefined);
  assert.equal(completed.billing.chargedPoints, 1640);
  assert.equal(app.state.generations, 1);
});

test('unlimited zero-balance account completes a person replica without charges and still waits for settlement', async t => {
  const app = await fixture(t, { balance: 1000 });
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
  const app = await fixture(t, { probe: async () => ({ ...META, duration: 61 }) });
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
  assert.equal((await app.wallet.snapshot('alice')).available, TEST_BALANCE);
});

test('insufficient balance prevents material and model calls', async t => {
  const app = await fixture(t, { balance: 1000 });
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
  assert.equal((await app.wallet.snapshot('alice')).available, TEST_BALANCE);
  app.state.failed = false; app.state.done = true; let attempts = 0;
  await app.close();
  await app.open({ download: async (_url, path) => { if (++attempts === 1) throw new Error('Download interrupted'); await writeFile(path, VIDEO); } });
  const second = await app.init(); await app.upload(second); await app.call(`/tasks/${second}/start`, { body: {} });
  await app.until(second, task => task.status === 'completed');
  assert.equal(attempts, 2); assert.equal(app.state.generations, 2);
  assert.equal((await app.wallet.snapshot('alice')).available, TEST_BALANCE - 1640);
});

test('restart resumes provider polling without a second paid submission', async t => {
  const app = await fixture(t);
  const id = await app.init(); await app.upload(id); await app.call(`/tasks/${id}/start`, { body: {} });
  await app.until(id, task => task.status === 'running');
  await app.close(); app.state.done = true; await app.open();
  await app.until(id, task => task.status === 'completed');
  assert.equal(app.state.generations, 1); assert.equal((await app.wallet.snapshot('alice')).available, TEST_BALANCE - 1640);
});

test('uncertain paid submission is never replayed and its hold is returned', async t => {
  const app = await fixture(t, { uncertain: true });
  const id = await app.init(); await app.upload(id); await app.call(`/tasks/${id}/start`, { body: {} });
  const task = await app.until(id, task => task.status === 'failed' && task.billing?.status === 'released');
  assert.equal(task.code, 'VIDEO_SUBMISSION_UNCERTAIN');
  await app.close(); await app.open(); await app.call(`/tasks/${id}/start`, { body: {} });
  assert.equal(app.state.generations, 1); assert.equal((await app.wallet.snapshot('alice')).available, TEST_BALANCE);
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
  assert.equal((await app.wallet.snapshot('alice')).available, TEST_BALANCE - 1640);
});

test('three-day expiry removes media while keeping deduplication and billing records', async t => {
  let time = Date.now(); const app = await fixture(t, { now: () => time });
  const id = await app.init(); await app.upload(id); app.state.done = true; await app.call(`/tasks/${id}/start`, { body: {} });
  await app.until(id, task => task.status === 'completed');
  time += 3 * 86400_000 + 1;
  assert.equal((await app.call(`/tasks/${id}/result`)).status, 410);
  const cleanupDeadline = performance.now() + 15_000;
  while (!JSON.parse(await readFile(join(app.root, 'video', id, 'task.json'), 'utf8')).cleaned && performance.now() < cleanupDeadline) await delay(50);
  await assert.rejects(readFile(join(app.root, 'video', id, 'result.mp4')), { code: 'ENOENT' });
  assert.equal((await app.current(id)).status, 'expired');
  assert.equal((await app.wallet.snapshot('alice')).available, TEST_BALANCE - 1640);
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
    'generated.mp4.asr.wav', 'generated.mp4.vad.pcm', 'result.tmp.asr.wav', 'result.tmp.vad.pcm', 'result.tmp.aligned.pcm',
    'narration.wav', 'narration.wav.pcm', 'narration.wav.tmp.wav', 'lipsync.mp4', 'lipsync.mp4.download.json',
    'separation-source.wav', 'separated-vocals.wav', 'separated-vocals.wav.download.json', 'separated-background.wav', 'separated-background.wav.download.json'];
  await Promise.all(privateArtifacts.map(name => writeFile(join(taskFolder, name), `private material: ${name}`)));
  await mkdir(join(taskFolder, 'narration'));
  await writeFile(join(taskFolder, 'narration', 'emotion-0.wav'), 'private emotion');
  await writeFile(join(taskFolder, 'narration', '0.wav'), 'private narration');
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
  assert.equal((await app.wallet.snapshot('alice')).available, TEST_BALANCE - 1640); assert.equal(app.state.generations, 1);
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

function fakeNarration(overrides = {}) {
  return { enabled: true,
    prepare: async task => ({ engine: 'indextts2', emotionSource: 'original-video', ready: false,
      segments: task.speech.segments.map(segment => ({ ...segment })) }),
    advance: async (task, folder, _urls, save) => {
      if (!task.narration.ready) {
        await writeFile(join(folder, 'narration.wav'), 'INDEXTTS_AUDIO');
        task.narration.ready = true; task.narration.segments.forEach(segment => segment.status = 'ready'); await save();
      }
    },
    mux: async (_video, audio, output) => writeFile(output, await readFile(audio)), ...overrides };
}

for (const model of ['doubao-seedance-2-0-260128', WAN3_MODEL]) test(`Chatterbox survives restart and is included in the ${model} price`, async t => {
  let done = false, submissions = 0, wanSubmissions = 0, input, audio;
  const endpoint = 'fal-ai/chatterbox/speech-to-speech';
  const app = await fixture(t, { costMode: true, now: () => Date.parse('2026-10-21T12:00:00+08:00'),
    env: { FAL_KEY: 'test-only-key' }, config: { ...CONFIG, wan3Enabled: true, falKey: 'test-only-key' },
    wan3Provider: { upload: async input => ({ id: 'oss://test/' + input.split(/[\\/]/).at(-1), status: 2 }),
      generate: async task => { wanSubmissions++; const body = wan3GenerationBody(task); assert.equal(body.parameters.audio, false);
        assert.equal(body.input.media.length, 2); assert.match(body.input.prompt, /逐帧保留/); return { taskId: 'wan-paid-1' }; },
      query: async () => ({ completed: true, url: 'https://result.example/wan.mp4',
        usage: { duration: 8, input_video_duration: 4, output_video_duration: 4, SR: 720 } }) },
    voiceConversion: undefined, speech: fakeSpeech(),
    voice: async (_input, output) => { await writeFile(output, await readFile(audio)); return { duration: 4 }; },
    download: async (_url, output) => writeFile(output, await readFile(output.endsWith('.wav') ? audio : input)),
    fetchImpl: async (url, options = {}) => {
      const target = new URL(url);
      if (target.hostname === 'api.fal.ai') return Response.json({ prices: [{ endpoint_id: endpoint, currency: 'USD', unit_price: .015 }] });
      if (target.hostname === 'www.openlux.ai') return Response.json({ data: target.pathname.endsWith('/status') ? { usd_exchange_rate: 1 } : [] });
      assert.equal(target.hostname, 'queue.fal.run');
      if (options.method === 'POST') {
        submissions++; assert.equal(target.pathname, '/' + endpoint);
        return Response.json({ request_id: 'voice-paid-1', status_url: 'https://queue.fal.run/fal-ai/chatterbox/requests/voice-paid-1/status',
          response_url: 'https://queue.fal.run/fal-ai/chatterbox/requests/voice-paid-1' });
      }
      if (target.pathname.endsWith('/status')) return Response.json({ status: done ? 'COMPLETED' : 'IN_PROGRESS' });
      return Response.json({ audio: { url: 'https://fal.media/converted.wav' } }, { headers: { 'x-fal-billable-units': '1' } });
    },
  });
  input = join(app.root, 'original.mp4'); audio = join(app.root, 'audio.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=s=160x240:r=25:d=4',
    '-f', 'lavfi', '-i', 'sine=duration=4', '-c:v', 'libx264', '-c:a', 'aac', input]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', input, '-vn', '-ac', '1', '-ar', '24000', audio]);
  const id = randomUUID(); await app.call('/tasks', { body: { requestId: id, model } });
  await app.upload(id);
  await fetch(app.base + `/api/video-replica/tasks/${id}/video`, { method: 'PUT', body: await readFile(input) });
  await uploadVoice(app, id);
  assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 202);
  await app.until(id, task => task.voiceConversionProgress && submissions === 1);
  await app.close(); done = true; await app.open();
  await app.until(id, task => ['running', 'completed'].includes(task.status)); app.state.done = true;
  const completed = await app.until(id, task => task.status === 'completed');
  assert.equal(completed.audioCheck.engine, 'chatterbox'); assert.equal(completed.audioCheck.tempoAdjusted, false);
  assert.equal(submissions, 1); assert.equal(app.state.generations, model === WAN3_MODEL ? 0 : 1);
  assert.equal(wanSubmissions, model === WAN3_MODEL ? 1 : 0);
  const bill = await app.wallet.reservation('alice', id);
  assert.equal(bill.pricingKey, generationPrice('video', model).key);
  assert.equal(bill.chargedPoints, generationPrice('video', model).pointsPerSecond * 4);
  assert.equal(bill.costItems, undefined);
});

test('Chatterbox requires configured conversion and an original audio track before paid processing', async t => {
  const app = await fixture(t, { speech: fakeSpeech(), voice: async (_input, output) => { await writeFile(output, VIDEO); return { duration: 3 }; } });
  const id = randomUUID(); await app.call('/tasks', { body: { requestId: id } });
  await app.upload(id); await uploadVoice(app, id);
  assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 503);
  assert.equal(await app.wallet.reservation('alice', id), null);
  assert.equal((await app.call(`/tasks/${id}/source-audio`, { body: { sourceAudioMode: 'silent', voiceEngine: 'chatterbox' } })).status, 400);
  await app.close(); await app.open({ voiceConversion: { enabled: true }, probe: async () => ({ ...META, audio: false }) });
  await fetch(app.base + `/api/video-replica/tasks/${id}/video`, { method: 'PUT', body: VIDEO });
  assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 202);
  assert.equal((await app.current(id)).canReplaceSource, true);
  assert.equal(await app.wallet.reservation('alice', id), null);
  assert.equal(app.state.generations, 0);
});

for (const hasSubtitles of [true, false]) test(`IndexTTS uses ${hasSubtitles ? 'detected subtitles' : 'original audio when no subtitles exist'} for narration`, async t => {
  let analyses = 0, narrationSpeech;
  const app = await fixture(t, {
    voice: async (_input, output) => { await writeFile(output, VIDEO); return { ready: true, duration: 3 }; },
    speech: fakeSpeech({ analyze: async () => { analyses++; return structuredClone(SPEECH); } }),
    captions: { extract: async () => hasSubtitles ? structuredClone(CAPTIONS) : null },
    narration: fakeNarration({ prepare: async task => {
      narrationSpeech = structuredClone(task.speech); return fakeNarration().prepare(task);
    } }), lipsync: fakeLipsync() });
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id);
  await app.call(`/tasks/${id}/analyze`, { body: {} });
  assert.equal((await app.call(`/tasks/${id}/start`, { body: { voiceEngine: 'indextts2' } })).status, 202);
  const running = await app.until(id, task => task.status === 'running');
  assert.equal(running.speech.source, hasSubtitles ? 'subtitles' : 'audio');
  assert.equal(narrationSpeech.text, hasSubtitles ? CAPTIONS.cues.map(cue => cue.text).join('') : SPEECH.text);
  assert.deepEqual(narrationSpeech, running.speech);
  assert.equal(analyses, hasSubtitles ? 0 : 1, 'ASR must only run when subtitles are absent');
  await app.close(); await app.open();
  assert.deepEqual((await app.current(id)).speech, narrationSpeech);
  assert.equal(analyses, hasSubtitles ? 0 : 1); assert.equal(app.state.generations, 1);
});

test('IndexTTS preserves explicitly confirmed dialogue instead of overwriting it with ASR', async t => {
  const app = await fixture(t, {
    voice: async (_input, output) => { await writeFile(output, VIDEO); return { ready: true, duration: 3 }; },
    speech: fakeSpeech({ analyze: async () => assert.fail('Confirmed dialogue must be preserved') }),
    captions: { extract: async () => structuredClone(CAPTIONS) },
    narration: fakeNarration(), lipsync: fakeLipsync() });
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id);
  await app.call(`/tasks/${id}/analyze`, { body: {} });
  const response = await app.call(`/tasks/${id}/speech`, { body: { segments: [{ text: '原文已确认' }, { text: '只要8.8元' }] } });
  assert.equal(response.status, 200);
  const confirmed = (await response.json()).task.speech;
  assert.equal((await app.call(`/tasks/${id}/start`, { body: { voiceEngine: 'indextts2' } })).status, 202);
  assert.deepEqual((await app.until(id, task => task.status === 'running')).speech, confirmed);
});

test('pending source transcription resumes after restart before any video or narration generation', async t => {
  let ready = false, prepared = 0, clock = Date.now();
  const app = await fixture(t, {
    now: () => clock,
    voice: async (_input, output) => { await writeFile(output, VIDEO); return { ready: true, duration: 3 }; },
    speech: fakeSpeech({ analyze: async () => {
      if (!ready) throw new VideoError('原声文稿正在识别，正在查询原任务。', 502, 'VIDEO_TRANSCRIPTION_PENDING');
      return structuredClone(SPEECH);
    } }),
    narration: fakeNarration({ prepare: async task => { prepared++; return fakeNarration().prepare(task); } }),
    lipsync: fakeLipsync() });
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id);
  await app.call(`/tasks/${id}/start`, { body: { voiceEngine: 'indextts2' } });
  const pending = await app.until(id, task => task.recovery?.state === 'retrying');
  assert.equal(pending.status, 'preparing');
  assert.equal(app.state.generations, 0); assert.equal(prepared, 0);
  await app.close(); ready = true; clock += 60_000; await app.open();
  const running = await app.until(id, task => task.status === 'running');
  assert.equal(running.speech.text, SPEECH.text); assert.equal(running.error, '');
  assert.equal(app.state.generations, 1); assert.equal(prepared, 1);
});
const fakeLipsync = overrides => ({ enabled: true,
  submit: async () => ({ id: 'mouth-job', statusUrl: 'https://queue.fal.run/veed/lipsync/requests/mouth-job/status' }),
  query: async () => 'https://cdn.example/mouth.mp4', ...overrides });

for (const [model, voiceEngine] of [[REPLICA_PRICES[0][0], 'seedance'], [PREMIUM_MODEL, 'indextts2']]) {
  test(`${model} silent reference mode removes every audio track without changing video or the private speech source`, async t => {
    const app = await fixture(t, { probe: probeVideo,
      voice: async (_input, output) => { await writeFile(output, VIDEO); return { duration: 3 }; },
      speech: fakeSpeech({ analyze: async input => {
        assert.equal((await probeVideo(input)).audio, true); return structuredClone(SPEECH);
      } }),
      narration: fakeNarration({ prepare: async (task, folder) => {
        assert.equal(voiceEngine, 'indextts2', 'Direct voice must not call separate narration');
        assert.equal((await probeVideo(join(folder, 'source.mp4'))).audio, true);
        return fakeNarration().prepare(task);
      } }), lipsync: fakeLipsync(),
    });
    const original = join(app.root, 'original.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x960:r=24:d=6',
      '-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=6',
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-c:a', 'aac', original]);
    const bytes = await readFile(original), id = randomUUID();
    await app.call('/tasks', { body: { requestId: id, model } });
    assert.equal((await app.call(`/tasks/${id}/source-audio`, { body: { sourceAudioMode: 'silent', voiceEngine } })).status, 200);
    assert.equal((await fetch(app.base + `/api/video-replica/tasks/${id}/video`, { method: 'PUT', body: bytes })).status, 200);
    assert.equal((await fetch(app.base + `/api/video-replica/tasks/${id}/photo`, { method: 'PUT', body: VIDEO })).status, 200);
    await uploadVoice(app, id);
    await app.close(); await app.open();
    assert.equal((await app.current(id)).sourceAudioMode, 'silent');
    assert.equal((await app.current(id)).voiceEngine, voiceEngine);
    assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 202);
    await app.until(id, task => task.status === 'running');
    assert.equal(app.state.body.payload.params.generateAudio, voiceEngine === 'seedance');
    if (voiceEngine === 'seedance') {
      assert.deepEqual(app.state.body.payload.referAudioUrl, ['asset://voice-id']);
      assert.match(app.state.body.prompt, /视频1已去除原声音轨/);
      assert.match(app.state.body.prompt, /音频1是用户上传的声音，也是唯一音色参考/);
      assert.match(app.state.body.prompt, /情绪表达参考视频1的表情、动作和台词语义/);
      assert.doesNotMatch(app.state.body.prompt, /视频1原声提供/);
    } else assert.equal('referAudioUrl' in app.state.body.payload, false);
    const source = new URL(app.state.creates.find(item => item.kind === 'video').url);
    const silent = join(app.root, 'served.mp4');
    await writeFile(silent, Buffer.from(await (await fetch(app.base + source.pathname + source.search)).arrayBuffer()));
    assert.equal((await probeVideo(silent)).audio, false);
    const packets = input => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_packets',
      '-show_data_hash', 'sha256', '-show_entries', 'packet=pts,dts,duration,data_hash', '-of', 'json', input]).toString();
    assert.equal(packets(silent), packets(original), 'Video packets and timestamps must be unchanged');
    assert.deepEqual(Buffer.from(await (await app.call(`/tasks/${id}/video`)).arrayBuffer()), bytes);
    assert.equal((await app.call(`/tasks/${id}/source-audio`, { body: { sourceAudioMode: 'original' } })).status, 409);
    await app.close(); await app.open();
    assert.equal((await app.current(id)).sourceAudioMode, 'silent');
    assert.deepEqual(Buffer.from(await (await fetch(app.base + source.pathname + source.search)).arrayBuffer()), await readFile(silent));
    assert.equal(app.state.generations, 1);
  });
}

test('explicit legacy audio selections remain compatible and reject invalid or voiceless requests before billing', async t => {
  const app = await fixture(t, { config: { ...CONFIG, falEnabled: true }, costMode: true });
  const id = await app.init(); await app.upload(id);
  assert.equal((await app.current(id)).sourceAudioMode, 'original');
  assert.equal((await app.call(`/tasks/${id}/source-audio`, { body: { sourceAudioMode: 'invalid' } })).status, 400);
  assert.equal((await app.call(`/tasks/${id}/source-audio`, { body: { sourceAudioMode: 'silent', voiceEngine: 'invalid' } })).status, 400);
  assert.equal((await app.current(id)).sourceAudioMode, 'original');
  assert.equal((await app.current(id)).voiceEngine, 'seedance');
  assert.equal((await app.call(`/tasks/${id}/source-audio`, { owner: 'bob', body: { sourceAudioMode: 'silent' } })).status, 404);
  for (const [model] of REPLICA_PRICES) {
    await app.call(`/tasks/${id}/model`, { body: { model } });
    assert.equal((await app.call(`/tasks/${id}/source-audio`, { body: { sourceAudioMode: 'silent' } })).status, 200);
    assert.equal((await app.current(id)).sourceAudioMode, 'silent');
  }
  const missing = await app.call(`/tasks/${id}/start`, { body: {} });
  assert.equal(missing.status, 400); assert.equal((await missing.json()).code, 'VIDEO_VOICE_REQUIRED');
  assert.equal(await app.wallet.reservation('alice', id), null); assert.equal(app.state.generations, 0);
  await app.call(`/tasks/${id}/model`, { body: { model: PIXVERSE_MODEL } });
  assert.equal((await app.current(id)).sourceAudioMode, 'original');
  assert.equal((await app.call(`/tasks/${id}/source-audio`, { body: { sourceAudioMode: 'silent' } })).status, 400);
  await app.call(`/tasks/${id}/model`, { body: { model: REPLICA_PRICES[0][0] } });
  await app.call(`/tasks/${id}/source-audio`, { body: { sourceAudioMode: 'silent' } });
  await app.call(`/tasks/${id}/source-audio`, { body: { sourceAudioMode: 'original', voiceEngine: 'seedance' } });
  await app.call(`/tasks/${id}/start`, { body: {} });
  await app.until(id, task => task.status === 'running');
  const source = new URL(app.state.creates.find(item => item.kind === 'video').url);
  assert.deepEqual(Buffer.from(await (await fetch(app.base + source.pathname + source.search)).arrayBuffer()), VIDEO);
  assert.equal(app.state.body.payload.params.generateAudio, true);
});

test('silent direct preparation preserves the error while retrying without sending original audio', async t => {
  let clock = Date.now();
  const app = await fixture(t, { now: () => clock, speech: fakeSpeech(),
    voice: async (_input, output) => { await writeFile(output, VIDEO); return { duration: 3 }; } });
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id);
  await app.call(`/tasks/${id}/start`, { body: { sourceAudioMode: 'silent' } });
  for (let attempt = 1; attempt <= 2; attempt++) {
    const retrying = await app.until(id, task => task.recovery?.nextAttemptAt > clock);
    assert.match(retrying.error, /参考视频去除原声失败/); assert.equal(retrying.code, 'VIDEO_AUDIO_REMOVE_FAILED');
    clock = retrying.recovery.nextAttemptAt;
  }
  const waiting = await app.until(id, task => task.status === 'waiting');
  assert.match(waiting.error, /参考视频去除原声失败/); assert.equal(waiting.code, 'VIDEO_AUDIO_REMOVE_FAILED'); assert.equal(waiting.canResume, true);
  const saved = JSON.parse(await readFile(join(app.root, 'video', id, 'task.json'), 'utf8'));
  assert.equal(saved.code, 'VIDEO_AUDIO_REMOVE_FAILED');
  await app.close(); await app.open();
  assert.equal((await app.current(id)).status, 'waiting');
  assert.equal(app.state.creates.length, 0); assert.equal(app.state.generations, 0);
});

test('silent direct mode requires source audio before billing and never substitutes subtitles', async t => {
  const app = await fixture(t, { probe: async () => ({ ...META, audio: false }),
    captions: { extract: async () => assert.fail('Direct voice must not inspect subtitles') },
    speech: fakeSpeech({ analyze: async () => assert.fail('No source audio to transcribe') }),
    voice: async (_input, output) => { await writeFile(output, VIDEO); return { duration: 3 }; },
  });
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id);
  await app.call(`/tasks/${id}/start`, { body: { sourceAudioMode: 'silent' } });
  const waiting = await app.until(id, task => task.status === 'waiting');
  assert.match(waiting.error, /无原声直配需先识别原视频的人声/); assert.equal(waiting.canReplaceSource, true);
  assert.equal(await app.wallet.reservation('alice', id), null);
  assert.equal(app.state.creates.length, 0); assert.equal(app.state.generations, 0);
  assert.equal((await readdir(join(app.root, 'video', id))).includes('source-silent.mp4'), false);
});

for (const savedSubtitles of [false, true]) test(`silent direct transcribes all speech without OCR, including after a subtitle draft switch (${savedSubtitles})`, async t => {
  let extracts = 0, transcriptions = 0;
  const spoken = { ...structuredClone(SPEECH), text: '你好世界没有字幕的这句也要保留' };
  spoken.segments[0].text = spoken.text;
  const app = await fixture(t, { speech: fakeSpeech({ analyze: async input => {
    assert.ok(input.endsWith('source.mp4'), 'Transcribe the original audio before removing it');
    transcriptions++; return structuredClone(spoken);
  } }), captions: { extract: async () => { extracts++; return structuredClone(CAPTIONS); } },
    voice: async (_input, output) => { await writeFile(output, VIDEO); return { duration: 3 }; },
  });
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id);
  if (savedSubtitles) {
    await app.call(`/tasks/${id}/analyze`, { body: {} });
    assert.equal((await app.current(id)).speech.source, 'subtitles');
  }
  await app.call(`/tasks/${id}/source-audio`, { body: { sourceAudioMode: 'silent', voiceEngine: 'seedance' } });
  await app.close(); await app.open();
  for (let i = 0; i < 2; i++) {
    assert.equal((await app.call(`/tasks/${id}/analyze`, { body: {} })).status, 200);
    const task = await app.current(id);
    assert.equal(task.speech.source, 'audio'); assert.equal(task.speech.text, spoken.text);
    assert.equal(task.captions, undefined); assert.equal(task.captionCheck, undefined);
  }
  await app.close(); await app.open();
  await app.call(`/tasks/${id}/analyze`, { body: {} });
  assert.equal(transcriptions, 1, 'Reuse the saved audio transcript after restart');
  assert.equal(extracts, savedSubtitles ? 1 : 0, 'Direct voice must not run OCR');
  const saved = JSON.parse(await readFile(join(app.root, 'video', id, 'task.json'), 'utf8'));
  assert.equal(saved.originalSpeech.source, 'audio'); assert.equal(saved.originalSpeech.text, spoken.text);
});

test('silent direct waits for source transcription without falling back to partial captions or dispatching generation', async t => {
  const app = await fixture(t, { speech: fakeSpeech({ analyze: async () => {
    throw new VideoError('ASR still processing', 502, 'VIDEO_TRANSCRIPTION_PENDING');
  } }), captions: { extract: async () => assert.fail('No subtitle fallback while ASR is pending') },
    voice: async (_input, output) => { await writeFile(output, VIDEO); return { duration: 3 }; },
  });
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id);
  await app.call(`/tasks/${id}/start`, { body: { sourceAudioMode: 'silent' } });
  const task = await app.until(id, item => item.recovery?.state === 'retrying');
  assert.equal(task.status, 'preparing'); assert.equal(task.speech, undefined); assert.equal(task.error, 'ASR still processing');
  assert.equal(app.state.creates.length, 0); assert.equal(app.state.generations, 0);
});

for (const sourceAudioMode of ['original', 'silent']) test(`Seedance ${sourceAudioMode} voice completes without separate TTS or lip-sync`, async t => {
  const app = await fixture(t, { speech: fakeSpeech(), voice: async (_input, output) => { await writeFile(output, VIDEO); return { duration: 5 }; },
    ...(sourceAudioMode === 'silent' ? {
      captions: { extract: async () => assert.fail('Direct voice must not inspect subtitles') },
    } : {}),
    narration: fakeNarration({ prepare: async () => assert.fail('Seedance must not prepare IndexTTS'), advance: async () => assert.fail('Seedance must not synthesize IndexTTS') }),
    lipsync: fakeLipsync({ submit: async () => assert.fail('Seedance must not submit a lip-sync job') }) });
  const config = await (await app.call('/config')).json();
  assert.equal(config.voiceEngine, 'chatterbox'); assert.equal(config.sourceAudioMode, 'original');
  assert.deepEqual(config.voiceEngines.map(engine => engine.id), ['chatterbox']);
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id);
  if (sourceAudioMode === 'silent') {
    const source = join(app.root, 'original.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=s=320x480:r=24:d=6',
      '-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', '-c:v', 'libx264', '-c:a', 'aac', source]);
    assert.equal((await fetch(app.base + `/api/video-replica/tasks/${id}/video`, { method: 'PUT', body: await readFile(source) })).status, 200);
  }
  const started = (await (await app.call(`/tasks/${id}/start`, { body: { sourceAudioMode } })).json()).task;
  assert.equal(started.voiceEngine, 'seedance');
  await app.until(id, task => task.status === 'running');
  assert.deepEqual(app.state.body.payload.referAudioUrl, ['asset://voice-id']);
  app.state.done = true;
  const completed = await app.until(id, task => task.status === 'completed');
  assert.equal(completed.narrationProgress, undefined); assert.equal(app.state.generations, 1);
  assert.deepEqual(Buffer.from(await (await app.call(`/tasks/${id}/result`)).arrayBuffer()), VIDEO);
});

test('new tasks complete after restart without ASR, VAD or duration quality gates', async t => {
  let conversions = 0;
  const app = await fixture(t, { speech: fakeSpeech({ enabled: false,
    analyze: async () => assert.fail('Conversion must not depend on recognized dialogue'),
    detect: async () => assert.fail('Voice upload must not depend on VAD') }),
    voice: async (_input, output) => { await writeFile(output, VIDEO); return { duration: 5 }; },
    probe: async path => ({ ...META, duration: path.endsWith('upload.tmp') || path.endsWith('source.mp4') ? 6 : 4 }),
    voiceConversion: { enabled: true, advance: async (task, folder, save) => {
      if (!task.voiceConversion?.ready) {
        conversions++; task.voiceConversion = { ready: true, duration: 8 };
        await writeFile(join(folder, 'converted-voice.wav'), 'CONVERTED'); await save();
      }
    }, mux: async (_video, audio, output) => writeFile(output, await readFile(audio)) },
    captions: { extract: async () => assert.fail('Direct voice must not read subtitles') },
    narration: fakeNarration({ prepare: async () => assert.fail('Direct voice must not synthesize separate narration') }),
    lipsync: fakeLipsync({ submit: async () => assert.fail('Direct voice must not submit lip sync') }) });
  const id = randomUUID();
  const created = await app.call('/tasks', { body: { requestId: id } });
  assert.equal(created.status, 201);
  const draft = (await created.json()).task;
  assert.equal(draft.voiceEngine, 'chatterbox'); assert.equal(draft.sourceAudioMode, 'original');
  const config = await (await app.call('/config')).json();
  assert.equal(config.voiceEngines[0].enabled, true); assert.equal(config.voiceEnabled, true);
  await app.upload(id);
  const source = join(app.root, 'original.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=s=320x480:r=24:d=6',
    '-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', '-c:v', 'libx264', '-c:a', 'aac', source]);
  assert.equal((await fetch(app.base + `/api/video-replica/tasks/${id}/video`, { method: 'PUT', body: await readFile(source) })).status, 200);
  const missingVoice = await app.call(`/tasks/${id}/start`, { body: {} });
  assert.equal(missingVoice.status, 400); assert.equal((await missingVoice.json()).code, 'VIDEO_VOICE_REQUIRED');
  assert.equal(await app.wallet.reservation('alice', id), null);
  await uploadVoice(app, id); await app.close(); await app.open();
  assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 202);
  const running = await app.until(id, task => task.status === 'running');
  assert.equal(running.voiceEngine, 'chatterbox'); assert.equal(running.sourceAudioMode, 'original');
  assert.equal(running.speech, undefined); assert.equal(running.captions, undefined);
  assert.equal(app.state.body.payload.referAudioUrl, undefined);
  assert.equal(app.state.body.payload.params.generateAudio, false);
  assert.equal((await probeVideo(join(app.root, 'video', id, 'source.mp4'))).audio, true);
  assert.deepEqual(app.state.creates.map(material => material.kind).sort(), ['photo', 'video']);
  app.state.done = true;
  const completed = await app.until(id, task => task.status === 'completed');
  assert.equal(completed.audioCheck.engine, 'chatterbox');
  assert.equal(completed.audioCheck.tempoAdjusted, false);
  assert.equal(completed.audioCheck.lipSync, 'needs_preview');
  assert.equal(completed.actualDuration, 4);
  assert.equal(Buffer.from(await (await app.call(`/tasks/${id}/result`)).arrayBuffer()).toString(), 'CONVERTED');
  assert.equal(conversions, 1);
  assert.equal(app.state.generations, 1);
});

async function segmentedReplica(t, { generate, query, probe, prepareReference, model = PREMIUM_MODEL, duration = 45 } = {}) {
  const calls = { creates: [], generations: [], cuts: [], joins: [], downloads: [], muxes: [], conversions: 0, finished: new Set(), receiptsReady: true };
  const name = path => path.split(/[\\/]/).at(-1);
  const provider = {
    async upload(path, mime) { const kind = name(path).replace(/\.(mp4|jpg)$/, ''); calls.creates.push({ path, kind, mime }); return { id: kind + '-id', status: 2 }; },
    async createMaterial(url, kind) { calls.creates.push({ url, kind }); return { id: kind + '-id', status: 2 }; },
    async queryMaterial() { return 2; },
    async generate(task) {
      calls.generations.push({ material: task.materials.video.id, duration: task.duration, source: task.video.duration, body: model === WAN3_MODEL ? wan3GenerationBody(task) : generationBody(task) });
      return generate ? generate(task) : { taskId: `job-${task.materials.video.id}` };
    },
    async query(id) {
      if (query) return query(id);
      const source = calls.generations.find(item => `job-${item.material}` === id)?.source;
      return calls.finished.has(id) ? { completed: true, url: `https://cdn.example/${id}.mp4`,
        ...(model === WAN3_MODEL && calls.receiptsReady ? { usage: { duration: source * 2, input_video_duration: source, output_video_duration: source, SR: 720 } } : {}) } : {};
    },
  };
  const app = await fixture(t, { costMode: true, provider, wan3Provider: provider, config: { ...CONFIG, wan3Enabled: true },
    ...(prepareReference ? { prepareReference } : {}),
    speech: fakeSpeech({ detect: async () => [{ start: 0.2, end: 10 }, { start: 10.6, end: 44 }] }),
    voice: async (_input, output) => { await writeFile(output, VIDEO); return { duration: 5 }; },
    probe: probe || (async path => ({ ...META, duration: /segment-\d-result\.tmp$/.test(path) ? model === PREMIUM_MODEL ? 25 : 15 : duration })),
    scenes: async () => ({ fps: 30, cuts: [21.03] }),
    cutSegment: async (input, output, start, end) => { calls.cuts.push([name(input), name(output), start, end]); await writeFile(output, VIDEO); },
    joinSegments: async (inputs, segments, output) => {
      calls.joins.push({ inputs: inputs.map(name), spans: segments.map(segment => [segment.start, segment.end]), output: name(output) });
      await writeFile(output, VIDEO); return { ...META, duration, audio: false };
    },
    download: async (url, path) => { calls.downloads.push(url); await writeFile(path, VIDEO); },
    voiceConversion: { enabled: true, advance: async (task, folder, save) => {
      if (task.voiceConversion?.ready) return;
      calls.conversions++; task.voiceConversion = { ready: true, duration };
      await writeFile(join(folder, 'converted-voice.wav'), 'CONVERTED'); await save();
    }, mux: async (_video, audio, output, duration) => { calls.muxes.push(duration); await writeFile(output, await readFile(audio)); } } });
  return Object.assign(app, { calls });
}
async function segmentedDraft(app, model = PREMIUM_MODEL) {
  const id = randomUUID();
  assert.equal((await app.call('/tasks', { body: { requestId: id, model } })).status, 201);
  await app.upload(id); await uploadVoice(app, id);
  return id;
}

for (const model of [PREMIUM_MODEL, WAN3_MODEL]) test(`${model} exposes a failed part's upstream reason and restores it for old held tasks`, async t => {
  let queries = 0;
  const app = await segmentedReplica(t, { model, query: async id => {
    queries++;
    return id === 'job-segment-1-id' ? parseGeneration({ success: true, msg: '操作成功！', data: { status: 3, success: false,
      message: 'The request failed because the output may be related to copyright restrictions. Request id: copyright-2' } }) : {};
  } });
  const id = await segmentedDraft(app, model);
  await app.call(`/tasks/${id}/start`, { body: {} });
  const held = await app.until(id, task => task.status === 'waiting');
  assert.equal(held.code, 'VIDEO_GENERATION_FAILED');
  assert.match(held.error, /第 2 段（[\d.]+–[\d.]+ 秒）视频生成失败：生成结果可能涉及版权限制/);
  assert.match(held.error, /copyright-2/); assert.equal(held.resultUrl, null);
  const generations = app.calls.generations.length;
  await app.close();
  const path = join(app.root, 'video', id, 'task.json'), saved = JSON.parse(await readFile(path, 'utf8'));
  saved.error = '第 2 段视频生成失败，请检查参考素材。'; delete saved.failureReasonCheckedAt; delete saved.segments[1].error;
  await writeFile(path, JSON.stringify(saved)); await app.open();
  const restored = await app.until(id, task => task.error.includes('copyright-2'));
  assert.equal(restored.status, 'waiting'); assert.equal(restored.code, 'VIDEO_GENERATION_FAILED');
  assert.equal(app.calls.generations.length, generations, 'diagnostics must never submit another paid generation');
  const after = queries;
  // Wan may still poll other nonterminal jobs to release concurrency slots.
  if (model !== WAN3_MODEL) { await delay(60); assert.equal(queries, after); }
});

test('single-part failure and rejected material return concrete reasons through the task API', async t => {
  const app = await fixture(t, { query: async () => ({ failed: true, error: 'Output rejected: copyright restrictions' }) });
  const id = await app.init(); await app.upload(id); await app.call(`/tasks/${id}/start`, { body: {} });
  const failed = await app.until(id, task => task.status === 'failed');
  assert.match(failed.error, /视频生成失败：Output rejected: copyright restrictions/);
  assert.equal(failed.code, 'VIDEO_GENERATION_FAILED');
  const materialApp = await fixture(t, { queryMaterial: async () => ({ status: 3, error: 'input image rejected: sensitive content' }) });
  materialApp.state.review = 1;
  const materialId = await materialApp.init(); await materialApp.upload(materialId); await materialApp.call(`/tasks/${materialId}/start`, { body: {} });
  const rejected = await materialApp.until(materialId, task => task.status === 'failed');
  assert.match(rejected.error, /人物照片未通过素材审核：input image rejected: sensitive content/);
  assert.equal(materialApp.state.generations, 0);
});

test('qiya-2.5 generates a 45-second reference as two parts on a scene cut and converts the whole voice once', async t => {
  const app = await segmentedReplica(t), { calls } = app, pointsPerSecond = generationPrice('video', PREMIUM_MODEL).pointsPerSecond;
  const id = await segmentedDraft(app);
  const draft = await app.current(id);
  assert.equal(draft.duration, 50); assert.equal(draft.estimatedPoints, 50 * pointsPerSecond);
  assert.deepEqual(draft.segments, { total: 2, boundary: 'scene', seam: 21.033, submitted: 0, completed: 0, downloaded: 0 });
  assert.equal(draft.video.boundaries, undefined);
  await app.close(); await app.open();
  assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 202);
  const running = await app.until(id, task => task.status === 'running');
  assert.equal((await app.wallet.reservation('alice', id)).reservedUnits, 50);
  assert.equal((await app.wallet.snapshot('alice')).held, 50 * pointsPerSecond);
  assert.deepEqual(running.segments, { total: 2, boundary: 'scene', seam: 21.033, submitted: 2, completed: 0, downloaded: 0 });
  assert.deepEqual(calls.cuts, [['source.mp4', 'segment-0.mp4', 0, 21.033], ['source.mp4', 'segment-1.mp4', 21.033, 45]]);
  assert.deepEqual(calls.creates.map(item => item.kind), ['photo', 'segment-0', 'segment-1']);
  assert.deepEqual(calls.generations.map(item => [item.material, item.duration, item.source]), [['segment-0-id', 25, 21.033], ['segment-1-id', 25, 23.967]]);
  for (const generation of calls.generations) {
    assert.equal(generation.body.payload.params.generateAudio, false);
    assert.ok(generation.body.prompt.includes(`视频1实际时长为${generation.source.toFixed(3)}秒`));
  }
  assert.deepEqual(calls.generations[1].body.payload.referVideoUrl, ['asset://segment-1-id']);
  const signed = new URL(calls.creates[2].url);
  const served = await fetch(app.base + signed.pathname + signed.search);
  assert.equal(served.status, 200); assert.deepEqual(Buffer.from(await served.arrayBuffer()), VIDEO);
  await app.close(); await app.open();
  calls.finished.add('job-segment-0-id');
  assert.equal((await app.until(id, task => task.segments.completed === 1)).status, 'running');
  calls.finished.add('job-segment-1-id');
  const completed = await app.until(id, task => task.status === 'completed' && task.billing?.status === 'settled');
  assert.equal(calls.generations.length, 2); assert.equal(calls.conversions, 1);
  assert.deepEqual(calls.downloads, ['https://cdn.example/job-segment-0-id.mp4', 'https://cdn.example/job-segment-1-id.mp4']);
  assert.deepEqual(calls.joins, [{ inputs: ['segment-0-result.mp4', 'segment-1-result.mp4'], spans: [[0, 21.033], [21.033, 45]], output: 'generated.mp4' }]);
  assert.deepEqual(calls.muxes, [45]);
  assert.equal(completed.actualDuration, 45); assert.equal(completed.duration, 50); assert.equal(completed.segments.downloaded, 2);
  assert.equal(completed.audioCheck.engine, 'chatterbox');
  // Billing follows the delivered source length, never the padded provider tiers.
  assert.equal(completed.billing.chargedPoints, 45 * pointsPerSecond); assert.equal((await app.wallet.snapshot('alice')).held, 0);
  assert.equal(Buffer.from(await (await app.call(`/tasks/${id}/result`)).arrayBuffer()).toString(), 'CONVERTED');
});

for (const model of ['doubao-seedance-2-0-260128', FAST_MODEL, MINI_MODEL, WAN3_MODEL]) for (const duration of [39, 60])
test(`${model} completes ${duration} seconds in valid parts and resumes without duplicate generation`, async t => {
  const app = await segmentedReplica(t, { model, duration }), { calls } = app;
  const id = await segmentedDraft(app, model), total = Math.ceil(duration / 15);
  assert.equal((await app.current(id)).segments.total, total);
  assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 202);
  await app.until(id, task => task.status === 'running');
  assert.equal(calls.generations.length, total); assert.equal(calls.creates.length, total + 1);
  for (const [index, generation] of calls.generations.entries()) {
    assert.ok(generation.source <= 15); assert.ok(generation.duration <= 15);
    assert.equal(generation.material, `segment-${index}-id`);
    if (model === WAN3_MODEL) {
      assert.equal(generation.body.input.media[1].url, generation.material);
      assert.equal(generation.body.parameters.duration, -1); assert.equal(generation.body.parameters.audio, false);
    } else {
      assert.equal(generation.body.modelId, model);
      assert.equal(generation.body.payload.params.generateAudio, false);
    }
  }
  assert.equal(calls.cuts[0][2], 0); assert.equal(calls.cuts.at(-1)[3], duration);
  for (let index = 1; index < total; index++) assert.equal(calls.cuts[index][2], calls.cuts[index - 1][3]);
  await app.close(); await app.open();
  calls.finished.add(`job-segment-${total - 1}-id`);
  await app.until(id, task => task.segments.completed === 1);
  for (let index = 0; index < total; index++) calls.finished.add(`job-segment-${index}-id`);
  const done = await app.until(id, task => task.status === 'completed' && task.billing.status === 'settled');
  assert.equal(calls.generations.length, total); assert.equal(calls.conversions, 1);
  assert.equal(calls.joins.length, 1); assert.equal(calls.joins[0].inputs.length, total);
  assert.deepEqual(calls.muxes, [duration]); assert.equal(done.actualDuration, duration);
  assert.equal(done.billing.chargedPoints, generationPrice('video', model).pointsPerSecond * duration);
  assert.equal((await app.wallet.snapshot('alice')).held, 0);
  assert.equal(Buffer.from(await (await app.call(`/tasks/${id}/result`)).arrayBuffer()).toString(), 'CONVERTED');
  if (model === WAN3_MODEL) {
    const saved = JSON.parse(await readFile(join(app.root, 'video', id, 'task.json'), 'utf8'));
    assert.equal(saved.segments.reduce((sum, segment) => sum + segment.wan3Usage.duration, 0), 2 * duration);
  }
});

test('Wan segmented API-cost recovery sums every receipt, including usage arriving after the video', async t => {
  const app = await segmentedReplica(t, { model: WAN3_MODEL, duration: 60 }), { calls } = app;
  const id = await segmentedDraft(app, WAN3_MODEL), path = join(app.root, 'video', id, 'task.json');
  await app.close();
  const saved = JSON.parse(await readFile(path, 'utf8'));
  const record = await app.wallet.reserveCost({ userId: 'alice', taskId: id });
  Object.assign(saved, { status: 'reviewing', startedAt: Date.now(), cnyPerSecond: .42,
    segments: planSegments(60, { maxSegment: 15, durations: [4, 5, 6, 8, 10, 12, 15] }).segments,
    voiceConversion: { ready: true }, billing: { mode: 'api_cost', status: record.status } });
  await writeFile(path, JSON.stringify(saved));
  await writeFile(join(app.root, 'video', id, 'converted-voice.wav'), 'CONVERTED');
  calls.receiptsReady = false;
  await app.open(); await app.until(id, task => task.status === 'running');
  for (let index = 0; index < 4; index++) calls.finished.add(`job-segment-${index}-id`);
  await app.until(id, task => task.status === 'settling');
  assert.equal((await app.wallet.reservation('alice', id)).costItems.wan3.status, 'uncertain');
  await app.close(); calls.receiptsReady = true; await app.open();
  const done = await app.until(id, task => task.status === 'completed');
  const disk = JSON.parse(await readFile(path, 'utf8')), bill = await app.wallet.reservation('alice', id);
  assert.equal(bill.costItems.wan3.costMicros, Math.round(120 * disk.cnyPerSecond * 1e6));
  assert.equal(done.billing.status, 'settled'); assert.equal(calls.generations.length, 4);
  assert.equal((await app.wallet.snapshot('alice')).held, 0);
});

test('a restart between part submissions sends only unsent parts and holds an unconfirmed part', async t => {
  const app = await segmentedReplica(t), { calls } = app;
  const id = await segmentedDraft(app);
  await app.call(`/tasks/${id}/start`, { body: {} });
  await app.until(id, task => task.status === 'running');
  const path = join(app.root, 'video', id, 'task.json');
  async function interrupt(dispatched) {
    await app.close();
    const saved = JSON.parse(await readFile(path, 'utf8'));
    saved.status = 'submitting'; delete saved.segments[1].providerId; saved.segments[1].providerDispatched = dispatched;
    await writeFile(path, JSON.stringify(saved)); await app.open();
  }
  await interrupt(false);
  await app.until(id, task => task.status === 'running' && task.segments.submitted === 2);
  assert.deepEqual(calls.generations.map(item => item.material), ['segment-0-id', 'segment-1-id', 'segment-1-id']);
  await interrupt(true);
  const held = await app.until(id, task => task.status === 'waiting');
  assert.match(held.recovery.message, /等待确认原生成记录/); assert.equal(held.canResume, false);
  await delay(60);
  assert.equal(calls.generations.length, 3);
});

for (const model of [PREMIUM_MODEL, WAN3_MODEL]) test(`${model} retries only a rejected part after account recovery`, async t => {
  let rejections = 0;
  const app = await segmentedReplica(t, { model, generate: task => {
    if (task.materials.video.id === 'segment-1-id' && !rejections++) throw new VideoError('模型服务拒绝了请求，请检查模型权限、余额或素材要求。', 502, 'VIDEO_PROVIDER_REJECTED');
    return { taskId: `job-${task.materials.video.id}` };
  } });
  const id = await segmentedDraft(app, model);
  await app.call(`/tasks/${id}/start`, { body: {} });
  const held = await app.until(id, task => task.status === 'waiting');
  assert.match(held.recovery.message, /等待账户或额度恢复/); assert.equal(held.canResume, true); assert.equal(held.segments.submitted, 1);
  assert.equal((await app.call(`/tasks/${id}/resume`, { body: {} })).status, 200);
  await app.until(id, task => task.status === 'running' && task.segments.submitted === (model === WAN3_MODEL ? 3 : 2));
  assert.deepEqual(app.calls.generations.map(item => item.material), ['segment-0-id', 'segment-1-id', 'segment-1-id', ...(model === WAN3_MODEL ? ['segment-2-id'] : [])]);
});

test('a long qiya-2.5 reference requires whole-track voice conversion before any reservation', async t => {
  const app = await segmentedReplica(t), id = randomUUID();
  await app.call('/tasks', { body: { requestId: id, model: PREMIUM_MODEL, voiceEngine: 'seedance', sourceAudioMode: 'original' } });
  await app.upload(id);
  const response = await app.call(`/tasks/${id}/start`, { body: {} });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, 'VIDEO_VOICE_ENGINE_INVALID'); assert.match(body.error, /超过 30 秒/);
  assert.equal((await app.current(id)).status, 'draft');
  assert.equal(await app.wallet.reservation('alice', id), null);
  assert.equal(app.calls.generations.length, 0);
});

for (const model of [REPLICA_PRICES[0][0], PREMIUM_MODEL, FAST_MODEL, MINI_MODEL, WAN3_MODEL]) for (const over of [false, true])
test(`${model} automatically splits only above its input limit (over=${over})`, async t => {
  const limit = model === PREMIUM_MODEL ? 30 : 15, duration = limit + (over ? .01 : 0);
  const app = await segmentedReplica(t, { model, duration }), id = await segmentedDraft(app, model);
  const draft = await app.current(id);
  assert.equal(draft.video.duration, duration); assert.equal(draft.targetDuration, undefined);
  assert.equal(draft.segments?.total, over ? 2 : undefined);
  await app.call(`/tasks/${id}/start`, { body: {} }); await app.until(id, task => task.status === 'running');
  assert.equal(app.calls.generations.length, over ? 2 : 1);
  assert.ok(app.calls.generations.every(part => part.source <= limit));
  assert.ok(Math.abs(app.calls.generations.reduce((sum, part) => sum + part.source, 0) - duration) < .001);
  assert.ok(app.calls.cuts.every(cut => cut[1].startsWith('segment-')));
});

for (const duration of [12, 30]) test(`automatic duration keeps a ${duration}-second reference whole in one premium call`, async t => {
  const app = await segmentedReplica(t, { duration }), { calls } = app, id = await segmentedDraft(app);
  const draft = await app.current(id);
  assert.equal(draft.video.duration, duration); assert.equal(draft.segments, undefined);
  assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 202);
  await app.until(id, task => task.status === 'running');
  assert.deepEqual(calls.cuts, []);
  assert.deepEqual(calls.generations.map(item => [item.material, item.source]), [['video-id', duration]]);
});

for (const sourceDuration of [45, 80]) test(`old draft crop settings cannot shorten the ${sourceDuration}-second source`, async t => {
  const app = await segmentedReplica(t), { calls } = app, id = await segmentedDraft(app);
  await app.close();
  const path = join(app.root, 'video', id, 'task.json'), saved = JSON.parse(await readFile(path, 'utf8'));
  saved.targetDuration = 12; saved.video.duration = sourceDuration;
  await writeFile(path, JSON.stringify(saved)); await app.open();
  const draft = await app.current(id);
  assert.equal(draft.targetDuration, undefined); assert.equal(draft.video.duration, sourceDuration);
  const response = await app.call(`/tasks/${id}/start`, { body: {} });
  if (sourceDuration > 60) {
    assert.equal(response.status, 400); assert.equal((await response.json()).code, 'VIDEO_DURATION_INVALID');
    assert.equal(await app.wallet.reservation('alice', id), null); assert.equal(calls.generations.length, 0);
  } else {
    assert.equal(response.status, 202); await app.until(id, task => task.status === 'running');
    assert.equal(calls.cuts[0][2], 0); assert.equal(calls.cuts.at(-1)[3], sourceDuration);
    assert.equal(calls.cuts.length, 2);
    assert.ok(calls.cuts.every(cut => cut[1].startsWith('segment-')));
    assert.equal(calls.generations.reduce((sum, part) => sum + part.source, 0), sourceDuration);
  }
});

test('cached clients cannot select a duration or silently trim oversized uploads', async t => {
  const app = await segmentedReplica(t, { duration: 80 }), id = randomUUID();
  assert.equal((await app.call('/tasks', { body: { requestId: id, model: PREMIUM_MODEL, targetDuration: 12 } })).status, 201);
  assert.equal((await app.current(id)).targetDuration, undefined);
  const response = await fetch(app.base + `/api/video-replica/tasks/${id}/video`, { method: 'PUT', body: VIDEO });
  assert.equal(response.status, 400); assert.equal((await response.json()).code, 'VIDEO_DURATION_INVALID');
  assert.equal((await app.call(`/tasks/${id}/duration`, { body: { targetDuration: 12 } })).status, 410);
  assert.equal(await app.wallet.reservation('alice', id), null); assert.equal(app.calls.generations.length, 0);
});

for (const message of [
  '换声后识别的台词与原声差异较大，已暂停生成，请试听核对素材。',
  '换声时长与原声相差超过 0.25 秒，未强行变速，请检查素材后新建复刻。',
  '换人视频短于原声，未截断台词或强行变速，请新建复刻。',
]) test(`saved conversion quality holds can resume without new paid conversion: ${message}`, async t => {
  const app = await localizedReplica(t);
  await app.call(`/tasks/${app.id}/start`, { body: {} });
  await app.until(app.id, task => task.status === 'running'); await app.close();
  const path = join(app.root, 'video', app.id, 'task.json'), saved = JSON.parse(await readFile(path, 'utf8'));
  saved.status = 'waiting'; saved.error = message; saved.code = 'VIDEO_CONVERSION_FAILED';
  const verifying = message.startsWith('换人视频');
  saved.recovery = { action: 'input', resumeStatus: verifying ? 'verifying' : 'preparing', state: 'waiting' };
  if (verifying) {
    saved.actualDuration = 3;
    await writeFile(join(app.root, 'video', app.id, 'generated.mp4'), VIDEO);
  } else {
    delete saved.providerId; delete saved.providerDispatched; app.state.generations = 0;
  }
  saved.voiceConversion.failed = true;
  saved.voiceConversion.checked = false;
  saved.voiceConversion.id = 'existing-conversion';
  saved.voiceConversion.ready = !message.startsWith('换声时长');
  await writeFile(path, JSON.stringify(saved));
  await app.open({ voiceConversion: { enabled: true,
    advance: async task => {
      assert.equal(task.voiceConversion.failed, undefined); assert.equal(task.voiceConversion.id, 'existing-conversion');
      task.voiceConversion.ready = true;
    },
    mux: async (_video, audio, output) => writeFile(output, await readFile(audio)) } });
  assert.equal((await app.current(app.id)).canResume, true);
  await app.call(`/tasks/${app.id}/resume`, { body: {} }); app.state.done = true;
  assert.equal((await app.until(app.id, task => task.status === 'completed')).audioCheck.engine, 'chatterbox');
  assert.equal(app.counts.conversions, 1); assert.equal(app.state.generations, 1);
});

test('legacy drafts without a recorded voice engine still start with Seedance', async t => {
  const app = await fixture(t);
  const id = await app.init(); await app.upload(id); await app.close();
  const path = join(app.root, 'video', id, 'task.json'), saved = JSON.parse(await readFile(path, 'utf8'));
  delete saved.voiceEngine; await writeFile(path, JSON.stringify(saved)); await app.open();
  assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 202);
  const running = await app.until(id, task => task.status === 'running');
  assert.equal(running.voiceEngine, 'seedance'); assert.equal(app.state.generations, 1);
});

test('a draft can switch back to Seedance without requiring IndexTTS credentials and locks its choice after start', async t => {
  const app = await fixture(t, { speech: fakeSpeech(), voice: async (_input, output) => { await writeFile(output, VIDEO); return { duration: 5 }; },
    narration: fakeNarration({ enabled: false, prepare: async () => assert.fail('IndexTTS is not selected') }), lipsync: fakeLipsync({ enabled: false }) });
  const id = randomUUID();
  assert.equal((await app.call('/tasks', { body: { requestId: id, voiceEngine: 'indextts2', sourceAudioMode: 'original' } })).status, 201);
  await app.upload(id); await uploadVoice(app, id);
  assert.equal((await app.current(id)).voiceEngine, 'indextts2');
  assert.equal((await app.call(`/tasks/${id}/start`, { body: { voiceEngine: 'seedance' } })).status, 202);
  await app.until(id, task => task.status === 'running');
  await app.call(`/tasks/${id}/start`, { body: { voiceEngine: 'indextts2' } });
  assert.equal((await app.current(id)).voiceEngine, 'seedance'); assert.equal(app.state.generations, 1);
  assert.deepEqual(app.state.body.payload.referAudioUrl, ['asset://voice-id']);
});

test('a saved IndexTTS draft retains its voice engine across restart and starts without repeating the selection', async t => {
  const app = await fixture(t, { speech: fakeSpeech(), voice: async (_input, output) => { await writeFile(output, VIDEO); return { duration: 5 }; },
    narration: fakeNarration(), lipsync: fakeLipsync() });
  const id = randomUUID(); await app.call('/tasks', { body: { requestId: id, voiceEngine: 'indextts2', sourceAudioMode: 'original' } });
  await app.upload(id); await uploadVoice(app, id); await app.close(); await app.open();
  assert.equal((await app.current(id)).voiceEngine, 'indextts2');
  await app.call(`/tasks/${id}/start`, { body: {} });
  const running = await app.until(id, task => task.status === 'running');
  assert.equal(running.voiceEngine, 'indextts2'); assert.equal('referAudioUrl' in app.state.body.payload, false);
});

test('invalid voice selection and IndexTTS without a voice fail before any credit reservation or generation', async t => {
  const app = await fixture(t, { narration: fakeNarration(), lipsync: fakeLipsync() });
  const rejected = await app.call('/tasks', { body: { requestId: randomUUID(), voiceEngine: 'unknown' } });
  assert.equal(rejected.status, 400); assert.equal((await rejected.json()).code, 'VIDEO_VOICE_ENGINE_INVALID');
  const id = await app.init(); await app.upload(id);
  for (const [voiceEngine, code] of [['unknown', 'VIDEO_VOICE_ENGINE_INVALID'], ['indextts2', 'VIDEO_VOICE_REQUIRED']]) {
    const response = await app.call(`/tasks/${id}/start`, { body: { voiceEngine } });
    assert.equal(response.status, 400); assert.equal((await response.json()).code, code);
    assert.equal((await app.current(id)).status, 'draft');
    assert.equal(await app.wallet.reservation('alice', id), null);
  }
  assert.equal(app.state.generations, 0);
});

test('IndexTTS and Seedance start in parallel, and new audio waits for real lip-sync before delivery', async t => {
  let releaseTTS, voiceStarted = new Promise(resolve => releaseTTS = resolve), voiceReady = false, mouthSubmits = 0;
  const uploaded = new Map();
  const app = await fixture(t, { speech: fakeSpeech(), voice: async (input, output) => { await writeFile(output, await readFile(input)); return { duration: 5, ready: true }; },
    providerStorage: { upload: async input => { const url = `https://fal.media/${input.split('/').at(-1)}`; uploaded.set(url, await readFile(input)); return url; } },
    generate: async () => { await voiceStarted; return { taskId: 'parallel-video' }; },
    narration: fakeNarration({ advance: async (task, folder, urls, save) => {
      releaseTTS();
      assert.match(urls('voice'), /\/voice\?/);
      if (voiceReady && !task.narration.ready) {
        await writeFile(join(folder, 'narration.wav'), 'INDEXTTS_AUDIO');
        task.narration.ready = true; task.narration.segments[0].status = 'ready'; await save();
      }
    } }),
    lipsync: fakeLipsync({ submit: async (video, audio) => {
      mouthSubmits++;
      for (const [url, expected] of [[video, VIDEO], [audio, Buffer.from('INDEXTTS_AUDIO')]]) {
        assert.equal(new URL(url).hostname, 'fal.media');
        assert.deepEqual(uploaded.get(url), expected);
      }
      return { id: 'mouth-job' };
    } }),
  });
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id);
  await app.call(`/tasks/${id}/start`, { body: { voiceEngine: 'indextts2' } });
  const running = await app.until(id, task => task.status === 'running');
  assert.equal(running.voiceEngine, 'indextts2'); assert.equal(running.narrationProgress.ready, false);
  assert.equal(app.state.creates.some(material => material.kind === 'voice'), false);
  assert.equal('referAudioUrl' in app.state.body.payload, false);
  app.state.done = true; await app.until(id, task => task.status === 'verifying');
  assert.equal(mouthSubmits, 0); assert.equal((await app.call(`/tasks/${id}/result`)).status, 409);
  voiceReady = true;
  const completed = await app.until(id, task => task.status === 'completed' && task.billing.status === 'settled');
  assert.equal(mouthSubmits, 1); assert.equal(app.state.generations, 1);
  assert.deepEqual(completed.audioCheck, { engine: 'indextts2', referenceApplied: true, emotionSource: 'original-video', lipSync: 'processed' });
  assert.equal(await (await app.call(`/tasks/${id}/result`)).text(), 'INDEXTTS_AUDIO');
});

test('pending lip-sync survives service restart without submitting a second paid job', async t => {
  let submits = 0, mouthReady = false, clock = Date.now();
  const app = await fixture(t, { speech: fakeSpeech(), voice: async (_input, output) => { await writeFile(output, VIDEO); return { duration: 5 }; },
    now: () => clock,
    narration: fakeNarration(), lipsync: fakeLipsync({
      submit: async () => { submits++; return { id: 'persisted-mouth' }; },
      query: async job => { assert.equal(job.id, 'persisted-mouth'); if (!mouthReady) throw new VideoError('正在查询原口型任务。', 502, 'VIDEO_LIPSYNC_PENDING'); return 'https://cdn.example/mouth.mp4'; },
    }) });
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id); await app.call(`/tasks/${id}/start`, { body: { voiceEngine: 'indextts2' } });
  await app.until(id, task => task.status === 'running'); app.state.done = true;
  await app.until(id, task => task.status === 'verifying' && task.recovery?.state === 'retrying');
  await app.close(); mouthReady = true; clock += 60_000; await app.open();
  await app.until(id, task => task.status === 'completed');
  assert.equal(submits, 1); assert.equal(app.state.generations, 1);
});

test('a temporary lip-sync download failure retries the saved result without paying twice', async t => {
  let submits = 0, downloads = 0, available = false, clock = Date.now();
  const app = await fixture(t, { speech: fakeSpeech(),
    now: () => clock,
    voice: async (_input, output) => { await writeFile(output, VIDEO); return { duration: 5 }; },
    narration: fakeNarration(),
    lipsync: fakeLipsync({ submit: async () => { submits++; return { id: 'saved-mouth' }; } }),
    download: async (url, output) => {
      if (url.endsWith('/mouth.mp4')) { downloads++; if (!available) throw new Error('connection reset'); }
      await writeFile(output, VIDEO);
    },
  });
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id);
  await app.call(`/tasks/${id}/start`, { body: { voiceEngine: 'indextts2' } });
  await app.until(id, task => task.status === 'running'); app.state.done = true;
  const pending = await app.until(id, task => task.recovery?.state === 'retrying');
  assert.equal(pending.status, 'verifying');
  await app.close(); available = true; clock += 60_000; await app.open();
  await app.until(id, task => task.status === 'completed');
  assert.ok(downloads >= 2); assert.equal(submits, 1); assert.equal(app.state.generations, 1);
});

test('IP whitelist rejection during generation retains the actionable reason', async t => {
  const app = await fixture(t, { generate: async () => {
    throw new VideoError('当前服务器 IP 未获模型服务授权，请管理员配置供应商 IP 白名单。', 502, 'VIDEO_PROVIDER_IP_DENIED');
  } });
  const id = await app.init(); await app.upload(id);
  await app.call(`/tasks/${id}/start`, {body: {}});
  const task = await app.until(id, value => value.status === 'failed');
  assert.equal(task.code, 'VIDEO_PROVIDER_IP_DENIED');
  assert.match(task.error, /IP 白名单/);
  assert.equal(app.state.generations, 1);
});

for (const duration of [3.22, 2.5]) test(`independent narration delivers a generated ${duration}s video`, async t => {
  const app = await fixture(t, { speech: fakeSpeech(),
    voice: async (_input, output) => { await writeFile(output, VIDEO); return { duration: 5 }; },
    narration: fakeNarration(), lipsync: fakeLipsync(),
    probe: async input => ({ ...META, duration: input.endsWith('result.tmp') ? duration
      : input.endsWith('lipsync.mp4') ? SPEECH.end : input.endsWith('upload.tmp') ? 6 : META.duration }),
  });
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id);
  await app.call(`/tasks/${id}/start`, { body: { voiceEngine: 'indextts2' } });
  await app.until(id, task => task.status === 'running'); app.state.done = true;
  const result = await app.until(id, task => ['completed', 'failed'].includes(task.status));
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.actualDuration, duration);
  assert.equal(await (await app.call(`/tasks/${id}/result`)).text(), 'INDEXTTS_AUDIO');
  assert.equal(app.state.generations, 1);
});

test('failed IndexTTS exposes its failure reason while preserving progress and the selected voice', async t => {
  const app = await fixture(t, { speech: fakeSpeech(), voice: async (_input, output) => { await writeFile(output, VIDEO); return { duration: 5 }; },
    narration: fakeNarration({ advance: async () => { throw new VideoError('配音失败', 502, 'VIDEO_NARRATION_FAILED'); } }), lipsync: fakeLipsync() });
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id); await app.call(`/tasks/${id}/start`, { body: { voiceEngine: 'indextts2' } });
  const failed = await app.until(id, task => task.status === 'waiting');
  assert.equal(failed.code, 'VIDEO_NARRATION_FAILED'); assert.equal(failed.error, '配音失败'); assert.equal(failed.resultUrl, null);
  assert.equal(failed.canResume, true); assert.equal(failed.canCancel, true);
  const saved = JSON.parse(await readFile(join(app.root, 'video', id, 'task.json'), 'utf8'));
  assert.equal(saved.code, 'VIDEO_NARRATION_FAILED');
  assert.equal(app.state.generations, 1);
  assert.equal((await app.call(`/tasks/${id}/cancel`, { body: {} })).status, 200);
  assert.equal((await app.current(id)).status, 'cancelled');
});

test('short original references wait before billing and can be replaced in the same draft', async t => {
  let duration = 4;
  const app = await fixture(t, { probe: async () => ({ ...META, duration }), speech: fakeSpeech(),
    voice: async (_input, output) => { await writeFile(output, VIDEO); return { duration: 5 }; },
    narration: fakeNarration(), lipsync: fakeLipsync() });
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id);
  const response = await app.call(`/tasks/${id}/start`, { body: { voiceEngine: 'indextts2' } });
  assert.equal(response.status, 202);
  const waiting = (await response.json()).task;
  assert.equal(waiting.status, 'waiting'); assert.equal(waiting.canReplaceSource, true);
  assert.match(waiting.error, /原视频需包含至少 5 秒原声/); assert.equal(waiting.canResume, false);
  assert.equal(await app.wallet.reservation('alice', id), null); assert.equal(app.state.generations, 0);
  duration = 6;
  assert.equal((await fetch(app.base + `/api/video-replica/tasks/${id}/video`, { method: 'PUT', body: VIDEO })).status, 200);
  assert.equal((await app.current(id)).status, 'draft');
  await app.call(`/tasks/${id}/start`, { body: {} });
  await app.until(id, task => task.status === 'running');
  assert.equal(app.state.generations, 1);
});

test('recovery resumes after restart with the saved video and narration progress, without another video generation', async t => {
  let clock = Date.now(), available = false;
  const app = await fixture(t, { now: () => clock, speech: fakeSpeech(),
    voice: async (_input, output) => { await writeFile(output, VIDEO); return { duration: 5 }; },
    narration: fakeNarration({ advance: async (...args) => {
      if (!available) throw new VideoError('internal provider details', 502, 'VIDEO_NARRATION_PENDING');
      return fakeNarration().advance(...args);
    } }), lipsync: fakeLipsync() });
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id);
  await app.call(`/tasks/${id}/start`, { body: { voiceEngine: 'indextts2' } });
  await app.until(id, task => task.recovery?.state === 'retrying');
  app.state.done = true; clock += 10_000;
  await app.until(id, task => task.status === 'verifying');
  clock += 31 * 60_000;
  const waiting = await app.until(id, task => task.status === 'waiting');
  assert.equal(waiting.canResume, true); assert.match(waiting.error, /30 分钟等待上限.*internal provider details/); assert.equal(waiting.code, 'VIDEO_NARRATION_PENDING');
  assert.equal(waiting.resultUrl, null);
  assert.ok((await readFile(join(app.root, 'video', id, 'generated.mp4'))).length);
  await app.close(); available = true; await app.open();
  assert.equal((await app.current(id)).status, 'waiting');
  assert.equal((await app.call(`/tasks/${id}/resume`, { body: {} })).status, 200);
  assert.equal((await app.call(`/tasks/${id}/resume`, { body: {} })).status, 200);
  await app.until(id, task => task.status === 'completed');
  assert.equal(app.state.generations, 1);
});

test('a provider that stays queued eventually waits for continuation instead of showing endless activity', async t => {
  let clock = Date.now();
  const app = await fixture(t, { now: () => clock, speech: fakeSpeech(),
    voice: async (_input, output) => { await writeFile(output, VIDEO); return { duration: 5 }; },
    narration: fakeNarration(), lipsync: fakeLipsync() });
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id);
  await app.call(`/tasks/${id}/start`, { body: { voiceEngine: 'indextts2' } });
  await app.until(id, task => task.status === 'running');
  clock += 31 * 60_000;
  const waiting = await app.until(id, task => task.status === 'waiting');
  assert.equal(waiting.canResume, true); assert.equal(waiting.resultUrl, null);
  app.state.done = true; await app.call(`/tasks/${id}/resume`, { body: {} });
  await app.until(id, task => task.status === 'completed');
  assert.equal(app.state.generations, 1);
});

test('exhausted narration cannot be reset by resume, and stopping is owner-scoped and idempotent', async t => {
  let advances = 0;
  const app = await fixture(t, { speech: fakeSpeech(),
    voice: async (_input, output) => { await writeFile(output, VIDEO); return { duration: 5 }; },
    narration: fakeNarration({ advance: async () => {
      advances++; throw Object.assign(new VideoError('attempt limit', 502, 'VIDEO_NARRATION_WAITING'), { recoveryAction: 'limit' });
    } }), lipsync: fakeLipsync() });
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id);
  await app.call(`/tasks/${id}/start`, { body: { voiceEngine: 'indextts2' } });
  assert.equal((await app.until(id, task => task.status === 'waiting')).canResume, false);
  await app.call(`/tasks/${id}/resume`, { body: {} });
  assert.equal((await app.current(id)).status, 'waiting'); assert.equal(advances, 1);
  assert.equal((await app.call(`/tasks/${id}/cancel`, { body: {}, owner: 'bob' })).status, 404);
  await app.call(`/tasks/${id}/cancel`, { body: {} }); await app.call(`/tasks/${id}/cancel`, { body: {} });
  assert.equal((await app.current(id)).status, 'cancelled'); assert.equal(advances, 1);
  assert.equal((await app.wallet.reservation('alice', id)).status, 'released');
});

test('missing reference voice or lip-sync configuration fails before reserving credits or generating video', async t => {
  const app = await fixture(t, { speech: fakeSpeech(), voice: async (_input, output) => { await writeFile(output, VIDEO); return { duration: 5 }; },
    narration: fakeNarration({ enabled: false }), lipsync: fakeLipsync() });
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id);
  const response = await app.call(`/tasks/${id}/start`, { body: { voiceEngine: 'indextts2' } });
  assert.equal(response.status, 503); assert.equal((await response.json()).code, 'VIDEO_VOICE_NOT_CONFIGURED');
  assert.equal((await app.current(id)).status, 'draft'); assert.equal(app.state.generations, 0);
});

test('Wan is enabled with its own credentials and validates its 60-second total limit before billing', async t => {
  let duration = 60.1;
  const app = await fixture(t, { costMode: true, config: { wan3Enabled: true },
    now: () => Date.parse('2026-10-21T12:00:00+08:00'), probe: async () => ({ ...META, duration }) });
  const config = await (await app.call('/config')).json();
  assert.equal(config.enabled, true); assert.equal(config.model, WAN3_MODEL);
  assert.deepEqual(config.models.filter(model => model.enabled).map(model => model.id), [WAN3_MODEL, WAN3_FAST_MODEL]);
  assert.equal(config.models.find(model => model.id === WAN3_MODEL).cnyPerSecond, .42);
  const id = randomUUID();
  assert.equal((await app.call('/tasks', { body: { requestId: id, model: WAN3_MODEL, voiceEngine: 'seedance' } })).status, 201);
  const upload = () => fetch(app.base + `/api/video-replica/tasks/${id}/video`, { method: 'PUT', body: VIDEO });
  assert.equal((await upload()).status, 400); assert.equal(await app.wallet.reservation('alice', id), null);
  duration = 4.582; assert.equal((await upload()).status, 200);
  const draft = await app.current(id);
  assert.equal(draft.duration, 4.582); assert.equal(draft.estimatedPoints, 2254);
  await app.close(); await app.open({ config: { wan3Enabled: false } });
  assert.equal((await (await app.call('/config')).json()).enabled, false);
  assert.equal((await app.call('/tasks', { body: { requestId: randomUUID(), model: WAN3_MODEL } })).status, 503);
});

test('Wan queue is shared across users, survives restart and retains stopped upstream slots', async t => {
  let at = Date.now(); const sent = [], finished = new Set(), owners = new Map();
  const app = await fixture(t, { credits: null, config: { ...CONFIG, wan3Enabled: true }, now: () => at,
    wan3Provider: {
      upload: async () => ({ id: 'oss://test/material', status: 2 }),
      generate: async task => {
        const saved = JSON.parse(await readFile(join(app.root, 'video', task.id, 'task.json'), 'utf8'));
        assert.equal(saved.providerDispatched, true); assert.equal(saved.wan3Queue.state, 'active');
        sent.push(task.id); return { taskId: task.id };
      },
      query: async id => finished.has(id) ? { failed: true } : {},
    } });
  const call = (id, action = '', body) => app.call(`/tasks/${id}${action}`, { owner: owners.get(id), body });
  async function until(id, status) {
    for (let i = 0; i < 300; i++) {
      const task = (await (await call(id)).json()).task;
      if (task.status === status) return task;
      await delay(10);
    }
    assert.fail(JSON.stringify((await (await call(id)).json()).task));
  }
  const ids = [];
  for (let i = 0; i < 8; i++) {
    const id = randomUUID(), owner = `user-${i}`; ids.push(id); owners.set(id, owner);
    assert.equal((await app.call('/tasks', { owner, body: { requestId: id, model: WAN3_MODEL, voiceEngine: 'seedance' } })).status, 201);
    for (const kind of ['video', 'photo']) assert.equal((await fetch(app.base + `/api/video-replica/tasks/${id}/${kind}`,
      { method: 'PUT', body: VIDEO, headers: { 'x-test-owner': owner } })).status, 200);
    assert.equal((await call(id, '/start', {})).status, 202);
    await until(id, i < 5 ? 'running' : 'queued');
  }
  assert.equal(sent.length, 5);
  assert.equal((await until(ids[7], 'queued')).queue.position, 3);
  await call(ids[6], '/cancel', {});
  await call(ids[0], '/cancel', {});
  await app.close();
  const path = join(app.root, 'video', ids[5], 'task.json');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  saved.recoveryPolicy = 1; saved.recoveryDeadline = at + 30 * 60_000;
  await writeFile(path, JSON.stringify(saved));
  await app.open(); at += 31 * 60_000;
  assert.equal((await until(ids[7], 'queued')).queue.position, 2);
  await delay(80); assert.equal(sent.length, 5, 'local stop must not free an upstream slot');
  finished.add(ids[0]); await until(ids[5], 'running');
  assert.deepEqual(sent, [...ids.slice(0, 5), ids[5]]);
  assert.equal((await until(ids[0], 'cancelled')).status, 'cancelled');
  finished.add(ids[1]); await until(ids[7], 'running');
  assert.deepEqual(sent, [...ids.slice(0, 5), ids[5], ids[7]]);
  assert.equal(new Set(sent).size, sent.length);
});

for (const confirmed of [true, false]) test(`Wan restores a dispatch saved while queued without replay (confirmed=${confirmed})`, async t => {
  let submissions = 0;
  const app = await fixture(t, { credits: null, config: { ...CONFIG, wan3Enabled: true },
    wan3Provider: { upload: async () => ({ id: 'oss://test/material', status: 2 }),
      generate: async () => { submissions++; return { taskId: 'existing-wan' }; }, query: async () => ({}) } });
  const id = randomUUID();
  await app.call('/tasks', { body: { requestId: id, model: WAN3_MODEL, voiceEngine: 'seedance' } }); await app.upload(id);
  await app.call(`/tasks/${id}/start`, { body: {} }); await app.until(id, task => task.status === 'running');
  await app.close();
  const path = join(app.root, 'video', id, 'task.json'), task = JSON.parse(await readFile(path, 'utf8'));
  task.status = 'queued'; task.recoveryPolicy = 1;
  if (!confirmed) delete task.providerId;
  await writeFile(path, JSON.stringify(task));
  await app.open(); const restored = await app.until(id, task => task.status === (confirmed ? 'running' : 'waiting'));
  if (!confirmed) assert.equal(restored.canResume, false);
  assert.equal(submissions, 1);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).wan3Queue.state, 'active');
});

test('Wan throttled generation stays queued and resumes automatically after restart', async t => {
  let at = Date.now(), attempts = 0;
  const app = await fixture(t, { credits: null, config: { ...CONFIG, wan3Enabled: true }, now: () => at,
    wan3Provider: {
      upload: async () => ({ id: 'oss://test/material', status: 2 }),
      generate: async () => {
        if (++attempts === 1) throw Object.assign(new VideoError('limited', 429, 'VIDEO_PROVIDER_RATE_LIMITED'), { providerNotDispatched: true, retryAfterMs: 7000 });
        return { taskId: 'accepted' };
      }, query: async () => ({}),
    } });
  const id = randomUUID();
  await app.call('/tasks', { body: { requestId: id, model: WAN3_MODEL, voiceEngine: 'seedance' } }); await app.upload(id);
  await app.call(`/tasks/${id}/start`, { body: {} });
  await app.until(id, task => task.status === 'queued' && attempts === 1);
  await app.close(); await app.open(); at += 6999;
  await delay(80); assert.equal(attempts, 1);
  at++; await app.until(id, task => task.status === 'running');
  assert.equal(attempts, 2);
});

test('Wan partially queued long videos query finished parts and continue without deadlock', async t => {
  const app = await segmentedReplica(t, { model: WAN3_MODEL, duration: 60 }), { calls } = app;
  const first = await segmentedDraft(app, WAN3_MODEL), second = await segmentedDraft(app, WAN3_MODEL);
  await app.call(`/tasks/${first}/start`, { body: {} }); await app.until(first, task => task.status === 'running');
  await app.call(`/tasks/${second}/start`, { body: {} });
  await app.until(second, task => task.status === 'queued' && task.segments.submitted === 1);
  assert.equal(calls.generations.length, 5);
  await app.close(); await app.open();
  calls.finished.add('job-segment-0-id');
  await app.until(second, task => task.status === 'queued' && task.segments.submitted === 3);
  assert.equal(calls.generations.length, 7);
  for (let i = 0; i < 4; i++) calls.finished.add(`job-segment-${i}-id`);
  await app.until(first, task => task.status === 'completed');
  await app.until(second, task => task.status === 'completed');
  assert.equal(calls.generations.length, 8); assert.equal(calls.conversions, 2); assert.equal(calls.joins.length, 2);
});

for (const outcome of ['completed', 'failed', 'uncertain']) test(`Wan ${outcome} keeps one dispatch and the model price after restart`, async t => {
  let submissions = 0, uploads = 0, ready = false;
  const app = await fixture(t, { costMode: true, config: { wan3Enabled: true },
    now: () => Date.parse('2026-10-21T12:00:00+08:00'), probe: async () => ({ ...META, duration: 4.582 }),
    wan3Provider: {
      upload: async () => ({ id: `oss://test/material-${++uploads}`, status: 2 }),
      generate: async () => { submissions++; if (outcome === 'uncertain') throw new VideoError('Lost response', 502, 'VIDEO_PROVIDER_UNAVAILABLE'); return { taskId: 'wan-one-job' }; },
      query: async id => { assert.equal(id, 'wan-one-job'); return !ready ? {} : outcome === 'failed' ? { failed: true }
        : { completed: true, url: 'https://result.example/wan.mp4' }; },
    } });
  const id = randomUUID();
  await app.call('/tasks', { body: { requestId: id, model: WAN3_MODEL, voiceEngine: 'seedance' } });
  await app.upload(id);
  assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 202);
  await app.until(id, task => task.status === (outcome === 'uncertain' ? 'failed' : 'running'));
  await app.close(); ready = true; await app.open();
  if (outcome === 'completed') {
    const done = await app.until(id, task => task.status === 'completed');
    assert.equal(done.billing.chargedPoints, 2254);
    const bill = await app.wallet.reservation('alice', id);
    assert.equal(bill.settledUnits, 4.582); assert.equal(bill.pricingKey, generationPrice('video', WAN3_MODEL).key);
  } else {
    await app.until(id, task => task.status === 'failed' && task.billing?.status === 'released');
    assert.equal((await app.wallet.reservation('alice', id)).chargedPoints, 0);
    assert.equal((await app.wallet.snapshot('alice')).held, 0);
  }
  await app.call(`/tasks/${id}/start`, { body: {} });
  assert.equal(submissions, 1); assert.equal(uploads, 2); assert.equal(app.state.generations, 0);
});

for (const voice of [false, true]) test(`Wan delivers the completed file without border restoration (voice=${voice})`, async t => {
  let conversions = 0, submissions = 0;
  const app = await fixture(t, { config: { ...CONFIG, wan3Enabled: true },
    wan3Provider: {
      upload: async () => ({ id: 'oss://test/material', status: 2 }),
      generate: async () => { submissions++; return { taskId: 'wan-job' }; },
      query: async () => ({ completed: true, url: 'https://result.example/wan.mp4' }),
    },
    voiceConversion: { enabled: true,
      advance: async task => { task.voiceConversion = { ready: true }; return true; },
      mux: async (_video, _voice, output) => { conversions++; await writeFile(output, 'muxed'); },
    } });
  const id = randomUUID();
  await app.call('/tasks', { body: { requestId: id, model: WAN3_MODEL, voiceEngine: voice ? 'chatterbox' : 'seedance' } });
  await app.upload(id);
  if (voice) assert.equal((await fetch(app.base + `/api/video-replica/tasks/${id}/voice`, { method: 'PUT', body: await readFile(new URL('./fixtures/replica-speech.wav', import.meta.url)) })).status, 200);
  assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 202);
  const done = await app.until(id, task => task.status === 'completed');
  assert.equal(conversions, Number(voice)); assert.equal(submissions, 1);
  assert.equal(done.frameBorders, undefined);
  assert.ok(done.resultUrl);
  assert.deepEqual(await readFile(join(app.root, 'video', id, 'result.mp4')), voice ? Buffer.from('muxed') : VIDEO);
});

test('Seedance uses the agreed 410 points per second and settles only once',async t=>{
  const app=await fixture(t,{costMode:true}),id=await app.init();await app.upload(id);
  assert.equal((await app.current(id)).estimatedPoints,1640,'upload quote uses the new rule before starting');
  assert.equal((await app.call(`/tasks/${id}/start`,{body:{}})).status,202);
  await app.until(id,task=>task.status==='running');assert.equal((await app.wallet.snapshot('alice')).held,1640);
  app.state.done=true;const done=await app.until(id,task=>task.status==='completed'&&task.billing.status==='settled');
  assert.equal(done.billing.mode,'model_price');assert.equal(done.billing.chargedPoints,1640);
  await app.call(`/tasks/${id}/start`,{body:{}});assert.equal(app.state.generations,1);assert.equal((await app.wallet.snapshot('alice')).available,TEST_BALANCE-1640);
});

test('actual-cost Seedance stops an unaffordable video before any paid generation',async t=>{
  const app=await fixture(t,{costMode:true,balance:1000,probe:async()=>({...META,duration:12})}),id=await app.init();await app.upload(id);
  const response=await app.call(`/tasks/${id}/start`,{body:{}});assert.equal(response.status,402);
  assert.equal(app.state.generations,0);assert.equal((await app.wallet.snapshot('alice')).available,1000);
});

test('unknown Seedance submission refunds the customer without dispatching a duplicate',async t=>{
  const app=await fixture(t,{costMode:true,uncertain:true}),id=await app.init();await app.upload(id);
  assert.equal((await app.call(`/tasks/${id}/start`,{body:{}})).status,202);
  const failed=await app.until(id,task=>task.status==='failed'&&task.billing?.status==='released');assert.equal(failed.billing.chargedPoints,0);
  await app.call(`/tasks/${id}/start`,{body:{}});
  assert.equal((await app.wallet.snapshot('alice')).held,0);assert.equal(app.state.generations,1);
});
test('replica includes IndexTTS and lip-sync in the model price, without a second fee',async t=>{
  let mouths=0;
  const app=await fixture(t,{costMode:true,speech:fakeSpeech(),voice:async(_input,output)=>{await writeFile(output,VIDEO);return{duration:5};},
    narration:fakeNarration(),lipsync:fakeLipsync({submit:async()=>{mouths++;return{id:'aggregate-mouth'};}})});
  const id=await app.init();await app.upload(id);await uploadVoice(app,id);
  assert.equal((await app.call(`/tasks/${id}/start`,{body:{voiceEngine:'indextts2'}})).status,202);
  await app.until(id,task=>task.status==='running');app.state.done=true;
  const done=await app.until(id,task=>task.status==='completed'&&task.billing.status==='settled');
  assert.equal(done.billing.chargedPoints,1640);assert.equal(mouths,1);
  assert.equal((await app.wallet.reservation('alice',id)).pricingKey,generationPrice('video','doubao-seedance-2-0-260128').key);
});
test('rejected replica materials release the aggregate hold before paid video generation',async t=>{
  const app=await fixture(t,{costMode:true}),id=await app.init();await app.upload(id);app.state.review=3;
  await app.call(`/tasks/${id}/start`,{body:{}});
  const failed=await app.until(id,task=>task.status==='failed'&&task.billing.status==='released');
  assert.equal(failed.billing.chargedPoints,0);assert.equal(app.state.generations,0);
  assert.equal((await app.wallet.snapshot('alice')).held,0);
});

test('PixVerse survives restart, uploads once, restores captions and meters replacement and lip sync separately', async t => {
  const model = PIXVERSE_MODEL;
  let done = false, rendered = 0;
  const replacementRate = 0.05, replacementUnits = 4;
  const posts = [], uploads = [];
  const job = (model, id) => ({ request_id: id, status_url: `https://queue.fal.run/${model}/requests/${id}/status`,
    response_url: `https://queue.fal.run/${model}/requests/${id}` });
  const app = await fixture(t, { costMode: true, env: { FAL_KEY: 'test-key' },
    config: { ...CONFIG, falEnabled: true, falKey: 'test-key' }, speech: fakeSpeech(),
    voice: async (_input, output) => { await writeFile(output, VIDEO); return { duration: 5 }; },
    narration: fakeNarration(), lipsync: undefined,
    captions: { extract: async () => CAPTIONS, render: async (input, output) => {
      rendered++; await writeFile(output, await readFile(input)); return { rendered: true };
    } },
    providerStorage: { upload: async (input, type) => { uploads.push({ input, type }); return `https://fal.media/file-${uploads.length}`; } },
    fetchImpl: async (url, options = {}) => {
      const target = new URL(url);
      if (target.hostname === 'api.fal.ai') {
        const endpoint = target.searchParams.get('endpoint_id');
        return Response.json({ prices: [{ endpoint_id: endpoint, currency: 'USD', unit_price: endpoint === model ? replacementRate : 0.1 }] });
      }
      if (target.hostname === 'www.openlux.ai') return Response.json({ data: target.pathname.endsWith('/status') ? { usd_exchange_rate: 5 } : [] });
      assert.equal(target.hostname, 'queue.fal.run');
      if (options.method === 'POST') {
        posts.push({ url: String(url), body: JSON.parse(options.body) });
        return Response.json(target.pathname === '/' + model ? job('fal-ai/pixverse', 'swap-1') : job('veed/lipsync', 'mouth-1'));
      }
      if (target.pathname.endsWith('/status')) return Response.json({ status: done ? 'COMPLETED' : 'IN_PROGRESS' });
      return Response.json({ video: { url: 'https://fal.media/result.mp4' } },
        { headers: { 'x-fal-billable-units': String(target.pathname.endsWith('/swap-1') ? replacementUnits : 4) } });
    },
  });
  const id = randomUUID();
  await app.call('/tasks', { body: { requestId: id, model, voiceEngine: 'indextts2', sourceAudioMode: 'original' } });
  await app.upload(id); await uploadVoice(app, id);
  assert.equal((await app.current(id)).estimatedPoints, null);
  assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 202);
  await app.until(id, task => task.status === 'running');
  assert.equal(posts.length, 1); assert.equal(uploads.length, 2); assert.equal(app.state.generations, 0);
  assert.equal(app.state.creates.length, 0);
  assert.equal(posts[0].body.image_url, 'https://fal.media/file-1');
  assert.equal(posts[0].body.video_url, 'https://fal.media/file-2');
  assert.equal(posts[0].url, `https://queue.fal.run/${model}`);
  await app.close(); await app.open();
  done = true;
  const completed = await app.until(id, task => task.status === 'completed' && task.billing.status === 'settled');
  assert.equal(completed.modelName, 'PixVerse Swap'); assert.equal(completed.audioCheck.referenceApplied, true);
  assert.equal(completed.captionCheck.rendered, true); assert.equal(rendered, 1);
  assert.equal(posts.length, 2); assert.equal(uploads.length, 4);
  assert.equal(posts[1].url, 'https://queue.fal.run/veed/lipsync');
  assert.equal(completed.billing.costCny, 3); assert.equal(completed.billing.chargedPoints, 375);
  const items = Object.values((await app.wallet.reservation('alice', id)).costItems);
  assert.deepEqual(items.map(item => item.metadata.model).sort(), [model, 'veed/lipsync']);
  assert.ok(items.every(item => item.provider === 'fal'));
  assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 200);
  await app.close(); await app.open(); await delay(50);
  assert.equal(posts.length, 2);
});

test('PixVerse rejects incompatible dimensions and direct voice replacement before any paid request', async t => {
  let meta = { ...META, height: 1921 };
  const app = await fixture(t, { costMode: true, config: { ...CONFIG, falEnabled: true }, probe: async () => meta,
    speech: fakeSpeech(), voice: async (_input, output) => { await writeFile(output, VIDEO); return { duration: 5 }; } });
  const id = randomUUID();
  await app.call('/tasks', { body: { requestId: id, model: PIXVERSE_MODEL, voiceEngine: 'seedance' } });
  const invalid = await fetch(app.base + `/api/video-replica/tasks/${id}/video`, { method: 'PUT', body: VIDEO });
  assert.equal(invalid.status, 400); assert.match((await invalid.json()).error, /1920/);
  meta = META; await app.upload(id); await uploadVoice(app, id);
  const response = await app.call(`/tasks/${id}/start`, { body: {} });
  assert.equal(response.status, 400); assert.equal((await response.json()).code, 'VIDEO_VOICE_ENGINE_INVALID');
  assert.equal((await app.current(id)).status, 'draft'); assert.equal((await app.wallet.snapshot('alice')).held, 0);
});

test('an uncertain PixVerse submission is not replayed or charged as Seedance after restart', async t => {
  const model = PIXVERSE_MODEL;
  let posts = 0;
  const app = await fixture(t, { costMode: true, config: { ...CONFIG, falEnabled: true, falKey: 'test' },
    fetchImpl: async (url, options = {}) => {
      const target = new URL(url);
      if (target.hostname === 'api.fal.ai') return Response.json({ prices: [{ endpoint_id: model, currency: 'USD', unit_price: 0.05 }] });
      if (target.hostname === 'www.openlux.ai') return Response.json({ data: { usd_exchange_rate: 5 } });
      assert.equal(options.method, 'POST'); posts++; throw new Error('Lost receipt');
    } });
  const id = randomUUID();
  await app.call('/tasks', { body: { requestId: id, model, voiceEngine: 'seedance' } });
  await app.upload(id); await app.call(`/tasks/${id}/start`, { body: {} });
  assert.equal((await app.until(id, task => task.status === 'failed')).code, 'VIDEO_SUBMISSION_UNCERTAIN');
  await app.close(); await app.open();
  await app.call(`/tasks/${id}/start`, { body: {} }); await delay(50);
  assert.equal(posts, 1); assert.equal(app.state.generations, 0);
  assert.equal((await app.wallet.reservation('alice', id)).costItems.seedance, undefined);
  assert.equal((await app.wallet.snapshot('alice')).held, 625, 'Unknown upstream cost must remain held for audit');
});

test('a missing PixVerse usage header is rechecked after restart without regenerating or guessing a charge', async t => {
  const model = PIXVERSE_MODEL;
  let usageReady = false, posts = 0;
  const app = await fixture(t, { costMode: true, config: { ...CONFIG, falEnabled: true, falKey: 'test' },
    fetchImpl: async (url, options = {}) => {
      const target = new URL(url);
      if (target.hostname === 'api.fal.ai') return Response.json({ prices: [{ endpoint_id: model, currency: 'USD', unit_price: 0.05 }] });
      if (target.hostname === 'www.openlux.ai') return Response.json({ data: { usd_exchange_rate: 5 } });
      if (options.method === 'POST') {
        posts++; return Response.json({ request_id: 'receipt-late',
          status_url: `https://queue.fal.run/${model}/requests/receipt-late/status`,
          response_url: `https://queue.fal.run/${model}/requests/receipt-late` });
      }
      if (target.pathname.endsWith('/status')) return Response.json({ status: 'COMPLETED' });
      return Response.json({ video: { url: 'https://fal.media/result.mp4' } }, { headers: usageReady ? { 'x-fal-billable-units': '4' } : {} });
    } });
  const id = randomUUID();
  await app.call('/tasks', { body: { requestId: id, model, voiceEngine: 'seedance' } });
  await app.upload(id); await app.call(`/tasks/${id}/start`, { body: {} });
  const pending = await app.until(id, task => task.status === 'settling');
  assert.equal(pending.resultUrl, null); assert.equal(pending.billing.chargedPoints, 0);
  await app.close(); usageReady = true; await app.open();
  const done = await app.until(id, task => task.status === 'completed');
  assert.equal(done.billing.chargedPoints, 125); assert.equal(done.billing.costCny, 1); assert.equal(posts, 1);
});

for (const duration of [2, 15, 30, 30.1]) test(`PixVerse applies the workspace 30-second source limit to ${duration} seconds`, async t => {
  const model = PIXVERSE_MODEL;
  const app = await fixture(t, { costMode: true, config: { ...CONFIG, falEnabled: true }, probe: async () => ({ ...META, duration }) });
  const id = randomUUID(); await app.call('/tasks', { body: { requestId: id, model } });
  const response = await fetch(app.base + `/api/video-replica/tasks/${id}/video`, { method: 'PUT', body: VIDEO });
  assert.equal(response.status, duration <= 30 ? 200 : 400);
  if (duration <= 30) assert.equal((await app.current(id)).duration, duration);
  assert.equal((await app.wallet.snapshot('alice')).held, 0);
});

test('PixVerse cannot silently use legacy fixed pricing when actual-cost billing is disabled', async t => {
  const model = PIXVERSE_MODEL;
  const app = await fixture(t, { config: { ...CONFIG, falEnabled: true, falKey: 'test' } });
  const config = await (await app.call('/config')).json();
  assert.equal(config.models.find(item => item.id === model), undefined);
  assert.equal((await app.call('/tasks', { body: { requestId: randomUUID(), model } })).status, 503);
});

test('PixVerse draft switching clears the Seedance audio mode and rejects direct Seedance voice before billing', async t => {
  const app = await fixture(t, { costMode: true, config: { ...CONFIG, falEnabled: true }, speech: fakeSpeech(),
    voice: async (_input, output) => { await writeFile(output, VIDEO); return { duration: 5 }; } });
  const id = await app.init(); await app.upload(id); await uploadVoice(app, id);
  await app.call(`/tasks/${id}/source-audio`, { body: { sourceAudioMode: 'silent' } });
  assert.equal((await app.call(`/tasks/${id}/model`, { body: { model: PIXVERSE_MODEL } })).status, 200);
  const task = await app.current(id);
  assert.equal(task.model, PIXVERSE_MODEL); assert.equal(task.sourceAudioMode, 'original');
  assert.equal(task.voiceEngine, 'indextts2');
  assert.equal(task.estimatedPoints, null);
  assert.equal((await app.call(`/tasks/${id}/source-audio`, { body: { sourceAudioMode: 'silent' } })).status, 400);
  const rejected = await app.call(`/tasks/${id}/start`, { body: { voiceEngine: 'seedance' } });
  assert.equal(rejected.status, 400); assert.equal((await rejected.json()).code, 'VIDEO_VOICE_ENGINE_INVALID');
  assert.equal((await app.current(id)).status, 'draft');
  assert.equal((await app.wallet.snapshot('alice')).held, 0); assert.equal(app.state.generations, 0);
});

test('deep voice task resumes separation and conversion receipts, then mixes background with the unchanged model price', async t => {
  let separated = false, converted = false, original, audio;
  const posts = [];
  const app = await fixture(t, { costMode: true, voiceConversion: undefined, env: { FAL_KEY: 'test-only-key' },
    config: { ...CONFIG, falKey: 'test-only-key' },
    providerStorage: { upload: async path => 'https://fal.media/' + path.split(/[\\/]/).at(-1) },
    voice: async (_input, output) => { await writeFile(output, await readFile(audio)); return { duration: 4 }; },
    download: async (_url, output) => writeFile(output, await readFile(output.endsWith('.wav') ? audio : original)),
    fetchImpl: async (url, options) => {
      const target = new URL(url);
      assert.equal(target.hostname, 'queue.fal.run', 'fixed model price must keep the existing billing route');
      const sam = target.pathname.startsWith('/fal-ai/sam-audio');
      if (options.method === 'POST') {
        posts.push(target.pathname);
        const base = `https://queue.fal.run/fal-ai/${sam ? 'sam-audio' : 'chatterbox'}/requests/${sam ? 'sam-1' : 'voice-1'}`;
        return Response.json({ request_id: sam ? 'sam-1' : 'voice-1', status_url: base + '/status', response_url: base });
      }
      if (target.pathname.endsWith('/status')) return Response.json({ status: (sam ? separated : converted) ? 'COMPLETED' : 'IN_PROGRESS' });
      return Response.json(sam ? { target: { url: 'https://fal.media/vocals.wav' }, residual: { url: 'https://fal.media/background.wav' } }
        : { audio: { url: 'https://fal.media/converted.wav' } });
    } });
  original = join(app.root, 'original.mp4'); audio = join(app.root, 'audio.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=s=160x240:r=25:d=4',
    '-f', 'lavfi', '-i', 'sine=duration=4', '-c:v', 'libx264', '-c:a', 'aac', original]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', original, '-vn', audio]);
  const id = randomUUID();
  await app.call('/tasks', { body: { requestId: id, mode: 'deep', replacements: { voice: true } } });
  await fetch(app.base + `/api/video-replica/tasks/${id}/video`, { method: 'PUT', body: await readFile(original) });
  await uploadVoice(app, id);
  assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 202);
  const separating = await app.until(id, task => task.voiceConversionProgress?.preserveBackground && posts.length === 1);
  assert.equal(separating.voiceConversionProgress.separationReady, false); assert.equal(app.state.generations, 0);
  assert.doesNotMatch(JSON.stringify(separating), /fal\.media|queue\.fal|test-only-key/);
  await app.close(); separated = true; await app.open();
  await app.until(id, task => task.voiceConversionProgress?.separationReady && posts.length === 2);
  await app.close(); converted = true; await app.open();
  await app.until(id, task => task.status === 'running'); app.state.done = true;
  const done = await app.until(id, task => task.status === 'completed');
  assert.equal(done.audioCheck.backgroundAudioPreserved, true);
  assert.match(done.audioCheck.warning, /混回原背景声/);
  assert.equal(done.billing.chargedPoints, generationPrice('video', done.model).pointsPerSecond * 4);
  assert.deepEqual(posts, ['/fal-ai/sam-audio/separate', '/fal-ai/chatterbox/speech-to-speech']);
  assert.equal(app.state.generations, 1);
  const metadata = await probeVideo(join(app.root, 'video', id, 'result.mp4'));
  assert.equal(metadata.duration, 4); assert.equal(metadata.audio, true);
});

for (const uncertain of [false, true]) test(`deep separation ${uncertain ? 'uncertain' : 'failed'} task cannot resume a paid submission`, async t => {
  const app = await fixture(t, { voice: async (_input, output) => { await writeFile(output, VIDEO); return { duration: 4 }; },
    voiceConversion: { enabled: true, advance: async (task, _folder, save) => {
      task.voiceConversion = { ready: false, preserveBackground: true, separation: { [uncertain ? 'submitting' : 'failed']: true } };
      await save(); throw new VideoError('人声分离未完成', 502, uncertain ? 'VIDEO_CONVERSION_UNCERTAIN' : 'VIDEO_CONVERSION_FAILED');
    } } });
  const id = randomUUID(); await app.call('/tasks', { body: { requestId: id, mode: 'deep', replacements: { voice: true } } });
  await fetch(app.base + `/api/video-replica/tasks/${id}/video`, { method: 'PUT', body: VIDEO }); await uploadVoice(app, id);
  await app.call(`/tasks/${id}/start`, { body: {} });
  const waiting = await app.until(id, task => task.status === 'waiting');
  assert.equal(waiting.canResume, false); assert.equal(app.state.generations, 0);
  await app.close(); await app.open();
  assert.equal((await app.current(id)).canResume, false);
});

const DEEP_MODELS = ['doubao-seedance-2-0-260128', PREMIUM_MODEL, FAST_MODEL, MINI_MODEL, WAN3_MODEL];
for (const model of DEEP_MODELS) for (const selected of [[], ['photo'], ['product'], ['background'], ['voice'], ['photo', 'voice', 'product', 'background']]) {
  test(`deep ${model} completes with ${selected.join('+') || 'all original'} and preserves options across restart`, async t => {
    const replacements = Object.fromEntries(['photo', 'voice', 'product', 'background'].map(kind => [kind, selected.includes(kind)]));
    const calls = { materials: [], generations: [], conversions: 0, restores: 0, muxes: 0, extracts: 0, renders: 0 };
    let done = false;
    const provider = {
      createMaterial: async (_url, kind) => { calls.materials.push(kind); return { id: kind + '-id', status: 2 }; },
      upload: async path => { const kind = path.split(/[\\/]/).at(-1).replace('.jpg', '').replace('source.mp4', 'video'); calls.materials.push(kind); return { id: kind + '-id', status: 2 }; },
      generate: async task => { calls.generations.push(model === WAN3_MODEL ? wan3GenerationBody(task) : generationBody(task)); return { taskId: 'deep-job' }; },
      query: async () => done ? { url: 'https://cdn.example/deep.mp4' } : {},
    };
    const app = await fixture(t, { provider, wan3Provider: provider, config: { ...CONFIG, wan3Enabled: true },
      captions: { extract: async () => { calls.extracts++; return structuredClone(CAPTIONS); },
        render: async () => { calls.renders++; throw new Error('Deep replicas must not repaint or inpaint captions'); } },
      voice: async (_input, output) => { await writeFile(output, VIDEO); return { duration: 4 }; },
      restoreAudio: async (_source, _generated, output) => { calls.restores++; await writeFile(output, VIDEO); },
      voiceConversion: { enabled: replacements.voice, advance: async (task, _folder, save) => { calls.conversions++; task.voiceConversion = { ready: true }; await save(); },
        mux: async (_video, _audio, output) => { calls.muxes++; await writeFile(output, VIDEO); } } });
    const id = randomUUID();
    assert.equal((await app.call('/tasks', { body: { requestId: id, model, mode: 'deep', replacements } })).status, 201);
    for (const kind of ['video', ...selected]) {
      const response = await fetch(app.base + `/api/video-replica/tasks/${id}/${kind}`, { method: 'PUT', body: VIDEO });
      assert.equal(response.status, 200, await response.text());
    }
    await app.close(); await app.open();
    assert.deepEqual((await app.current(id)).replacements, replacements);
    // Legacy request overrides must not enable sound or disable preservation in deep mode.
    const response = await app.call(`/tasks/${id}/start`, { body: { voiceEngine: 'indextts2', sourceAudioMode: 'silent' } });
    assert.equal(response.status, 202, await response.text());
    await app.until(id, task => task.status === 'running');
    const expected = ['photo', 'product', 'background'].filter(kind => replacements[kind]);
    assert.deepEqual(calls.materials.sort(), [...expected, 'video'].sort());
    assert.equal(calls.generations.length, 1);
    const resources = model === WAN3_MODEL ? calls.generations[0].input.media.filter(media => media.type === 'reference_image').map(media => media.url)
      : calls.generations[0].payload.resources.map(url => url.replace('asset://', ''));
    assert.deepEqual(resources, expected.map(kind => kind + '-id'));
    assert.match(calls.generations[0].prompt || calls.generations[0].input.prompt, /去除视频1中画面叠加的台词字幕/);
    await app.close(); await app.open(); done = true;
    const completed = await app.until(id, task => task.status === 'completed');
    assert.equal(completed.mode, 'deep'); assert.equal(completed.model, model); assert.ok(completed.resultUrl);
    assert.deepEqual(completed.replacements, replacements);
    assert.equal(calls.generations.length, 1); assert.equal(calls.conversions, Number(replacements.voice));
    assert.equal(calls.restores, Number(!replacements.voice)); assert.equal(calls.muxes, Number(replacements.voice));
    assert.equal(calls.extracts, 0); assert.equal(calls.renders, 0);
    assert.equal(completed.captions, undefined); assert.equal(completed.captionCheck, undefined);
    assert.deepEqual(Buffer.from(await (await app.call(`/tasks/${id}/result`)).arrayBuffer()), VIDEO);
    assert.equal(completed.billing.status, 'settled');
  });
}

test('deep options validate selected inputs before billing, exclude disabled assets, and lock after dispatch', async t => {
  const app = await fixture(t, { restoreAudio: async (_source, _generated, output) => writeFile(output, VIDEO) });
  const id = randomUUID();
  assert.equal((await app.call('/tasks', { body: { requestId: randomUUID(), mode: 'invalid' } })).status, 400);
  assert.equal((await app.call('/tasks', { body: { requestId: randomUUID(), mode: 'deep', replacements: { product: 'true' } } })).status, 400);
  await app.call('/tasks', { body: { requestId: id, mode: 'deep', replacements: { product: true, background: true } } });
  const upload = kind => fetch(app.base + `/api/video-replica/tasks/${id}/${kind}`, { method: 'PUT', body: VIDEO });
  assert.equal((await upload('video')).status, 200);
  assert.equal((await upload('photo')).status, 400);
  assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 400);
  assert.equal((await app.wallet.snapshot('alice')).held, 0); assert.equal(app.state.generations, 0);
  for (const kind of ['product', 'background']) assert.equal((await upload(kind)).status, 200);
  assert.equal((await app.call(`/tasks/${id}/product`, { owner: 'bob' })).status, 404);
  assert.equal((await app.call(`/tasks/${id}/product`)).headers.get('content-type'), 'image/jpeg');
  assert.equal((await app.call(`/tasks/${id}/options`, { body: { replacements: { product: true } } })).status, 200);
  assert.equal((await app.current(id)).background, undefined);
  assert.equal((await app.call(`/tasks/${id}/background`)).status, 404);
  assert.equal((await app.call(`/tasks/${id}/source-audio`, { body: { voiceEngine: 'chatterbox' } })).status, 409);
  await app.call(`/tasks/${id}/start`, { body: {} }); await app.until(id, task => task.status === 'running');
  assert.deepEqual(app.state.body.payload.resources, ['asset://product-id']);
  assert.equal((await app.call(`/tasks/${id}/options`, { body: { replacements: {} } })).status, 409);
  assert.equal((await upload('product')).status, 409);
  const signed = app.state.creates.find(item => item.kind === 'product').url;
  const url = new URL(signed);
  assert.equal((await fetch(app.base + url.pathname + url.search)).status, 200);
  assert.equal((await fetch(app.base + url.pathname + url.search.replace(/signature=./, 'signature=x'))).status, 403);
  const classic = await app.init();
  assert.equal((await app.call(`/tasks/${classic}/options`, { body: { replacements: {} } })).status, 409);
  assert.equal((await fetch(app.base + `/api/video-replica/tasks/${classic}/product`, { method: 'PUT', body: VIDEO })).status, 400);
});

for (const model of DEEP_MODELS) test(`deep ${model} keeps product references and original audio across 60-second segments`, async t => {
  const calls = [];
  const provider = {
    createMaterial: async (_url, kind) => ({ id: kind, status: 2 }),
    upload: async path => ({ id: path.split(/[\\/]/).at(-1).replace(/\.(jpg|mp4)$/, ''), status: 2 }),
    generate: async task => { calls.push(task); return { taskId: task.materials.video.id }; },
    query: async id => ({ url: `https://cdn.example/${id}.mp4` }),
  };
  let restores = 0, captionRenders = 0, captionExtracts = 0;
  const app = await fixture(t, { provider, wan3Provider: provider, config: { ...CONFIG, wan3Enabled: true },
    captions: { extract: async () => { captionExtracts++; return structuredClone(CAPTIONS); },
      render: async () => { captionRenders++; throw new Error('No local caption processing'); } },
    probe: async path => ({ ...META, duration: /segment-\d-result\.tmp$/.test(path) ? model === PREMIUM_MODEL ? 30 : 15 : 60 }),
    scenes: async () => ({ cuts: [] }),
    cutSegment: async (_input, output) => writeFile(output, VIDEO),
    joinSegments: async (_inputs, _segments, output) => { await writeFile(output, VIDEO); return { ...META, duration: 60 }; },
    restoreAudio: async (_source, _generated, output) => { restores++; await writeFile(output, VIDEO); } });
  const id = randomUUID();
  await app.call('/tasks', { body: { requestId: id, model, mode: 'deep', replacements: { product: true } } });
  for (const kind of ['video', 'product']) assert.equal((await fetch(app.base + `/api/video-replica/tasks/${id}/${kind}`, { method: 'PUT', body: VIDEO })).status, 200);
  assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 202);
  const completed = await app.until(id, task => task.status === 'completed');
  assert.equal(calls.length, model === PREMIUM_MODEL ? 2 : 4);
  for (const task of calls) {
    assert.equal(task.materials.product.id, 'product'); assert.equal(task.photo, undefined); assert.equal(task.voice, undefined);
    assert.match(generationBody(task).prompt, /最终成片不需要字幕，系统也不会补字幕/);
  }
  assert.equal(completed.actualDuration, 60); assert.equal(restores, 1); assert.equal(captionRenders, 0); assert.equal(captionExtracts, 0);
});

test('deep silent sources skip caption processing without adding an audio track', async t => {
  let captionCalls = 0;
  const app = await fixture(t, { probe: async () => ({ ...META, audio: false }),
    captions: { extract: async () => { captionCalls++; return structuredClone(CAPTIONS); },
      render: async () => { captionCalls++; throw new Error('No local caption processing'); } },
    restoreAudio: async (_source, _generated, output) => writeFile(output, VIDEO) });
  const id = randomUUID();
  await app.call('/tasks', { body: { requestId: id, mode: 'deep', replacements: {} } });
  assert.equal((await fetch(app.base + `/api/video-replica/tasks/${id}/video`, { method: 'PUT', body: VIDEO })).status, 200);
  await app.call(`/tasks/${id}/start`, { body: {} }); await app.until(id, task => task.status === 'running');
  app.state.done = true;
  const completed = await app.until(id, task => task.status === 'completed');
  assert.equal(completed.captionCheck, undefined); assert.equal(captionCalls, 0); assert.equal(app.state.generations, 1);
});

for (const stage of ['draft', 'running']) test(`deep ${stage} tasks with legacy captions never repaint or erase pixels after restart`, async t => {
  let captionCalls = 0;
  const app = await fixture(t, { captions: {
    extract: async () => { captionCalls++; throw new Error('OCR unavailable'); },
    render: async () => { captionCalls++; throw new Error('Renderer unavailable'); },
  }, restoreAudio: async (_source, _generated, output) => writeFile(output, VIDEO) });
  const id = randomUUID();
  await app.call('/tasks', { body: { requestId: id, mode: 'deep', replacements: {} } });
  assert.equal((await fetch(app.base + `/api/video-replica/tasks/${id}/video`, { method: 'PUT', body: VIDEO })).status, 200);
  if (stage === 'running') {
    await app.call(`/tasks/${id}/start`, { body: {} }); await app.until(id, task => task.status === 'running');
  }
  await app.close();
  const path = join(app.root, 'video', id, 'task.json');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  saved.captions = structuredClone(CAPTIONS); saved.captionsChecked = true;
  saved.captionCheck = { rendered: true, warning: '旧版字幕重绘提示' };
  await writeFile(path, JSON.stringify(saved));
  await app.open();
  if (stage === 'draft') {
    await app.call(`/tasks/${id}/start`, { body: {} }); await app.until(id, task => task.status === 'running');
  }
  assert.match(app.state.body.prompt, /最终成片不需要字幕，系统也不会补字幕/);
  app.state.done = true;
  const completed = await app.until(id, task => task.status === 'completed');
  assert.equal(completed.captions, undefined); assert.equal(completed.captionCheck, undefined);
  assert.equal(captionCalls, 0); assert.equal(app.state.generations, 1);
  assert.deepEqual(Buffer.from(await (await app.call(`/tasks/${id}/result`)).arrayBuffer()), VIDEO);
});


for (const model of [WAN3_MODEL, WAN3_FAST_MODEL]) test(`${model} starts on the aggregate and settles the selected price`, async t => {
  let officialCalls = 0;
  const app = await fixture(t, { config: { ...CONFIG, wan3Enabled: true, wan3AggregateEnabled: true },
    queryMaterial: async () => assert.fail('Wan must not query material registration'),
    wan3Provider: { generate: async () => { officialCalls++; throw new Error('wrong route'); } } });
  const id = await app.init(); await app.upload(id);
  const response = await app.call(`/tasks/${id}/start`, { body: { model } }); assert.equal(response.status, 202);
  await app.until(id, task => task.status === 'running');
  assert.equal(app.state.body.modelId, model); assert.equal(app.state.generations, 1); assert.equal(officialCalls, 0);
  assert.equal(app.state.creates.length, 0);
  for (const [kind, url] of [['photo', app.state.body.payload.resources[0]], ['video', app.state.body.payload.referVideoUrl[0]]]) {
    const source = new URL(url);
    assert.equal(source.origin, 'https://bucket.cos.ap-shanghai.myqcloud.com');
    assert.equal(source.pathname, `/workspace-video/wan3/${id}/${kind}.${kind === 'photo' ? 'jpg' : 'mp4'}`);
    assert.ok(source.searchParams.get('signature'));
    const upload = app.state.cosUploads.find(item => item.kind === kind);
    assert.equal(upload.type, kind === 'photo' ? 'image/jpeg' : 'video/mp4');
    assert.deepEqual(upload.bytes, kind === 'photo' ? Buffer.from('photo') : VIDEO);
  }
  assert.equal(app.state.cosUploads.length, 2);
  await app.close(); await app.open(); app.state.done = true;
  const done = await app.until(id, task => task.status === 'completed');
  assert.equal(app.state.generations, 1, 'restart only queries the saved aggregate receipt');
  assert.equal(app.state.cosUploads.length, 2, 'restart reuses uploaded objects');
  assert.equal(done.billing.chargedPoints, 4 * (model === WAN3_FAST_MODEL ? 738 : 492));
});

for (const model of [WAN3_MODEL, WAN3_FAST_MODEL]) for (const status of ['reviewing', 'queued'])
test(`${model} resumes old ${status} materials as COS URLs without registration`, async t => {
  const app = await fixture(t, { credits: null, config: { ...CONFIG, wan3Enabled: true, wan3AggregateEnabled: true },
    queryMaterial: async () => assert.fail('Old Wan materials must not be queried'),
    wan3Provider: { generate: async () => assert.fail('Must keep the aggregate route') } });
  const id = randomUUID(), kinds = ['photo', 'product', 'background', 'video'];
  await app.call('/tasks', { body: { requestId: id, model, mode: 'deep', replacements: { photo: true, product: true, background: true } } });
  for (const kind of kinds) assert.equal((await fetch(app.base + `/api/video-replica/tasks/${id}/${kind}`, { method: 'PUT', body: VIDEO })).status, 200);
  await app.close();
  const path = join(app.root, 'video', id, 'task.json'), saved = JSON.parse(await readFile(path, 'utf8'));
  Object.assign(saved, { status, startedAt: Date.now(), wan3Route: 'aggregate', wan3Failures: 2,
    materials: Object.fromEntries(kinds.map(kind => [kind, { id: `old-${kind}-id`, status: status === 'queued' ? 2 : 1 }])),
    ...(status === 'queued' ? { wan3Queue: { state: 'queued', order: 1, attempts: [] }, wan3QueuedAt: Date.now() } : {}) });
  await writeFile(path, JSON.stringify(saved)); await app.open();
  await app.until(id, task => task.status === 'running');
  assert.equal(app.state.creates.length, 0); assert.equal(app.state.generations, 1);
  assert.deepEqual([...app.state.body.payload.resources, ...app.state.body.payload.referVideoUrl].map(url => {
    const source = new URL(url); assert.equal(source.origin, 'https://bucket.cos.ap-shanghai.myqcloud.com'); assert.ok(source.searchParams.get('signature'));
    return source.pathname.split('/').at(-1).replace(/\.[^.]+$/, '');
  }), kinds);
  assert.deepEqual(app.state.cosUploads.map(item => item.kind), kinds);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).wan3Failures, 2);
  await app.close(); await app.open(); await app.until(id, task => task.status === 'running');
  assert.equal(app.state.generations, 1, 'a saved receipt must never be resubmitted');
  assert.equal(app.state.cosUploads.length, kinds.length);
});

for (const failure of ['rejected', 'failed-job']) test(`Wan ${failure} retries three times then uses official Prime, persisting the budget`, async t => {
  let at = Date.now(), attempts = 0, officialCalls = 0; const officialUploads = [];
  const app = await fixture(t, { config: { ...CONFIG, wan3Enabled: true, wan3AggregateEnabled: true }, now: () => at,
    generate: async () => { attempts++; if (failure === 'rejected') throw new VideoError('No capacity', 502, 'VIDEO_PROVIDER_REJECTED'); return { taskId: `failed-${attempts}` }; },
    query: async () => ({ failed: true, error: 'Upstream failed' }),
    wan3Provider: {
      upload: async (path, mime, model) => { officialUploads.push({ path, model }); return { id: 'oss://official/' + path.split(/[\\/]/).at(-1), status: 2 }; },
      generate: async task => { officialCalls++; assert.equal(task.model, WAN3_FAST_MODEL); assert.match(task.materials.photo.id, /^oss:/); assert.match(task.materials.video.id, /^oss:/); return { taskId: 'official-prime' }; },
      query: async id => { assert.equal(id, 'official-prime'); return { completed: true, url: 'https://cdn.example/official.mp4' }; },
    } });
  const id = await app.init(); await app.upload(id);
  await app.call(`/tasks/${id}/start`, { body: { model: WAN3_FAST_MODEL } });
  for (let count = 1; count <= 4; count++) {
    await app.until(id, task => attempts === count && task.recovery?.state === 'retrying');
    assert.equal(officialCalls, 0);
    if (count === 2) { await app.close(); await app.open(); }
    at += 6000;
  }
  const done = await app.until(id, task => task.status === 'completed');
  assert.equal(attempts, 4); assert.equal(officialCalls, 1); assert.equal(done.billing.chargedPoints, 4 * 738);
  assert.deepEqual(app.state.cosUploads.map(item => item.kind), ['photo', 'video'], 'retries reuse the same private objects');
  assert.ok(app.state.cosSigns.filter(item => item.kind === 'photo').length >= 4, 'each attempt refreshes the URL');
  assert.ok(officialUploads.every(upload => upload.model === WAN3_FAST_MODEL));
  const saved = JSON.parse(await readFile(join(app.root, 'video', id, 'task.json'), 'utf8'));
  assert.equal(saved.wan3Route, 'official'); assert.equal(saved.wan3Failures, 4); assert.equal(saved.wan3History.length, 4);
});

test('Wan COS uploads the compressed reference while retaining the original owner video', async t => {
  const compressed = Buffer.from('COMPRESSED WAN REFERENCE'); let preparations = 0;
  const app = await fixture(t, { config: { ...CONFIG, wan3Enabled: true, wan3AggregateEnabled: true },
    prepareReference: async (_input, output, model) => {
      preparations++; assert.equal(model, WAN3_MODEL); await writeFile(output, compressed);
      return { compressed: true, inputBytes: VIDEO.length, outputBytes: compressed.length };
    } });
  const id = await app.init(); await app.upload(id);
  await app.call(`/tasks/${id}/start`, { body: { model: WAN3_MODEL } });
  await app.until(id, task => task.status === 'running');
  const video = app.state.cosUploads.find(item => item.kind === 'video');
  assert.match(video.path, /video\.reference\.mp4$/); assert.deepEqual(video.bytes, compressed);
  assert.deepEqual(Buffer.from(await (await app.call(`/tasks/${id}/video`)).arrayBuffer()), VIDEO);
  await app.close(); await app.open(); await app.until(id, task => task.status === 'running');
  assert.equal(preparations, 1); assert.equal(app.state.cosUploads.length, 2); assert.equal(app.state.generations, 1);
});

test('Wan storage failure retries only the unfinished upload and does not consume generation retries', async t => {
  let at = Date.now(), failing = true, officialCalls = 0; const uploads = [];
  const app = await fixture(t, { now: () => at, config: { ...CONFIG, wan3Enabled: true, wan3AggregateEnabled: true },
    wan3Storage: {
      upload: async (_id, kind) => { uploads.push(kind); if (kind === 'video' && failing) throw new VideoError('COS unavailable', 503, 'VIDEO_SOURCE_STORAGE_FAILED'); },
      url: async (_id, kind) => `https://bucket.cos.ap-shanghai.myqcloud.com/${kind}?signature=test`,
    },
    wan3Provider: { generate: async () => { officialCalls++; } },
  });
  const id = randomUUID();
  await app.call('/tasks', { body: { requestId: id, model: WAN3_MODEL, mode: 'deep', replacements: { photo: true } } });
  await app.upload(id); await app.call(`/tasks/${id}/start`, { body: {} });
  await app.until(id, task => task.code === 'VIDEO_SOURCE_STORAGE_FAILED');
  assert.equal(app.state.generations, 0); assert.equal(officialCalls, 0);
  const saved = JSON.parse(await readFile(join(app.root, 'video', id, 'task.json'), 'utf8'));
  assert.equal(saved.wan3Failures, undefined); assert.deepEqual(saved.wan3CosMaterials, { photo: true });
  await app.close(); failing = false; at += 6000; await app.open();
  await app.until(id, task => task.status === 'running');
  assert.deepEqual(uploads, ['photo', 'video', 'video']);
  assert.equal(app.state.generations, 1); assert.equal(officialCalls, 0);
});

test('Wan without COS configuration pauses before any generation and remains paused after restart', async t => {
  const app = await fixture(t, { config: { ...CONFIG, wan3Enabled: true, wan3AggregateEnabled: true },
    wan3Storage: createWan3Storage({ env: {} }), wan3Provider: { generate: async () => assert.fail('No fallback for storage configuration') } });
  const id = randomUUID();
  await app.call('/tasks', { body: { requestId: id, model: WAN3_MODEL, mode: 'deep', replacements: { photo: true } } });
  await app.upload(id); await app.call(`/tasks/${id}/start`, { body: {} });
  const task = await app.until(id, task => task.status === 'waiting');
  assert.equal(task.code, 'VIDEO_SOURCE_STORAGE_NOT_CONFIGURED');
  await app.close();
  const saved = JSON.parse(await readFile(join(app.root, 'video', id, 'task.json'), 'utf8'));
  assert.equal(saved.recovery.action, 'account');
  await app.open(); await delay(80);
  assert.equal((await app.current(id)).status, 'waiting'); assert.equal(app.state.generations, 0);
});

test('Wan refreshes queued COS signatures after a long wait and removes temporary objects on expiry', async t => {
  let at = Date.now();
  const app = await fixture(t, { now: () => at, config: { ...CONFIG, wan3Enabled: true, wan3AggregateEnabled: true } });
  const id = await app.init(); await app.upload(id);
  await app.call(`/tasks/${id}/start`, { body: { model: WAN3_MODEL } });
  await app.until(id, task => task.status === 'running');
  const firstUrl = app.state.body.payload.resources[0];
  await app.close();
  const path = join(app.root, 'video', id, 'task.json'), saved = JSON.parse(await readFile(path, 'utf8'));
  delete saved.providerId;
  saved.providerDispatched = false; saved.status = 'queued';
  saved.wan3Queue = { state: 'queued', order: 1, attempts: [] };
  await writeFile(path, JSON.stringify(saved));
  at += 4 * 86400_000; await app.open(); at += 1001;
  await app.until(id, task => task.status === 'running');
  assert.notEqual(app.state.body.payload.resources[0], firstUrl);
  assert.equal(app.state.cosUploads.length, 2);
  app.state.done = true; await app.until(id, task => task.status === 'completed');
  assert.equal(app.state.cosDeletes.length, 0);
  at += 3 * 86400_000 + 1;
  await app.until(id, task => task.status === 'expired' && app.state.cosDeletes.length === 2);
  await app.close();
  assert.deepEqual(app.state.cosDeletes, [{ id, kind: 'photo' }, { id, kind: 'video' }]);
  const expired = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(expired.cleaned, true); assert.deepEqual(expired.wan3CosMaterials, {});
});

test('Wan ambiguous submission holds without aggregate retry or official fallback across restart', async t => {
  let officialCalls = 0;
  const app = await fixture(t, { config: { ...CONFIG, wan3Enabled: true, wan3AggregateEnabled: true }, uncertain: true,
    wan3Provider: { generate: async () => { officialCalls++; } } });
  const id = await app.init(); await app.upload(id);
  await app.call(`/tasks/${id}/start`, { body: { model: WAN3_FAST_MODEL } });
  await app.until(id, task => task.code === 'VIDEO_SUBMISSION_UNCERTAIN');
  await app.close(); await app.open(); await delay(80);
  assert.equal(app.state.generations, 1); assert.equal(officialCalls, 0);
});


test('Wan segmented retry replaces only the failed part and keeps completed aggregate segments', async t => {
  let at = Date.now(), failures = 0, officialCalls = 0; const generated = [];
  const app = await fixture(t, { config: { ...CONFIG, wan3Enabled: true, wan3AggregateEnabled: true }, now: () => at,
    probe: async () => ({ ...META, duration: 20 }), scenes: async () => ({ cuts: [] }),
    cutSegment: async (_in, out) => writeFile(out, VIDEO),
    joinSegments: async (_inputs, _segments, out) => { await writeFile(out, VIDEO); return { ...META, duration: 20 }; },
    restoreAudio: async (_source, _generated, out) => writeFile(out, VIDEO),
    provider: {
      createMaterial: async () => assert.fail('Wan must not register segment materials'),
      queryMaterial: async () => assert.fail('Wan must not query segment materials'),
      generate: async task => {
        const body = generationBody(task);
        assert.equal(body.payload.resources[0], task.materials.photo.id);
        assert.equal(body.payload.referVideoUrl[0], task.materials.video.id);
        const segment = new URL(task.materials.video.id).pathname.split('/').at(-1).replace(/\.mp4$/, '');
        generated.push(segment); return { taskId: segment };
      },
      query: async id => {
        if (id === 'segment-1') { failures++; return { failed: true, error: 'No capacity' }; }
        return { completed: true, url: 'https://cdn.example/first.mp4' };
      },
    },
    wan3Provider: {
      upload: async path => ({ id: 'oss://' + path.split(/[\\/]/).at(-1), status: 2 }),
      generate: async task => { officialCalls++; assert.equal(task.model, WAN3_FAST_MODEL); assert.equal(task.materials.video.id, 'oss://segment-1.mp4'); return { taskId: 'official-second' }; },
      query: async id => { assert.equal(id, 'official-second'); return { completed: true, url: 'https://cdn.example/second.mp4' }; },
    } });
  const id = randomUUID();
  await app.call('/tasks', { body: { requestId: id, model: WAN3_FAST_MODEL, mode: 'deep', replacements: { photo: true } } });
  await app.upload(id); assert.equal((await app.call(`/tasks/${id}/start`, { body: {} })).status, 202);
  for (let count = 1; count <= 4; count++) {
    await app.until(id, task => failures === count && task.recovery?.state === 'retrying');
    if (count === 2) { await app.close(); await app.open(); }
    at += 6000;
  }
  const done = await app.until(id, task => task.status === 'completed');
  assert.equal(officialCalls, 1); assert.equal(generated.filter(id => id === 'segment-0').length, 1);
  assert.equal(generated.filter(id => id === 'segment-1').length, 4); assert.equal(done.billing.chargedPoints, 20 * 738);
  assert.deepEqual(app.state.cosUploads.map(item => item.kind), ['photo', 'segment-0', 'segment-1']);
});


for (const model of [PREMIUM_MODEL, WAN3_MODEL]) test(model + ' submits the compressed copy while keeping the owner source intact across restart and expiry', async t => {
  let at = Date.now(), preparations = 0, done = false; const urls = [], uploads = [];
  const compressed = Buffer.from('COMPRESSED REFERENCE');
  const provider = {
    createMaterial: async (url, kind) => { urls.push(url); return { id: kind, status: 2 }; },
    upload: async path => { uploads.push({ path, bytes: await readFile(path) }); return { id: 'oss://reference', status: 2 }; },
    generate: async () => ({ taskId: 'reference-job' }),
    query: async () => done ? { url: 'https://cdn.example/result.mp4' } : {},
  };
  const app = await fixture(t, { now: () => at, provider, wan3Provider: provider, config: { ...CONFIG, wan3Enabled: true },
    prepareReference: async (input, output, selected) => {
      preparations++; assert.equal(selected, model); assert.deepEqual(await readFile(input), VIDEO);
      await writeFile(output, compressed); return { compressed: true, inputBytes: 210_000_000, outputBytes: compressed.length };
    }, restoreAudio: async (source, _generated, output) => {
      assert.deepEqual(await readFile(source), VIDEO); await writeFile(output, VIDEO);
    } });
  const id = randomUUID();
  await app.call('/tasks', { body: { requestId: id, model, mode: 'deep', replacements: {} } });
  assert.equal((await fetch(app.base + '/api/video-replica/tasks/' + id + '/video', { method: 'PUT', body: VIDEO })).status, 200);
  await app.call('/tasks/' + id + '/start', { body: {} }); await app.until(id, task => task.status === 'running');
  if (model === WAN3_MODEL) {
    assert.match(uploads[0].path, /video.reference.mp4$/); assert.deepEqual(uploads[0].bytes, compressed);
  } else {
    const url = new URL(urls[0]);
    assert.deepEqual(Buffer.from(await (await fetch(app.base + url.pathname + url.search)).arrayBuffer()), compressed);
  }
  assert.deepEqual(Buffer.from(await (await app.call('/tasks/' + id + '/video')).arrayBuffer()), VIDEO);
  await app.close(); await app.open(); done = true;
  await app.until(id, task => task.status === 'completed'); assert.equal(preparations, 1);
  at += 4 * 86400_000; await app.until(id, task => task.status === 'expired');
  for (let i = 0; i < 100 && (await readdir(join(app.root, 'video', id))).some(name => name.includes('.reference.mp4')); i++) await delay(10);
  assert.equal((await readdir(join(app.root, 'video', id))).some(name => name.includes('.reference.mp4')), false);
});

test('segmented references check each cut separately and submit only the over-limit cut as a compressed copy', async t => {
  const checked = [], compressed = Buffer.from('COMPRESSED SEGMENT');
  const app = await segmentedReplica(t, { prepareReference: async (input, output) => {
    const name = input.split(/[\\/]/).at(-1); checked.push(name);
    assert.deepEqual(await readFile(input), VIDEO);
    const oversized = name === 'segment-0.mp4';
    if (oversized) await writeFile(output, compressed);
    return { compressed: oversized, inputBytes: oversized ? 210_000_000 : VIDEO.length, outputBytes: oversized ? compressed.length : VIDEO.length };
  } });
  const id = await segmentedDraft(app);
  await app.call('/tasks/' + id + '/start', { body: {} }); await app.until(id, task => task.status === 'running');
  assert.deepEqual(checked, ['segment-0.mp4', 'segment-1.mp4']);
  for (const kind of ['segment-0', 'segment-1']) {
    const url = new URL(app.calls.creates.find(item => item.kind === kind).url);
    const bytes = Buffer.from(await (await fetch(app.base + url.pathname + url.search)).arrayBuffer());
    assert.deepEqual(bytes, kind === 'segment-0' ? compressed : VIDEO);
  }
  assert.deepEqual(Buffer.from(await (await app.call('/tasks/' + id + '/video')).arrayBuffer()), VIDEO);
  await app.close(); await app.open();
  assert.equal(checked.length, 2); assert.equal(app.calls.generations.length, 2);
});

test('failed reference compression stops before material upload or generation and stays stopped after restart', async t => {
  let preparations = 0;
  const app = await fixture(t, { config: { ...CONFIG, wan3Enabled: true, wan3AggregateEnabled: true },
    prepareReference: async () => { preparations++; throw new VideoError('超限参考视频压缩未完成，已停止提交视频生成。', 422, 'VIDEO_REFERENCE_COMPRESSION_FAILED'); } });
  const id = randomUUID();
  await app.call('/tasks', { body: { requestId: id, model: WAN3_MODEL, mode: 'deep', replacements: {} } });
  await fetch(app.base + '/api/video-replica/tasks/' + id + '/video', { method: 'PUT', body: VIDEO });
  await app.call('/tasks/' + id + '/start', { body: {} });
  const stopped = await app.until(id, task => task.status === 'waiting');
  assert.match(stopped.error, /压缩未完成/); assert.equal(stopped.code, 'VIDEO_REFERENCE_COMPRESSION_FAILED');
  assert.equal(app.state.creates.length, 0); assert.equal(app.state.generations, 0);
  await app.close(); await app.open(); await delay(80);
  assert.equal((await app.current(id)).status, 'waiting'); assert.equal(preparations, 1);
  assert.equal(app.state.creates.length, 0); assert.equal(app.state.generations, 0);
});
