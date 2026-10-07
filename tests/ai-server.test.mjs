import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, lstat, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPreviewServer } from '../preview.mjs';
import { createAIHandler, downloadImage, isPublicAddress } from '../services/ai/server.mjs';
import { request } from 'node:http';

const CONFIG = { apiKey: 'test-secret', chatModel: 'gpt-6-luna', imageModel: 'gpt-image-2.5-sunburst-c', baseUrl: 'https://mock.invalid/v1' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ6kAAAAASUVORK5CYII=', 'base64');
const IMAGE = { dataUrl: `data:image/png;base64,${PNG.toString('base64')}` };
const result = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const imageResult = () => result({ data: [{ b64_json: PNG.toString('base64') }] });
const input = overrides => ({ requestId: randomUUID(), prompt: '保留原产品，制作自然采光的门店宣传图片。', images: [IMAGE], ratio: '3:4', quality: 'auto', ...overrides });
const storageClosers = new Map();

async function storage(t) {
  const parent = resolve(tmpdir());
  const directory = await mkdtemp(join(parent, 'store-ai-contract-'));
  t.after(async () => {
    for (const close of storageClosers.get(directory) || []) await close();
    storageClosers.delete(directory);
    // Only remove the exact temporary directory created for this test.
    assert.equal(dirname(resolve(directory)), parent);
    assert.ok(resolve(directory).startsWith(join(parent, 'store-ai-contract-')));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function server(t, { storageDir, config = CONFIG, fetchImpl = async () => { throw new Error('Unexpected paid operation'); }, downloadImpl = async () => { throw new Error('Unexpected remote download'); }, now = Date.now, cleanupIntervalMs = 60_000, bodyTimeoutMs, retentionOptions } = {}) {
  storageDir ||= await storage(t);
  const preview = createPreviewServer({ aiOptions: { config, storageDir, fetchImpl, downloadImpl, now, cleanupIntervalMs, bodyTimeoutMs, retentionOptions } });
  await preview.ready;
  preview.listen(0, '127.0.0.1');
  await once(preview, 'listening');
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    preview.closeAllConnections();
    await new Promise(resolveClose => preview.close(resolveClose));
  };
  if (!storageClosers.has(storageDir)) storageClosers.set(storageDir, []);
  storageClosers.get(storageDir).push(close);
  t.after(close);
  const base = `http://127.0.0.1:${preview.address().port}`;
  const post = (path, body, headers = {}) => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(path === '/api/ai/chat' ? { requestId: randomUUID(), ...body } : body),
  });
  return { base, post, storageDir, close, preview };
}

async function finished(app, id) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const response = await fetch(`${app.base}/api/ai/images/${id}`);
    assert.equal(response.status, 200);
    const { task } = await response.json();
    if (['completed', 'failed'].includes(task.status)) {
      // Await persisted terminal state, not just the in-memory transition.
      const saved = JSON.parse(await readFile(join(app.storageDir, id, 'task.json'), 'utf8'));
      if (saved.status === task.status) return task;
    }
    await delay(15);
  }
  assert.fail('Mock generation did not reach a persisted terminal state');
}

