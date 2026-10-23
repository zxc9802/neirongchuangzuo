import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWan3Provider, wan3GenerationBody, wan3Price, wan3Usage } from '../services/video/wan3.mjs';
import { generationBody, videoConfig, WAN3_MODEL, WAN3_FAST_MODEL, createVideoProvider } from '../services/video/provider.mjs';
import { loadWorkspaceSettings } from '../services/runtime-settings.mjs';

const task = { model: WAN3_MODEL, video: { duration: 14.582 }, sourceAudioMode: 'original',
  materials: { photo: { id: 'oss://test/photo.jpg' }, video: { id: 'oss://test/source.mp4' } } };
const usage = { duration: 29.15, input_video_duration: 14.57, output_video_duration: 14.58, SR: 720 };

test('official Wan reuses the replica prompt and preserves original timing with and without Chatterbox', () => {
  for (const input of [task, { ...task, voice: { duration: 5 }, voiceEngine: 'chatterbox' }]) {
    const body = wan3GenerationBody(input);
    assert.equal(body.model, WAN3_MODEL);
    assert.equal(body.input.prompt, generationBody(input).prompt);
    assert.deepEqual(body.input.media, [{ type: 'reference_image', url: task.materials.photo.id }, { type: 'reference_video', url: task.materials.video.id }]);
    assert.deepEqual(body.parameters, { resolution: '720P', ratio: 'adaptive', duration: -1, audio: !input.voice, prompt_extend: false, watermark: false });
  }
  assert.match(wan3GenerationBody({ ...task, voice: {}, voiceEngine: 'chatterbox' }).input.prompt, /逐帧保留.*不要改变视频速度/);
  assert.throws(() => wan3GenerationBody({ ...task, voice: {}, voiceEngine: 'seedance' }), { code: 'VIDEO_VOICE_ENGINE_INVALID' });
});

test('official uploads use OSS policy, submit once and read actual input plus output usage', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wan3-upload-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'person.jpg'); await writeFile(file, 'portrait');
  const requests = [];
  const provider = createWan3Provider({ dashscopeKey: 'private-test-key' }, async (value, options) => {
    const url = new URL(value); requests.push({ url, options });
    if (url.pathname.endsWith('/uploads')) return Response.json({ data: { upload_host: 'https://test.oss-cn-beijing.aliyuncs.com',
      upload_dir: 'temporary/task', oss_access_key_id: 'policy-access', policy: 'policy', signature: 'signature', x_oss_object_acl: 'private' } });
    if (url.hostname.startsWith('test.oss-')) {
      assert.equal(new Headers(options.headers).has('Authorization'), false);
      assert.equal(options.body.get('key'), 'temporary/task/person.jpg');
      assert.equal(await options.body.get('file').text(), 'portrait');
      return new Response('');
    }
    assert.equal(options.headers.Authorization, 'Bearer private-test-key');
    if (options.method === 'POST') {
      assert.equal(options.headers['X-DashScope-Async'], 'enable');
      assert.equal(options.headers['X-DashScope-OssResourceResolve'], 'enable');
      assert.deepEqual(JSON.parse(options.body), wan3GenerationBody(task));
      return Response.json({ output: { task_id: 'paid-wan-3', task_status: 'PENDING' } });
    }
    return Response.json({ output: { task_id: 'paid-wan-3', task_status: 'SUCCEEDED', video_url: 'https://result.example/video.mp4' }, usage });
  });
  assert.deepEqual(await provider.upload(file, 'image/jpeg'), { id: 'oss://temporary/task/person.jpg', status: 2 });
  assert.deepEqual(await provider.generate(task), { taskId: 'paid-wan-3' });
  const result = await provider.query('paid-wan-3');
  assert.equal(result.completed, true); assert.deepEqual(result.usage, usage);
  assert.equal(requests.filter(item => item.url.pathname.endsWith('/video-synthesis')).length, 1);
});

test('Wan configuration is independent of Seedance and uses the server-only workspace key', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wan3-config-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '.env.local'), 'DASHSCOPE_API_KEY=test-key\n');
  const config = videoConfig(loadWorkspaceSettings({ root, env: {} }));
  assert.equal(config.enabled, false); assert.equal(config.wan3Enabled, true);
  assert.equal(videoConfig(loadWorkspaceSettings({ root, env: { NODE_ENV: 'production' } })).wan3Enabled, false);
  let requests = 0;
  await assert.rejects(createWan3Provider({}, () => { requests++; }).generate(task), { code: 'VIDEO_NOT_CONFIGURED', providerNotDispatched: true });
  assert.equal(requests, 0);
});

