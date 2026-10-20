import test from 'node:test';
import assert from 'node:assert/strict';
import { createPixverseProvider, pixverseGenerationBody } from '../services/video/pixverse.mjs';
import { videoConfig } from '../services/video/provider.mjs';

const receipt = { request_id: 'swap-1',
  status_url: 'https://queue.fal.run/fal-ai/pixverse/requests/swap-1/status',
  response_url: 'https://queue.fal.run/fal-ai/pixverse/requests/swap-1' };
const task = { materials: { photo: { id: 'https://fal.media/photo.jpg' }, video: { id: 'https://fal.media/source.mp4' } } };

test('PixVerse submits a person swap with uploaded media and resumes the returned queue', async () => {
  const calls = [];
  const provider = createPixverseProvider({ falKey: 'test-key' }, async (url, options) => {
    calls.push({ url, ...options });
    return Response.json(options.method === 'POST' ? receipt : url.endsWith('/status')
      ? { status: 'COMPLETED' } : { video: { url: 'https://fal.media/swapped.mp4' } });
  });
  const submitted = await provider.generate(task);
  assert.equal(submitted.taskId, 'swap-1');
  assert.deepEqual(JSON.parse(calls[0].body), {
    video_url: 'https://fal.media/source.mp4', image_url: 'https://fal.media/photo.jpg',
    mode: 'person', keyframe_id: 1, resolution: '720p', original_sound_switch: true, enable_safety_checker: true,
  });
  assert.equal(calls[0].url, 'https://queue.fal.run/fal-ai/pixverse/swap');
  assert.equal(calls[0].headers.Authorization, 'Key test-key');
  assert.equal(calls[0].redirect, 'error');
  assert.equal((await provider.query(submitted.taskId, submitted)).url, 'https://fal.media/swapped.mp4');
  assert.deepEqual(calls.slice(1).map(call => call.url), [receipt.status_url, receipt.response_url]);
  assert.deepEqual(pixverseGenerationBody({ ...task, voice: {}, voiceEngine: 'indextts2' }), pixverseGenerationBody(task));
});

test('PixVerse never sends its key to foreign queue URLs or accepts an incomplete submission', async () => {
  let calls = 0;
  const provider = createPixverseProvider({ falKey: 'secret' }, async () => { calls++; return Response.json({ request_id: 'unknown' }); });
  for (const status of ['https://evil.example/fal-ai/pixverse/requests/id', 'https://queue.fal.run/other/model',
    'https://user@queue.fal.run/fal-ai/pixverse/requests/id']) {
    await assert.rejects(provider.query('id', { falQueue: { status } }), { code: 'VIDEO_PROVIDER_UNAVAILABLE' });
  }
  assert.equal(calls, 0);
  await assert.rejects(provider.generate(task), { code: 'VIDEO_SUBMISSION_UNCERTAIN' });
  assert.equal(calls, 1);
});

test('PixVerse reports terminal failures and keeps temporary errors retryable', async () => {
  for (const status of ['FAILED', 'CANCELLED']) {
    const provider = createPixverseProvider({ falKey: 'test' }, async () => Response.json({ status }));
    assert.equal((await provider.query('id', { falQueue: { status: receipt.status_url } })).failed, true);
  }
  for (const status of [422, 503]) {
    const provider = createPixverseProvider({ falKey: 'test' }, async () => new Response('', { status }));
    await assert.rejects(provider.generate(task), { code: status === 422 ? 'VIDEO_PROVIDER_REJECTED' : 'VIDEO_PROVIDER_UNAVAILABLE' });
  }
});

test('PixVerse shares the narration and storage key precedence without requiring Seedance credentials', () => {
  for (const name of ['FAL_KEY', 'FAL_API_KEY', 'VIDEO_FAL_KEY']) {
    const config = videoConfig({ [name]: 'test', TEMP_ASSET_SIGNING_SECRET: 'sign' }, 'https://workspace.example');
    assert.equal(config.falEnabled, true); assert.equal(config.enabled, false); assert.equal(config.falKey, 'test');
  }
  assert.equal(videoConfig({ FAL_KEY: 'first', FAL_API_KEY: 'second', VIDEO_FAL_KEY: 'third' }).falKey, 'first');
});