test('AI routes expose capability status without secrets and preserve the main workspace', async t => {
  let calls = 0;
  const app = await server(t, { fetchImpl: async () => { calls++; return imageResult(); } });
  const status = await fetch(app.base + '/api/ai/status');
  assert.equal(status.status, 200);
  assert.equal(status.headers.get('cache-control'), 'no-store');
  const body = await status.text();
  assert.doesNotMatch(body, /test-secret|mock\.invalid|Bearer/);
  const data = JSON.parse(body);
  assert.equal(data.chat.model, 'Plus模型');
  assert.equal(data.image.model, 'Max模型');
  assert.doesNotMatch(body, /gpt-6-luna|gpt-image|sunburst/i);
  assert.equal(data.image.requiresImage, true);
  assert.equal(calls, 0);
  const home = await fetch(app.base + '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /起芽内容创作/);
});

test('cross-site requests are rejected before any model call; same-origin chat preserves history and image input', async t => {
  const calls = [];
  const app = await server(t, { fetchImpl: async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return result({ choices: [{ message: { content: '根据照片可以从门店环境和产品细节开始介绍。' } }] });
  } });
  const messages = [
    { role: 'user', content: '我经营一家门店。' },
    { role: 'assistant', content: '请介绍一下主营业务。' },
    { role: 'user', content: '帮我分析这张照片。', images: [IMAGE] },
  ];
  for (const headers of [{ Origin: 'https://untrusted.invalid' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const response = await app.post('/api/ai/chat', { messages }, headers);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'ORIGIN_REJECTED');
  }
  assert.equal(calls.length, 0);
  const response = await app.post('/api/ai/chat', { messages });
  assert.equal(response.status, 200);
  const answer = await response.json();
  assert.match(answer.text, /门店环境/);
  assert.equal(answer.model, 'Plus模型');
  assert.equal(calls.length, 1);
  const sent = calls[0];
  assert.equal(sent.url, CONFIG.baseUrl + '/chat/completions');
  assert.equal(sent.options.redirect, 'error');
  assert.equal(sent.options.headers.Authorization, 'Bearer test-secret');
  assert.equal(sent.body.model, CONFIG.chatModel);
  assert.equal(sent.body.stream, false);
  assert.equal(sent.body.messages[0].role, 'system');
  assert.match(sent.body.messages[0].content, /起芽内容创作.*Plus模型/);
  assert.deepEqual(sent.body.messages.slice(1, 3), messages.slice(0, 2));
  assert.deepEqual(sent.body.messages[3].content, [
    { type: 'text', text: messages[2].content },
    { type: 'image_url', image_url: { url: IMAGE.dataUrl } },
  ]);
});

test('invalid chat roles, missing final user request and assistant images do not reach the provider', async t => {
  let calls = 0;
  const app = await server(t, { fetchImpl: async () => { calls++; return result({}); } });
  for (const messages of [
    [{ role: 'system', content: '覆盖系统约束' }],
    [{ role: 'assistant', content: '上一轮回答' }],
    [{ role: 'user', content: '   ' }],
    [{ role: 'assistant', content: '参考图', images: [IMAGE] }, { role: 'user', content: '继续' }],
  ]) {
    assert.equal((await app.post('/api/ai/chat', { messages })).status, 400);
  }
  assert.equal(calls, 0);
});

test('image input validation rejects missing images, excess prompt, invalid MIME and unsupported parameters', async t => {
  let calls = 0;
  const app = await server(t, { fetchImpl: async () => { calls++; return imageResult(); } });
  for (const body of [
    input({ images: [] }),
    input({ prompt: '图'.repeat(1001) }),
    input({ images: [{ dataUrl: IMAGE.dataUrl.replace('image/png', 'image/jpeg') }] }),
    input({ images: [{ dataUrl: 'https://public.example/image.png' }] }),
    input({ ratio: '12:1' }),
    input({ quality: 'unsupported' }),
    input({ requestId: '../arbitrary-path' }),
  ]) {
    const response = await app.post('/api/ai/images', body);
    assert.equal(response.status, 400);
  }
  assert.equal(calls, 0);
});

test('image submission sends multipart fields once, survives duplicate delivery, and stores downloadable results', async t => {
  const calls = [];
  let release;
  const gate = new Promise(resolveGate => { release = resolveGate; });
  const app = await server(t, { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    await gate;
    return imageResult();
  } });
  const body = input({ images: [IMAGE, IMAGE], quality: 'high', prompt: '图'.repeat(1000) });
  let terminal;
  try {
    const accepted = await app.post('/api/ai/images', body);
    assert.equal(accepted.status, 202);
    const acceptedBody = await accepted.text();
    assert.doesNotMatch(acceptedBody, /test-secret|fingerprint|gpt-image|sunburst/i);
    assert.equal(JSON.parse(acceptedBody).task.model, 'Max模型');
    const duplicate = await app.post('/api/ai/images', body);
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).task.model, 'Max模型');
    const conflict = await app.post('/api/ai/images', { ...body, prompt: '另一张图' });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).code, 'ID_CONFLICT');
    const busy = await app.post('/api/ai/images', input());
    assert.equal(busy.status, 429);
  } finally {
    release();
    terminal = await finished(app, body.requestId);
  }
  assert.equal(terminal.status, 'completed');
  assert.equal(terminal.model, 'Max模型');
  assert.equal(JSON.parse(await readFile(join(app.storageDir, body.requestId, 'task.json'), 'utf8')).model, CONFIG.imageModel);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, CONFIG.baseUrl + '/images/edits');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-secret');
  assert.equal(calls[0].options.headers['Content-Type'], undefined, 'fetch must set the multipart boundary');
  const form = calls[0].options.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get('model'), CONFIG.imageModel);
  assert.equal(form.get('prompt'), body.prompt);
  assert.equal(form.get('n'), '1');
  assert.equal(form.get('size'), '960x1280');
  assert.equal(form.get('quality'), 'high');
  assert.equal(form.get('format'), 'png');
  assert.equal(form.get('response_format'), 'b64_json');
  assert.equal(form.getAll('image').length, 2);
  assert.deepEqual(Buffer.from(await form.getAll('image')[0].arrayBuffer()), PNG);
  const media = terminal.images[0].url;
  const response = await fetch(app.base + media + '?download=1');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.match(response.headers.get('content-disposition'), /^attachment;/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  const head = await fetch(app.base + media, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), PNG.length);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const tasks = await (await fetch(app.base + '/api/ai/images')).json();
  assert.equal(tasks.tasks.length, 1);
  assert.equal(tasks.tasks[0].id, body.requestId);
  assert.equal(tasks.tasks[0].model, 'Max模型');
  assert.equal(Object.hasOwn(tasks.tasks[0], 'fingerprint'), false);

  await app.close();
  const restarted = await server(t, { storageDir: app.storageDir, fetchImpl: async () => { assert.fail('Completed task was resubmitted'); } });
  const restored = await (await fetch(`${restarted.base}/api/ai/images/${body.requestId}`)).json();
  assert.equal(restored.task.status, 'completed');
  assert.equal(restored.task.model, 'Max模型');
  assert.equal((await restarted.post('/api/ai/images', body)).status, 200);
  assert.deepEqual(Buffer.from(await (await fetch(restarted.base + media)).arrayBuffer()), PNG);
});

