import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { createVideoHandler } from '../services/video/server.mjs';
import { createVideoProvider, generationBody, parseGeneration, videoConfig, PROMPT } from '../services/video/provider.mjs';
import { normalizePhoto, downloadVideo } from '../services/video/media.mjs';
import { createCreditsLedger } from '../services/credits/store.mjs';

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
    async query() { state.queries++; return state.failed ? { failed: true } : state.done ? { url: 'https://cdn.example/result.mp4' } : {}; },
  };
  let app, handler, base;
  async function open(overrides = {}) {
    handler = createVideoHandler({ storageDir: join(root, 'video'), config: CONFIG, provider, credits: wallet,
      photo: async () => Buffer.from('photo'), probe: async () => META, download: async (_url, path) => writeFile(path, VIDEO),
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