test('Wan distinguishes rejection, uncertain dispatch, failed jobs and missing usage', async () => {
  for (const [status, code] of [[401, 'VIDEO_PROVIDER_REJECTED'], [429, 'VIDEO_PROVIDER_RATE_LIMITED'], [503, 'VIDEO_PROVIDER_UNAVAILABLE']]) {
    let calls = 0;
    const provider = createWan3Provider({ dashscopeKey: 'test' }, async () => { calls++; return new Response('error', { status }); });
    await assert.rejects(provider.generate(task), { code }); assert.equal(calls, 1);
  }
  const provider = output => createWan3Provider({ dashscopeKey: 'test' }, async () => Response.json({ output }));
  await assert.rejects(provider({ task_status: 'PENDING' }).generate(task), { code: 'VIDEO_SUBMISSION_UNCERTAIN' });
  assert.equal((await provider({ task_status: 'FAILED' }).query('id')).failed, true);
  const missing = await provider({ task_status: 'SUCCEEDED', video_url: 'https://result.example/video.mp4' }).query('id');
  assert.equal(missing.completed, true); assert.equal(missing.usage, undefined);
  for (const value of [undefined, { ...usage, duration: 14.58 }, { ...usage, duration: '29.15' }, { ...usage, SR: 1080 }]) assert.equal(wan3Usage(value), undefined);
});

test('Wan throttling is a confirmed non-dispatch and respects Retry-After', async () => {
  for (const [retry, expected] of [['7', 7000], ['invalid', 5000], [null, 5000]]) {
    const provider = createWan3Provider({ dashscopeKey: 'test' }, async () => new Response('',
      { status: 429, headers: retry ? { 'Retry-After': retry } : {} }));
    await assert.rejects(provider.generate(task), { code: 'VIDEO_PROVIDER_RATE_LIMITED', providerNotDispatched: true, retryAfterMs: expected });
  }
  const provider = createWan3Provider({ dashscopeKey: 'test' }, async () => { throw new Error('connection lost'); });
  await assert.rejects(provider.generate(task), cause => cause.code === 'VIDEO_PROVIDER_UNAVAILABLE' && !cause.providerNotDispatched);
});

test('Wan discount ends at Beijing midnight and input seconds are retained in usage', () => {
  assert.equal(wan3Price(Date.parse('2026-10-31T23:59:59+08:00')), .42);
  assert.equal(wan3Price(Date.parse('2026-11-01T00:00:00+08:00')), .6);
  assert.equal(wan3Usage(usage).duration, 29.15);
});


for (const model of [WAN3_MODEL, WAN3_FAST_MODEL]) test(`${model} aggregate and official adapters retain the requested model`, async () => {
  const config = videoConfig({ VIDEO_API_BASE_URL: 'https://aggregate.example', VIDEO_PROJECT_CODE: 'project',
    VIDEO_ACCESS_KEY: 'test-access', VIDEO_SECRET_KEY: 'test-secret', TEMP_ASSET_SIGNING_SECRET: 'sign' }, 'https://workspace.example');
  assert.equal(config.wan3Enabled, true); assert.equal(config.wan3AggregateEnabled, true);
  const requests = [];
  const provider = createVideoProvider(config, async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    return Response.json({ success: true, data: { success: true, result: { taskId: 'aggregate-job' } } });
  });
  const input = { ...task, model, materials: { photo: { id: 'image-id' }, video: { id: 'video-id' } } };
  assert.equal((await provider.generate(input)).taskId, 'aggregate-job');
  assert.equal(requests[0].url, 'https://aggregate.example/openApi/generate');
  assert.equal(requests[0].body.modelId, model);
  assert.equal(requests[0].body.payload.params.mode, 'fusion_video');
  assert.equal(wan3GenerationBody({ ...task, model }).model, model);
});

test('aggregate Wan distinguishes explicit rate limit and rejection from uncertain server failures', async () => {
  const config = { video: { base: 'https://aggregate.example' } };
  for (const [response, code, notDispatched] of [
    [new Response('{}', { status: 429 }), 'VIDEO_PROVIDER_RATE_LIMITED', true],
    [Response.json({ success: true, data: { success: false, message: 'No capacity' } }), 'VIDEO_PROVIDER_REJECTED', true],
    [new Response('{}', { status: 503 }), 'VIDEO_PROVIDER_UNAVAILABLE', undefined],
  ]) {
    const provider = createVideoProvider(config, async () => response);
    await assert.rejects(provider.generate(task), cause => cause.code === code && cause.providerNotDispatched === notDispatched);
  }
  assert.equal(wan3Price(Date.parse('2026-10-23T00:00:00+08:00'), WAN3_FAST_MODEL), .9);
});
