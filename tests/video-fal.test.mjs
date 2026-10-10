import test from 'node:test';
import assert from 'node:assert/strict';
import { createFalVideoProvider, falGenerationBody, FAL_MODEL } from '../services/video/fal.mjs';

const task = { duration: 15, ratio: '9:16', video: { duration: 12.3 }, voice: {},
  speech: { start: 0.16, segments: [{ start: 0.16, end: 9.28, text: '不要九块九。' }] },
  materials: { photo: { id: 'https://app.example/photo?signed=1' }, video: { id: 'https://app.example/video?signed=2' }, voice: { id: 'https://app.example/voice?signed=3' } } };

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
