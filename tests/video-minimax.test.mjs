import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoProvider, generationBody } from '../services/video/provider.mjs';

const model = 'MiniMax-H3';
const materials = Object.fromEntries(['photo', 'video', 'voice'].map(kind => [kind, { id: `https://workspace.example/${kind}?signature=test` }]));

for (const duration of [4, 15]) for (const mode of ['classic', 'deep']) test(`MiniMax-H3 ${mode} sends 768P, ${duration}s and direct references`, () => {
  const task = { model, mode, duration, video: { duration: 3.9 }, materials,
    ...(mode === 'deep' ? { replacements: { photo: true } } : {}) };
  const body = generationBody(task);
  assert.equal(body.modelId, model); assert.equal(body.abilityType, 'VIDEO');
  assert.equal(body.payload.params.resolution, '768P');
  assert.equal(body.payload.params.duration, duration);
  assert.deepEqual(body.payload.resources, [materials.photo.id]);
  assert.deepEqual(body.payload.referVideoUrl, [materials.video.id]);
});

test('MiniMax-H3 rejects unsupported durations before submitting a paid request', async () => {
  let calls = 0;
  const provider = createVideoProvider({ video: {} }, async () => { calls++; });
  for (const duration of [-1, 5, 16, undefined]) await assert.rejects(provider.generate({ model, duration, materials }), { code: 'VIDEO_DURATION_INVALID' });
  assert.equal(calls, 0);
});

test('MiniMax-H3 uses the existing upstream authentication and VIDEO polling', async () => {
  const requests = [], credentials = { base: 'https://provider.example', project: 'test-project', access: 'test-access', secret: 'test-secret' };
  const provider = createVideoProvider({ video: credentials }, async (url, options) => {
    requests.push({ url: String(url), headers: options.headers, body: JSON.parse(options.body) });
    return Response.json(requests.length === 1 ? { success: true, data: { taskId: 'platform-id' } }
      : { success: true, status: 2, message: 'https://cdn.example/result.mp4' });
  });
  const task = { model, duration: 4, materials };
  const submitted = await provider.generate(task);
  assert.equal((await provider.query(submitted.taskId, task)).url, 'https://cdn.example/result.mp4');
  assert.equal(requests[0].url, 'https://provider.example/openApi/generate');
  assert.equal(requests[1].url, 'https://provider.example/openApi/queryResult');
  assert.deepEqual(requests[1].body, { taskId: 'platform-id', abilityType: 'VIDEO' });
  assert.deepEqual(requests[0].headers, { 'Content-Type': 'application/json', projectCode: 'test-project', 'X-Access-Key': 'test-access', 'X-Secret-Key': 'test-secret' });
});