test('URL responses are downloaded through the injected image downloader and saved locally', async t => {
  const urls = [];
  const app = await server(t, {
    fetchImpl: async () => result({ data: [{ url: 'https://cdn.example.test/output.png' }] }),
    downloadImpl: async url => { urls.push(url); return PNG; },
  });
  const body = input();
  assert.equal((await app.post('/api/ai/images', body)).status, 202);
  const task = await finished(app, body.requestId);
  assert.equal(task.status, 'completed');
  assert.deepEqual(urls, ['https://cdn.example.test/output.png']);
  assert.match(task.images[0].url, /^\/api\/ai\/media\//);
  assert.doesNotMatch(JSON.stringify(task), /cdn\.example|test-secret/);
});

test('restarting marks queued or running jobs failed without resubmitting or exposing their fingerprint', async t => {
  const storageDir = await storage(t);
  const ids = [];
  for (const status of ['queued', 'running']) {
    const id = randomUUID();
    ids.push(id);
    await mkdir(join(storageDir, id));
    await writeFile(join(storageDir, id, 'task.json'), JSON.stringify({
      id, status, prompt: '重启前创建的任务', images: [], model: CONFIG.imageModel,
      createdAt: new Date().toISOString(), fingerprint: 'private-fingerprint',
    }));
  }
  let calls = 0;
  const app = await server(t, { storageDir, fetchImpl: async () => { calls++; return imageResult(); } });
  const list = await (await fetch(app.base + '/api/ai/images')).json();
  assert.equal(list.tasks.length, 2);
  for (const task of list.tasks) {
    assert.ok(ids.includes(task.id));
    assert.equal(task.status, 'failed');
    assert.equal(task.code, 'INTERRUPTED');
    assert.match(task.error, /可能已经执行/);
    assert.equal(Object.hasOwn(task, 'fingerprint'), false);
    assert.equal(task.model, 'Max模型');
    const persisted = JSON.parse(await readFile(join(storageDir, task.id, 'task.json'), 'utf8'));
    assert.equal(persisted.status, 'failed');
    assert.equal(persisted.model, CONFIG.imageModel);
  }
  assert.equal(calls, 0);
});

test('chat errors are actionable without echoing provider response bodies or credentials', async t => {
  for (const scenario of [
    { name: 'authentication', response: () => new Response('test-secret upstream-private', { status: 401 }), code: 'PROVIDER_AUTH' },
    { name: 'empty output', response: () => result({ choices: [{ message: { content: '' } }] }), code: 'EMPTY_RESULT' },
    { name: 'HTML proxy page', response: () => new Response('<html>test-secret upstream-private</html>'), code: 'UPSTREAM_RESPONSE' },
    { name: 'lost connection', response: () => { throw new Error('test-secret upstream-private'); }, code: 'UPSTREAM_UNCERTAIN' },
  ]) {
    await t.test(scenario.name, async child => {
      let calls = 0;
      const app = await server(child, { fetchImpl: async () => { calls++; return scenario.response(); } });
      const response = await app.post('/api/ai/chat', { messages: [{ role: 'user', content: '请介绍我的门店' }] });
      assert.equal(response.status, 502);
      const body = await response.text();
      assert.doesNotMatch(body, /test-secret|upstream-private|<html>/);
      assert.equal(JSON.parse(body).code, scenario.code);
      assert.equal(calls, 1, 'Paid calls must not retry automatically');
    });
  }
});

test('image failures stay failed and identical request IDs never retry paid work', async t => {
  for (const scenario of [
    { name: 'authentication', response: () => new Response('test-secret upstream-private', { status: 401 }), code: 'PROVIDER_AUTH' },
    { name: 'no images', response: () => result({ data: [] }), code: 'EMPTY_RESULT' },
    { name: 'HTML proxy page', response: () => new Response('<html>test-secret upstream-private</html>'), code: 'UPSTREAM_RESPONSE' },
  ]) {
    await t.test(scenario.name, async child => {
      let calls = 0;
      const app = await server(child, { fetchImpl: async () => { calls++; return scenario.response(); } });
      const body = input();
      assert.equal((await app.post('/api/ai/images', body)).status, 202);
      const task = await finished(app, body.requestId);
      assert.equal(task.status, 'failed');
      assert.equal(task.code, scenario.code);
      assert.doesNotMatch(JSON.stringify(task), /test-secret|upstream-private|<html>/);
      assert.deepEqual(task.images, []);
      const duplicate = await app.post('/api/ai/images', body);
      assert.equal(duplicate.status, 200);
      assert.equal((await duplicate.json()).task.status, 'failed');
      assert.equal(calls, 1);
    });
  }
});

test('remote image URL checks reject unsafe schemes, credentials, ports and local addresses without network calls', async () => {
  for (const address of ['127.0.0.1', '10.10.0.1', '172.16.2.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '198.18.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  for (const url of ['http://public.example/image.png', 'file:///private.png', 'data:image/png;base64,AA==', 'https://user:pass@public.example/image.png', 'https://public.example:8443/image.png', 'https://127.0.0.1/image.png']) {
    await assert.rejects(() => downloadImage(url));
  }
  await assert.rejects(() => downloadImage('https://public.example/image.png', 4));
});

const RETENTION_MS = 72 * 60 * 60 * 1000;

async function seedTask(storageDir, overrides = {}) {
  const id = overrides.id || randomUUID();
  const task = {
    id, status: 'completed', prompt: '测试作品', model: CONFIG.imageModel,
    createdAt: '2026-09-01T00:00:00.000Z', completedAt: '2026-09-01T01:00:00.000Z',
    images: [{ filename: 'result-1.png', url: `/api/ai/media/${id}/result-1.png` }],
    fingerprint: 'persisted-fingerprint', ...overrides,
  };
  await mkdir(join(storageDir, id));
  await writeFile(join(storageDir, id, 'task.json'), JSON.stringify(task));
  await writeFile(join(storageDir, id, 'result-1.png'), PNG);
  return task;
}

test('completed images expire exactly 72 hours after completion across list, detail and media; duplicate IDs stay spent after restart', async t => {
  let clock = Date.parse('2026-09-01T00:00:00.000Z');
  let calls = 0;
  let release;
  const gate = new Promise(resolveGate => { release = resolveGate; });
  const app = await server(t, { now: () => clock, fetchImpl: async () => { calls++; await gate; return imageResult(); } });
  const body = input();
  assert.equal((await app.post('/api/ai/images', body)).status, 202);
  clock += 60 * 60 * 1000;
  release();
  const task = await finished(app, body.requestId);
  const deadline = clock + RETENTION_MS;
  assert.equal(task.createdAt, '2026-09-01T00:00:00.000Z');
  assert.equal(task.completedAt, '2026-09-01T01:00:00.000Z');
  assert.equal(task.expiresAt, new Date(deadline).toISOString());
  const directory = join(app.storageDir, body.requestId);
  await writeFile(join(directory, 'source.png'), PNG);
  await writeFile(join(directory, 'result-not-a-generated-file.png'), PNG);
  clock = deadline - 1;
  const valid = await fetch(app.base + task.images[0].url);
  assert.equal(valid.status, 200);
  assert.equal(valid.headers.get('cache-control'), 'private, no-store');
  assert.equal((await (await fetch(app.base + '/api/ai/images')).json()).tasks.length, 1);
  clock = deadline;
  const [list, detail, media, head] = await Promise.all([
    fetch(app.base + '/api/ai/images'),
    fetch(`${app.base}/api/ai/images/${task.id}`),
    fetch(app.base + task.images[0].url + '?download=1'),
    fetch(app.base + task.images[0].url, { method: 'HEAD' }),
  ]);
  assert.deepEqual(await list.json(), { retentionHours: 72, tasks: [] });
  const expired = (await detail.json()).task;
  assert.equal(expired.status, 'expired');
  assert.equal(expired.code, 'RESULT_EXPIRED');
  assert.equal(expired.expiresAt, task.expiresAt);
  assert.deepEqual(expired.images, []);
  assert.equal(Object.hasOwn(expired, 'fingerprint'), false);
  assert.equal(media.status, 410);
  assert.equal((await media.json()).code, 'RESULT_EXPIRED');
  assert.equal(head.status, 410);
  await assert.rejects(readFile(join(directory, 'result-1.png')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(directory, 'source.png')), PNG);
  assert.deepEqual(await readFile(join(directory, 'result-not-a-generated-file.png')), PNG);
  const saved = JSON.parse(await readFile(join(directory, 'task.json'), 'utf8'));
  assert.equal(saved.status, 'expired');
  assert.ok(saved.fingerprint);
  assert.deepEqual(saved.images, []);
  assert.equal((await (await app.post('/api/ai/images', body)).json()).task.status, 'expired');
  assert.equal((await app.post('/api/ai/images', { ...body, prompt: '换个要求' })).status, 409);
  assert.equal(calls, 1);
  await app.close();
  const restarted = await server(t, { storageDir: app.storageDir, now: () => clock });
  assert.equal((await (await restarted.post('/api/ai/images', body)).json()).task.status, 'expired');
  assert.equal((await fetch(restarted.base + task.images[0].url)).status, 410);
  assert.deepEqual((await (await fetch(restarted.base + '/api/ai/images')).json()).tasks, []);
});

test('startup cleanup handles legacy timestamps, removes failed half-results and preserves recent results', async t => {
  const storageDir = await storage(t);
  const clock = Date.parse('2026-09-05T00:00:00.000Z');
  const legacy = await seedTask(storageDir, { completedAt: undefined });
  const malformedCompletion = await seedTask(storageDir, { completedAt: 'not-a-date' });
  const recent = await seedTask(storageDir, { completedAt: '2026-09-04T12:00:00.000Z' });
  const failed = await seedTask(storageDir, { status: 'failed' });
  const running = await seedTask(storageDir, { status: 'running' });
  const app = await server(t, { storageDir, now: () => clock });
  const list = (await (await fetch(app.base + '/api/ai/images')).json()).tasks;
  assert.deepEqual(new Set(list.map(item => item.id)), new Set([recent.id, failed.id, running.id]));
  for (const task of [legacy, malformedCompletion]) {
    await assert.rejects(readFile(join(storageDir, task.id, 'result-1.png')), { code: 'ENOENT' });
    const detail = (await (await fetch(`${app.base}/api/ai/images/${task.id}`)).json()).task;
    assert.equal(detail.status, 'expired');
    assert.equal(detail.expiresAt, '2026-09-04T00:00:00.000Z');
  }
  assert.deepEqual(await readFile(join(storageDir, recent.id, 'result-1.png')), PNG);
  for (const task of [failed, running]) await assert.rejects(readFile(join(storageDir, task.id, 'result-1.png')), { code: 'ENOENT' });
  assert.equal(list.find(item => item.id === running.id).code, 'INTERRUPTED');
  assert.equal(list.find(item => item.id === recent.id).expiresAt, '2026-09-07T12:00:00.000Z');
});

test('periodic cleanup expires files without incoming requests and server close disposes its timer', async t => {
  const storageDir = await storage(t);
  let clock = Date.parse('2026-09-01T02:00:00.000Z');
  const task = await seedTask(storageDir);
  const app = await server(t, { storageDir, now: () => clock, cleanupIntervalMs: 10 });
  await fetch(app.base + '/api/ai/status');
  clock = Date.parse(task.completedAt) + RETENTION_MS;
  const path = join(storageDir, task.id, 'result-1.png');
  const timeout = Date.now() + 3000;
  let exists = true;
  while (exists && Date.now() < timeout) {
    await delay(15);
    try { await lstat(path); } catch (error) { if (error.code !== 'ENOENT') throw error; exists = false; }
  }
  assert.equal(exists, false, 'The timer should delete the file without HTTP requests');
  await app.close();
  const second = await seedTask(storageDir, { completedAt: new Date(clock).toISOString() });
  const restarted = await server(t, { storageDir, now: () => clock, cleanupIntervalMs: 10 });
  await fetch(restarted.base + '/api/ai/status');
  await restarted.close();
  clock += RETENTION_MS;
  await delay(50);
  assert.deepEqual(await readFile(join(storageDir, second.id, 'result-1.png')), PNG, 'A closed server must not keep cleaning storage');
});

test('retention cleanup never follows a task directory junction outside the configured storage', async t => {
  const storageDir = await storage(t);
  const outside = await storage(t);
  const task = await seedTask(outside);
  const link = join(storageDir, task.id);
  try { await symlink(join(outside, task.id), link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Symlinks are not available in this environment'); return; } throw error; }
  const app = await server(t, { storageDir, now: () => Date.parse('2026-09-05T00:00:00.000Z') });
  assert.deepEqual((await (await fetch(app.base + '/api/ai/images')).json()).tasks, []);
  assert.deepEqual(await readFile(join(outside, task.id, 'result-1.png')), PNG);
  assert.equal(JSON.parse(await readFile(join(outside, task.id, 'task.json'), 'utf8')).status, 'completed');
});

test('failed file cleanup cannot expose expired results and retries safely without recursive deletion', async t => {
  const storageDir = await storage(t);
  const task = await seedTask(storageDir);
  const path = join(storageDir, task.id, 'result-1.png');
  await unlink(path);
  await mkdir(path);
  await writeFile(join(path, 'leave-this-file.txt'), 'unrelated content');
  const app = await server(t, { storageDir, now: () => Date.parse('2026-09-05T00:00:00.000Z') });
  const list = await fetch(app.base + '/api/ai/images');
  assert.deepEqual((await list.json()).tasks, []);
  const detail = (await (await fetch(`${app.base}/api/ai/images/${task.id}`)).json()).task;
  assert.equal(detail.status, 'expired');
  assert.deepEqual(detail.images, []);
  const media = await fetch(app.base + task.images[0].url);
  assert.equal(media.status, 410);
  assert.equal(media.headers.get('cache-control'), 'no-store');
  assert.equal(await readFile(join(path, 'leave-this-file.txt'), 'utf8'), 'unrelated content');
  assert.equal(JSON.parse(await readFile(join(storageDir, task.id, 'task.json'), 'utf8')).fingerprint, task.fingerprint);
  // Once the obstruction is removed, a later sweep deletes only the result.
  await unlink(join(path, 'leave-this-file.txt'));
  await rmdir(path);
  await writeFile(path, PNG);
  await fetch(app.base + '/api/ai/images');
  await assert.rejects(readFile(path), { code: 'ENOENT' });
});

test('completed-only listing returns every retained image without the history limit or failed-task crowding', async t => {
  const storageDir = await storage(t);
  const clock = Date.parse('2026-09-05T00:00:00.000Z');
  const expected = [];
  for (let index = 0; index < 105; index++) {
    expected.push(await seedTask(storageDir, {
      createdAt: new Date(clock - 48 * 60 * 60 * 1000 + index * 1000).toISOString(),
      completedAt: new Date(clock - 24 * 60 * 60 * 1000 - index * 1000).toISOString(),
    }));
  }
  const legacy = await seedTask(storageDir, { createdAt: new Date(clock - 60_000).toISOString(), completedAt: undefined });
  expected.unshift(legacy);
  for (let index = 0; index < 101; index++) {
    await seedTask(storageDir, { status: 'failed', createdAt: new Date(clock - index).toISOString() });
  }
  const expired = await seedTask(storageDir);
  const app = await server(t, { storageDir, now: () => clock });
  const history = (await (await fetch(app.base + '/api/ai/images')).json()).tasks;
  assert.equal(history.length, 100);
  assert.ok(history.every(task => task.status === 'failed'));
  const response = await (await fetch(app.base + '/api/ai/images?completed=true')).json();
  assert.equal(response.retentionHours, 72);
  assert.equal(response.tasks.length, 106);
  assert.deepEqual(response.tasks.map(task => task.id), expected.map(task => task.id));
  assert.ok(response.tasks.every(task => task.status === 'completed' && task.id !== expired.id));
  assert.ok(response.tasks.every(task => !Object.hasOwn(task, 'fingerprint')));
});

test('global quotas survive restart, count dispatched failures, and expose only safe usage metadata', async t => {
  let calls = 0;
  const config = { ...CONFIG, limits: { imageDaily: 1, chatDaily: 1, perMinute: 10 } };
  const app = await server(t, { config, fetchImpl: async url => {
    calls++;
    if (url.endsWith('/chat/completions')) throw new Error('private connection failed');
    return result({ data: [{ b64_json: PNG.toString('base64') }], usage: { input_tokens: 12, output_tokens: 34, secret: 'private' } });
  } });
  const chat = { requestId: randomUUID(), messages: [{ role: 'user', content: '私密门店需求' }] };
  assert.equal((await app.post('/api/ai/chat', chat)).status, 502);
  assert.equal((await app.post('/api/ai/chat', chat)).status, 502);
  const rejected = await app.post('/api/ai/chat', { ...chat, requestId: randomUUID() });
  assert.equal(rejected.status, 429);
  assert.equal((await rejected.json()).code, 'DAILY_QUOTA_EXCEEDED');
  const image = input();
  assert.equal((await app.post('/api/ai/images', image)).status, 202);
  await finished(app, image.requestId);
  const usage = await (await fetch(app.base + '/api/ai/usage')).json();
  assert.deepEqual(usage.used, { image: 1, chat: 1 });
  assert.deepEqual(usage.remaining, { image: 0, chat: 0 });
  assert.doesNotMatch(JSON.stringify(usage), /test-secret|private|私密|fingerprint|prompt|messages|base64|gpt-6-luna|gpt-image|sunburst/);
  assert.equal(usage.recent.find(item => item.kind === 'chat').status, 'uncertain');
  assert.equal(usage.recent.find(item => item.kind === 'chat').model, 'Plus模型');
  assert.equal(usage.recent.find(item => item.kind === 'image').model, 'Max模型');
  const status = await (await fetch(app.base + '/api/ai/status')).json();
  assert.deepEqual(status.usage.recent, usage.recent);
  const ledger = JSON.parse(await readFile(join(app.storageDir, '.runtime-control', 'requests.json'), 'utf8'));
  assert.equal(ledger.records.find(record => record.id === image.requestId).model, CONFIG.imageModel);
  assert.equal(ledger.records.find(record => record.id === chat.requestId).model, CONFIG.chatModel);
  await app.close();
  const restarted = await server(t, { storageDir: app.storageDir, config });
  assert.deepEqual((await (await fetch(restarted.base + '/api/ai/usage')).json()).remaining, { image: 0, chat: 0 });
  assert.equal((await restarted.post('/api/ai/images', input())).status, 429);
  assert.equal(calls, 2);
});

test('aborted chat reception can query the original persisted answer without another model call', async t => {
  let calls = 0; let release; let dispatched;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { dispatched = resolve; });
  const app = await server(t, { fetchImpl: async () => { calls++; dispatched(); await gate; return result({ choices: [{ message: { content: '原回答已完成' } }] }); } });
  const body = { requestId: randomUUID(), messages: [{ role: 'user', content: '工厂简介' }] };
  const controller = new AbortController();
  const pending = fetch(app.base + '/api/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
  const reception = pending.catch(() => null);
  await started;
  controller.abort(); await reception;
  try {
    assert.equal((await fetch(`${app.base}/api/ai/chat/${body.requestId}`)).status, 202);
  } finally { release(); }
  let response;
  for (let index = 0; index < 100; index++) {
    response = await fetch(`${app.base}/api/ai/chat/${body.requestId}`);
    if (response.status !== 202) break;
    await delay(10);
  }
  assert.equal(response.status, 200);
  assert.equal((await response.json()).text, '原回答已完成');
  assert.equal((await app.post('/api/ai/chat', { ...body, requestId: body.requestId.toUpperCase() })).status, 200);
  assert.equal((await app.post('/api/ai/chat', { ...body, messages: [{ role: 'user', content: '换内容' }] })).status, 409);
  const saved = await readFile(join(app.storageDir, body.requestId, 'task.json'), 'utf8');
  assert.doesNotMatch(saved, /工厂简介|messages|base64/);
  assert.equal(calls, 1);
  await app.close();
  const restarted = await server(t, { storageDir: app.storageDir });
  assert.equal((await (await fetch(`${restarted.base}/api/ai/chat/${body.requestId}`)).json()).text, '原回答已完成');
});

test('duplicate image UUIDs with changed casing reuse the same call', async t => {
  let calls = 0;
  const app = await server(t, { fetchImpl: async () => { calls++; return imageResult(); } });
  const body = input();
  assert.equal((await app.post('/api/ai/images', { ...body, requestId: body.requestId.toUpperCase() })).status, 202);
  await finished(app, body.requestId);
  assert.equal((await app.post('/api/ai/images', body)).status, 200);
  assert.equal((await fetch(`${app.base}/api/ai/images/${body.requestId.toUpperCase()}`)).status, 200);
  assert.equal(calls, 1);
});

test('a second instance is rejected until real in-flight generation finishes and shutdown releases its lock', async t => {
  let release; let started;
  const gate = new Promise(resolve => { release = resolve; });
  const sent = new Promise(resolve => { started = resolve; });
  const app = await server(t, { fetchImpl: async () => { started(); await gate; return imageResult(); } });
  const body = input();
  await app.post('/api/ai/images', body); await sent;
  let closed = false;
  const shutdown = app.preview.shutdown().then(() => { closed = true; });
  await delay(10);
  const second = createAIHandler({ storageDir: app.storageDir, config: CONFIG });
  await assert.rejects(second.ready, { code: 'AI_INSTANCE_LOCKED' });
  await second.shutdown();
  assert.equal(closed, false);
  assert.equal((await fetch(`${app.base}/api/ai/images/${body.requestId}`)).status, 200);
  assert.equal((await app.post('/api/ai/images', input())).status, 503);
  release(); await shutdown;
  const third = createAIHandler({ storageDir: app.storageDir, config: CONFIG });
  await third.ready; await third.shutdown();
});

test('failed multi-image outputs are immediately removed and remain inaccessible', async t => {
  const app = await server(t, { fetchImpl: async () => result({ data: [{ b64_json: PNG.toString('base64') }, { b64_json: Buffer.from('invalid image').toString('base64') }] }) });
  const body = input();
  await app.post('/api/ai/images', body);
  assert.equal((await finished(app, body.requestId)).status, 'failed');
  await fetch(app.base + '/api/ai/usage');
  await assert.rejects(readFile(join(app.storageDir, body.requestId, 'result-1.png')), { code: 'ENOENT' });
  assert.equal((await fetch(`${app.base}/api/ai/media/${body.requestId}/result-1.png`)).status, 404);
});

test('storage write failures stop paid calls and release known unsent reservations', async t => {
  let calls = 0; let writes = 0;
  const app = await server(t, { fetchImpl: async () => { calls++; return imageResult(); }, retentionOptions: { fsOverrides: { writeFile: async () => { writes++; throw Object.assign(new Error('private disk full'), { code: 'ENOSPC' }); } } } });
  assert.equal((await app.post('/api/ai/images', input())).status, 503);
  assert.equal((await app.post('/api/ai/images', input())).status, 503);
  const usage = await (await fetch(app.base + '/api/ai/usage')).json();
  assert.deepEqual(usage.used, { image: 0, chat: 0 });
  assert.equal(usage.healthy, false);
  assert.ok(writes > 0);
  assert.equal(calls, 0);
});

test('slow unfinished JSON uploads time out without a model call and do not block shutdown', async t => {
  const app = await server(t, { bodyTimeoutMs: 25 });
  const response = await new Promise((resolve, reject) => {
    const upload = request(app.base + '/api/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '1000' } }, reply => {
      const chunks = [];
      reply.on('data', chunk => chunks.push(chunk));
      reply.on('end', () => resolve({ status: reply.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    upload.on('error', reject);
    upload.write('{');
  });
  assert.equal(response.status, 408);
  assert.equal(response.body.code, 'BODY_TIMEOUT');
  await app.preview.shutdown();
});

test('provider response interruption is recorded as uncertain and never automatically retried', async t => {
  let calls = 0;
  const app = await server(t, { fetchImpl: async () => {
    calls++;
    return new Response(new ReadableStream({ start(controller) { controller.error(new Error('private interrupted body')); } }));
  } });
  const body = { requestId: randomUUID(), messages: [{ role: 'user', content: '门店介绍' }] };
  const response = await app.post('/api/ai/chat', body);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'UPSTREAM_UNCERTAIN');
  const usage = await (await fetch(app.base + '/api/ai/usage')).json();
  assert.equal(usage.recent[0].status, 'uncertain');
  assert.equal((await app.post('/api/ai/chat', body)).status, 502);
  assert.equal(calls, 1);
});

test('chat requires a durable request ID before any paid call', async t => {
  const app = await server(t);
  const response = await fetch(app.base + '/api/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: '宣传门店' }] }) });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'INVALID_REQUEST_ID');
});

test('a failure saving running state releases the reservation without dispatching', async t => {
  let writes = 0; let calls = 0;
  const app = await server(t, { fetchImpl: async () => { calls++; return imageResult(); }, retentionOptions: { fsOverrides: { writeFile: async (...args) => {
    writes++;
    if (writes > 1) throw Object.assign(new Error('private disk failure'), { code: 'ENOSPC' });
    return writeFile(...args);
  } } } });
  const body = input();
  assert.equal((await app.post('/api/ai/images', body)).status, 202);
  await app.preview.shutdown();
  assert.equal(calls, 0);
  const records = JSON.parse(await readFile(join(app.storageDir, '.runtime-control', 'requests.json'), 'utf8')).records;
  assert.equal(records[0].status, 'failed');
  assert.equal(records[0].dispatchedAt, undefined);
});

test('startup performs cleanup before the first HTTP request', async t => {
  const storageDir = await storage(t);
  const task = await seedTask(storageDir);
  const handler = createAIHandler({ storageDir, config: CONFIG, now: () => Date.parse('2026-09-05T00:00:00.000Z') });
  await handler.ready;
  try { await assert.rejects(readFile(join(storageDir, task.id, 'result-1.png')), { code: 'ENOENT' }); }
  finally { await handler.shutdown(); }
});
