import test from 'node:test';
import assert from 'node:assert/strict';
import { createWanProvider, wanGenerationBody } from '../services/video/wan.mjs';
import { WAN_MODEL } from '../services/video/provider.mjs';

const task = { model: WAN_MODEL, voice: {}, voiceEngine: 'indextts2',
  materials: { photo: { id: 'https://fal.media/photo.jpg' }, video: { id: 'https://fal.media/source.mp4' } } };
const receipt = prefix => ({ request_id: 'wan-1', status_url: `https://queue.fal.run/${prefix}/requests/wan-1/status`,
  response_url: `https://queue.fal.run/${prefix}/requests/wan-1` });

for (const prefix of ['fal-ai/wan', WAN_MODEL]) test(`Wan uses its exact replace endpoint and follows the returned ${prefix} queue`, async () => {
  const calls = [], job = receipt(prefix);
  const provider = createWanProvider({ falKey: 'test-key' }, async (url, options) => {
    calls.push({ url, ...options });
    return Response.json(options.method === 'POST' ? job : url.endsWith('/status')
      ? { status: 'COMPLETED' } : { video: { url: 'https://fal.media/replaced.mp4' }, prompt: 'upstream prompt', seed: 7 });
  });
  const submitted = await provider.generate(task);
  assert.equal(calls[0].url, `https://queue.fal.run/${WAN_MODEL}`);
  assert.equal(calls[0].headers.Authorization, 'Key test-key'); assert.equal(calls[0].redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0].body), { video_url: 'https://fal.media/source.mp4',
    image_url: 'https://fal.media/photo.jpg', resolution: '720p', enable_safety_checker: true });
  assert.deepEqual(wanGenerationBody({ ...task, voice: undefined }), wanGenerationBody(task));
  assert.equal(submitted.taskId, 'wan-1');
  assert.equal((await provider.query(submitted.taskId, submitted)).url, 'https://fal.media/replaced.mp4');
  assert.deepEqual(calls.slice(1).map(call => call.url), [job.status_url, job.response_url]);
});

test('Wan rejects foreign queue URLs, missing credentials and incomplete submission receipts', async () => {
  let calls = 0;
  const provider = createWanProvider({ falKey: 'secret' }, async () => { calls++; return Response.json({ request_id: 'unknown' }); });
  for (const status of ['https://evil.example/fal-ai/wan/requests/id', 'https://queue.fal.run/fal-ai/pixverse/requests/id',
    'https://user@queue.fal.run/fal-ai/wan/requests/id', 'http://queue.fal.run/fal-ai/wan/requests/id']) {
    await assert.rejects(provider.query('id', { falQueue: { status } }), { code: 'VIDEO_PROVIDER_UNAVAILABLE' });
  }
  const unconfigured = createWanProvider({}, async () => { calls++; });
  await assert.rejects(unconfigured.generate(task), { code: 'VIDEO_NOT_CONFIGURED' });
  assert.equal(calls, 0);
  await assert.rejects(provider.generate(task), { code: 'VIDEO_SUBMISSION_UNCERTAIN' }); assert.equal(calls, 1);
});

test('Wan distinguishes pending, terminal failures and unavailable result downloads', async () => {
  const job = receipt('fal-ai/wan'), saved = { falQueue: { status: job.status_url, result: job.response_url } };
  for (const status of ['IN_QUEUE', 'IN_PROGRESS', 'FAILED', 'CANCELLED']) {
    let calls = 0;
    const provider = createWanProvider({ falKey: 'test' }, async () => { calls++; return Response.json({ status }); });
    const result = await provider.query('wan-1', saved);
    assert.equal(Boolean(result.failed), ['FAILED', 'CANCELLED'].includes(status));
    assert.equal(result.completed, undefined); assert.equal(calls, 1);
  }
  for (const status of [422, 503]) {
    const provider = createWanProvider({ falKey: 'test' }, async url => url.endsWith('/status')
      ? Response.json({ status: 'COMPLETED' }) : new Response('', { status }));
    if (status === 422) assert.equal((await provider.query('wan-1', saved)).failed, true);
    else await assert.rejects(provider.query('wan-1', saved), { code: 'VIDEO_PROVIDER_UNAVAILABLE' });
  }
  for (const payload of [{ error: 'upstream failed' }, { video: { url: 'file:///private.mp4' } }, {}]) {
    const provider = createWanProvider({ falKey: 'test' }, async url => Response.json(url.endsWith('/status') ? { status: 'COMPLETED' } : payload));
    assert.equal((await provider.query('wan-1', saved)).url, undefined);
  }
});

test('Wan preserves a billing rejection before dispatch and bounds its responses', async () => {
  const stopped = Object.assign(new Error('Budget unavailable'), { providerNotDispatched: true });
  await assert.rejects(createWanProvider({ falKey: 'test' }, async () => { throw stopped; }).generate(task), cause => cause === stopped);
  for (const status of [400, 401, 402, 403, 422, 503]) {
    await assert.rejects(createWanProvider({ falKey: 'test' }, async () => new Response('', { status })).generate(task),
      { code: status === 503 ? 'VIDEO_PROVIDER_UNAVAILABLE' : 'VIDEO_PROVIDER_REJECTED' });
  }
  await assert.rejects(createWanProvider({ falKey: 'test' }, async () => new Response('x'.repeat(1024 * 1024 + 1))).generate(task),
    { code: 'VIDEO_PROVIDER_UNAVAILABLE' });
});
