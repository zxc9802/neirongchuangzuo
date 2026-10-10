import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import sharp from 'sharp';
import { createRequestLedger } from '../services/ai/request-ledger.mjs';
import { imageWithFallback, FAL_IMAGE_MODEL } from '../services/ai/image-fallback.mjs';
import { createFoodRenderer } from '../services/restaurant/food-renderer.mjs';
import { foodScene, foodPhotoPlan } from '../services/restaurant/scenes.mjs';
import { createPreviewServer } from '../preview.mjs';
import { createCreditsLedger } from '../services/credits/store.mjs';

const config = { apiKey: 'primary-test-secret', imageModel: 'test-image', chatModel: 'test-chat', baseUrl: 'https://primary.invalid/v1',
  falImageKey: 'fallback-test-secret', falImageModel: FAL_IMAGE_MODEL, limits: { imageDaily: 20, chatDaily: 100, perMinute: 100 } };
const png = await sharp({ create: { width: 600, height: 800, channels: 3, background: '#d4b080' } }).png().toBuffer();
const base = 'https://queue.fal.run/openai/gpt-image-2.5/requests/fal-test-id';
const failure = code => Object.assign(Error('safe provider error'), { code, status: 502 });
const noSleep = async () => {};

async function fixture(t, limits = config.limits) {
  const root = await mkdtemp(join(tmpdir(), 'qiya-fallback-'));
  const ledger = createRequestLedger({ storageDir: root, limits }); await ledger.ready;
  const cleanup = [];
  t.after(async () => { for (const operation of cleanup) await operation(); await ledger.close(); await rm(root, { recursive: true, force: true }); });
  return { root, ledger, cleanup };
}
function form() {
  const body = new FormData(); body.set('prompt', '真实菜品，店内暖光'); body.set('size', '1024x1536'); body.set('quality', 'high');
  body.append('image', new Blob([png], { type: 'image/png' }), 'food.png');
  body.append('image', new Blob([png], { type: 'image/png' }), 'store.png'); return body;
}
function queueMock(calls, overrides = {}) {
  return async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'POST') return Response.json({ request_id: 'fal-test-id', status_url: `${base}/status`, response_url: base, ...overrides });
    if (url.endsWith('/status')) return Response.json({ status: 'COMPLETED' });
    return Response.json({ images: [{ url: 'https://media.invalid/result.png' }] });
  };
}
async function generate(ledger, options) {
  const id = 'test-root';
  if (!(await ledger.reserve({ id, kind: 'image', model: config.imageModel, fingerprint: 'input' })).created) throw failure('ALREADY_SENT');
  return imageWithFallback({ config, ledger, id, form: form(), dispatch: operation => operation(), consume: async info => info,
    sleepImpl: noSleep, ...options });
}

test('initial call plus exactly three primary retries precede one fal submit with identical references', async t => {
  const { ledger, root } = await fixture(t), calls = [], order = [];
  const result = await generate(ledger, { primary: async () => { order.push('primary'); throw failure('UPSTREAM_UNCERTAIN'); },
    fetchImpl: async (url, options) => { if (options.method === 'POST') order.push('fal'); return queueMock(calls)(url, options); } });
  assert.deepEqual(order, ['primary', 'primary', 'primary', 'primary', 'fal']);
  assert.equal(result.provider, 'fal'); assert.equal(calls.filter(item => item.options.method === 'POST').length, 1);
  const input = JSON.parse(calls[0].options.body); assert.equal(input.prompt, form().get('prompt'));
  assert.equal(input.image_urls.length, 2); assert.equal(input.num_images, 1); assert.equal(input.enable_safety_checker, true);
  assert.deepEqual(input.image_size, { width: 1024, height: 1536 });
  assert.equal(calls[0].options.headers.Authorization, 'Key fallback-test-secret');
  const summary = await ledger.summary(); assert.equal(summary.used.image, 5); assert.equal(summary.used.chat, 0);
  assert.equal(summary.recent.filter(item => item.status === 'uncertain').length, 4);
  assert.equal((await ledger.get(result.attemptId)).providerRequestId, 'fal-test-id');
  assert.equal((await ledger.get(result.attemptId)).status, 'completed');
  const saved = await readFile(join(root, '.runtime-control', 'requests.json'), 'utf8');
  for (const secret of ['fallback-test-secret', 'primary-test-secret', png.toString('base64'), '真实菜品']) assert.equal(saved.includes(secret), false);
  await assert.rejects(generate(ledger, { primary: async () => assert.fail('replay') }), { code: 'ALREADY_SENT' });
});

test('a successful primary retry stops the chain without calling fal', async t => {
  const { ledger } = await fixture(t); let attempts = 0;
  const result = await generate(ledger, { primary: async () => { if (++attempts < 3) throw failure('PROVIDER_ERROR'); return { data: { data: [{ b64_json: png.toString('base64') }] } }; }, fetchImpl: async () => assert.fail('fal unused') });
  assert.equal(attempts, 3); assert.equal(result.provider, 'primary'); assert.equal((await ledger.summary()).used.image, 3);
});

test('global quota and storage failures stop retries before any fallback dispatch', async t => {
  const { ledger } = await fixture(t, { ...config.limits, imageDaily: 2 }); let attempts = 0;
  await assert.rejects(generate(ledger, { primary: async () => { attempts++; throw failure('PROVIDER_ERROR'); }, fetchImpl: async () => assert.fail('quota bypass') }), { code: 'DAILY_QUOTA_EXCEEDED' });
  assert.equal(attempts, 2); assert.equal((await ledger.summary()).used.image, 2);
  const other = await fixture(t); attempts = 0;
  await assert.rejects(generate(other.ledger, { primary: async () => { attempts++; throw failure('STORAGE_FAILED'); }, fetchImpl: async () => assert.fail('storage bypass') }), { code: 'STORAGE_FAILED' });
  assert.equal(attempts, 1);
});

