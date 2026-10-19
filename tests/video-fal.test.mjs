import test from 'node:test';
import assert from 'node:assert/strict';
import { createFalVideoProvider, falGenerationBody, wanGenerationBody, FAL_MODEL } from '../services/video/fal.mjs';
import { videoConfig, WAN_MODEL } from '../services/video/provider.mjs';

const task = { duration: 15, ratio: '9:16', video: { duration: 12.3 }, voice: {},
  speech: { start: 0.16, segments: [{ start: 0.16, end: 9.28, text: '不要九块九。' }] },
  materials: { photo: { id: 'https://app.example/photo?signed=1' }, video: { id: 'https://app.example/video?signed=2' }, voice: { id: 'https://app.example/voice?signed=3' } } };

test('Wan uses replacement inputs and the shared fal key without Seedance configuration', () => {
  assert.deepEqual(wanGenerationBody(task), { video_url: task.materials.video.id, image_url: task.materials.photo.id,
    resolution: '720p', num_inference_steps: 20, use_turbo: false });
  const config = videoConfig({ FAL_KEY: 'common', FAL_API_KEY: 'alias', VIDEO_FAL_KEY: 'legacy', TEMP_ASSET_SIGNING_SECRET: 'sign' }, 'https://workspace.example');
  assert.equal(config.falKey, 'common'); assert.equal(config.falEnabled, true); assert.equal(config.enabled, false);
  assert.equal(videoConfig({ FAL_API_KEY: 'alias', VIDEO_FAL_KEY: 'legacy' }).falKey, 'alias');
});

test('Wan submits once, restores its queue and rejects unrelated queue hosts or models', async () => {
  const calls = [], queue = { status: 'https://queue.fal.run/fal-ai/wan/requests/wan-1/status', result: 'https://queue.fal.run/fal-ai/wan/requests/wan-1' };
  const responses = [{ request_id: 'wan-1', status_url: queue.status, response_url: queue.result }, { status: 'IN_PROGRESS' },
    { status: 'COMPLETED' }, { video: { url: 'https://fal.media/wan.mp4' } }];
  const fetchImpl = async (url, options) => { calls.push({ url, ...options }); return Response.json(responses.shift()); };
  const submitted = await createFalVideoProvider({ falKey: 'shared' }, fetchImpl, WAN_MODEL).generate(task);
  const restored = createFalVideoProvider({ falKey: 'shared' }, fetchImpl, WAN_MODEL);
  assert.deepEqual(submitted.falQueue, queue);
  assert.equal((await restored.query('wan-1', submitted)).completed, undefined);
  assert.equal((await restored.query('wan-1', submitted)).url, 'https://fal.media/wan.mp4');
  assert.equal(calls[0].url, `https://queue.fal.run/${WAN_MODEL}`);
  assert.deepEqual(JSON.parse(calls[0].body), wanGenerationBody(task));
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  for (const status of ['https://foreign.example/collect', 'https://queue.fal.run/minimax/h3-max/requests/other/status']) {
    await assert.rejects(restored.query('wan-1', { falQueue: { status } }), /队列/);
  }
  assert.equal(calls.length, 4);
});

test('H3 Max sends all three references with the original dialogue and no prompt rewriting', () => {
  const body = falGenerationBody(task);
  assert.deepEqual(body.reference_image_urls, [task.materials.photo.id]);
  assert.deepEqual(body.reference_video_urls, [task.materials.video.id]);
  assert.deepEqual(body.reference_audio_urls, [task.materials.voice.id]);
  assert.equal(body.duration, 15); assert.equal(body.aspect_ratio, '9:16'); assert.equal(body.resolution, '768P');
  assert.equal(body.prompt_expansion_mode, 'disabled');
  assert.match(body.prompt, /Video 1/); assert.match(body.prompt, /Image 1/); assert.match(body.prompt, /Audio 1/);
  assert.match(body.prompt, /0\.160–9\.280 秒：不要九块九。/);
  assert.equal('reference_audio_urls' in falGenerationBody({ ...task, voice: null }), false);
});

test('fal persists provider queue URLs and follows completion without resubmitting', async () => {
  const calls = [], queue = { status: 'https://queue.fal.run/minimax/h3-max/requests/fal-1/status', result: 'https://queue.fal.run/minimax/h3-max/requests/fal-1' };
  const responses = [{ request_id: 'fal-1', status_url: queue.status, response_url: queue.result }, { status: 'IN_QUEUE' },
    { status: 'COMPLETED' }, { video: { url: 'https://v3.fal.media/files/result.mp4' } }];
  const provider = createFalVideoProvider({ falKey: 'private-test-key' }, async (url, options) => {
    calls.push({ url: String(url), ...options }); return Response.json(responses.shift());
  });
  assert.deepEqual(await provider.createMaterial(task.materials.photo.id), { id: task.materials.photo.id, status: 2 });
  const submitted = await provider.generate(task);
  assert.equal(submitted.taskId, 'fal-1'); assert.deepEqual(submitted.falQueue, queue);
  assert.deepEqual(await provider.query('fal-1', { falQueue: queue }), { taskId: 'fal-1' });
  const completed = await provider.query('fal-1', { falQueue: queue });
  assert.equal(completed.url, 'https://v3.fal.media/files/result.mp4'); assert.equal(completed.completed, true);
  assert.equal(calls[0].url, `https://queue.fal.run/${FAL_MODEL}`);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  assert.ok(calls.every(call => call.headers.Authorization === 'Key private-test-key' && call.redirect === 'error'));
});

test('fal reports completed failures and never forwards credentials to foreign queue URLs', async () => {
  const queue = { status: 'https://queue.fal.run/minimax/h3-max/requests/fal-1/status', result: 'https://queue.fal.run/minimax/h3-max/requests/fal-1' };
  const provider = createFalVideoProvider({ falKey: 'private-test-key' }, async () => Response.json({ status: 'COMPLETED', error: 'model failed' }));
  assert.equal((await provider.query('fal-1', { falQueue: queue })).failed, true);
  let requests = 0;
  const unsafe = createFalVideoProvider({ falKey: 'private-test-key' }, async () => { requests++; return Response.json({}); });
  await assert.rejects(unsafe.query('fal-1', { falQueue: { ...queue, status: 'https://foreign.example/collect' } }), /队列/);
  assert.equal(requests, 0);
});

test('fal rejects billing or authorization errors without exposing secrets or retrying a paid call', async () => {
  let requests = 0;
  const provider = createFalVideoProvider({ falKey: 'private-test-key' }, async () => {
    requests++; return Response.json({ detail: 'private-test-key debug details' }, { status: 402 });
  });
  await assert.rejects(provider.generate(task), error => error.code === 'VIDEO_PROVIDER_REJECTED' && /余额/.test(error.message) && !error.message.includes('private-test-key'));
  assert.equal(requests, 1);
});