test('fal status and result transport failures repeat reads, never generation, and persist the accepted ID first', async t => {
  const { ledger } = await fixture(t), calls = []; let statusFailures = 1, resultFailures = 1;
  await generate(ledger, { primary: async () => { throw failure('PROVIDER_ERROR'); }, fetchImpl: async (url, options) => {
    if (options.method === 'GET') {
      assert.ok((await ledger.summary()).recent.some(item => item.providerRequestId === 'fal-test-id' && item.status === 'dispatched'));
      if (url.endsWith('/status') && statusFailures-- > 0 || !url.endsWith('/status') && resultFailures-- > 0) throw Error('network');
    }
    return queueMock(calls)(url, options);
  } });
  assert.equal(calls.filter(item => item.options.method === 'POST').length, 1); assert.equal(statusFailures, -1); assert.equal(resultFailures, -1);
});

test('an uncertain fal submission never resubmits and is recorded as uncertain', async t => {
  const { ledger } = await fixture(t); let submitted = 0;
  await assert.rejects(generate(ledger, { primary: async () => { throw failure('PROVIDER_ERROR'); }, fetchImpl: async () => { submitted++; throw Error('disconnect'); } }), { code: 'UPSTREAM_UNCERTAIN' });
  assert.equal(submitted, 1); assert.equal((await ledger.summary()).recent.filter(item => item.model === FAL_IMAGE_MODEL)[0].status, 'uncertain');
});

test('fal cannot redirect authenticated polling to an external or unrelated request URL', async t => {
  const { ledger } = await fixture(t), calls = [];
  await assert.rejects(generate(ledger, { primary: async () => { throw failure('PROVIDER_ERROR'); }, fetchImpl: queueMock(calls, { status_url: 'https://attacker.invalid/secret' }) }), { code: 'FAL_INVALID_OUTPUT' });
  assert.equal(calls.length, 1);
});

test('restaurant fallback normalizes the real output and records its successful attempt', async t => {
  const { ledger } = await fixture(t), calls = []; let primaryCalls = 0;
  const scene = foodScene({ foodSubjects: [{ label: '肠粉' }] });
  const render = createFoodRenderer({ config, ledger, sleepImpl: noSleep, downloadImpl: async () => png,
    fetchImpl: async (url, options) => url.endsWith('/images/edits') ? (primaryCalls++, new Response('{}', { status: 503 })) : queueMock(calls)(url, options) });
  const result = await render({ taskId: 'restaurant-fallback', imageId: 'food-1', scene, plan: foodPhotoPlan(scene), photo: { bytes: png, mime: 'image/png' }, appearance: { description: '肠粉' } });
  assert.equal(primaryCalls, 4); assert.equal(result.provider, 'fal');
  const meta = await sharp(result.bytes).metadata(); assert.equal(meta.width, 1080); assert.equal(meta.height, 1440);
  assert.equal((await ledger.get(result.requestId)).status, 'completed');
});

for (const mode of ['single', 'series']) test(`website ${mode} fallback delivers downloads, charges only final images, and task replay is free`, async t => {
  const { root, cleanup } = await fixture(t), calls = []; let primaryCalls = 0;
  const wallet = createCreditsLedger({ databaseUrl: null, storageDir: join(root, 'credits') }); await wallet.ready;
  const server = createPreviewServer({ authRequired: false, credits: wallet, aiOptions: { config, storageDir: join(root, 'web'), rateLimitWait: noSleep,
    downloadImpl: async () => png, logger: { warn() {} }, fetchImpl: async (url, options) => url.endsWith('/images/edits') ? (primaryCalls++, new Response('{}', { status: 503 })) : queueMock(calls)(url, options) } });
  await server.ready; server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(async () => { server.closeAllConnections(); await server.shutdown(); await wallet.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`, count = mode === 'series' ? 2 : 1;
  const body = { requestId: randomUUID(), prompt: '菜品宣传', images: [{ dataUrl: `data:image/png;base64,${png.toString('base64')}` }], ratio: '3:4', quality: 'high', generationMode: mode, outputCount: count };
  const post = () => fetch(`${origin}/api/ai/images`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
  assert.equal((await post()).status, 202);
  let task;
  for (let i = 0; i < 100; i++) { task = (await (await fetch(`${origin}/api/ai/images/${body.requestId}`)).json()).task; if (['completed', 'failed'].includes(task.status)) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(task.status, 'completed', task.error); assert.equal(task.images.length, count); assert.equal(task.billing.chargedPoints, count * 50);
  const points = await (await fetch(`${origin}/api/workspace/credits`)).json(); assert.equal(points.balance, 1000 - count * 50); assert.equal(points.held, 0);
  for (const image of task.images) assert.deepEqual(Buffer.from(await (await fetch(origin + image.url)).arrayBuffer()), png);
  assert.equal(primaryCalls, count * 4); assert.equal(calls.filter(item => item.options.method === 'POST').length, count);
  await post(); assert.equal(primaryCalls, count * 4);
  const status = await fetch(`${origin}/api/ai/status`); assert.equal(status.status, 200);
  const capability = await status.text();
  assert.equal(capability.includes('fallback-test-secret'), false); assert.equal(capability.includes(FAL_IMAGE_MODEL), false);
});
