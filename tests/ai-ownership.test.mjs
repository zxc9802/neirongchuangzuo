import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAIHandler } from '../services/ai/server.mjs';

test('account ownership protects task lists, image bytes, chat results and request replay across restart', async t => {
  const storageDir = await mkdtemp(join(tmpdir(), 'workspace-owner-'));
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ6kAAAAASUVORK5CYII=';
  let calls = 0;
  const options = { storageDir, config: { apiKey: 'test-only', baseUrl: 'https://mock.invalid', chatModel: 'test', imageModel: 'test' },
    fetchImpl: async url => { calls++; return new Response(JSON.stringify(url.endsWith('/images/edits') ? { data: [{ b64_json: png }] } : { choices: [{ message: { content: 'Private answer' } }] })); } };
  let handler = createAIHandler(options);
  await handler.ready;
  const server = createServer((req, res) => {
    // This test supplies a trusted identity; the real preview obtains it from the account service.
    req.authenticatedUserId = req.headers['x-test-user'];
    void handler(req, res);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, user, body, method) => fetch(base + path, { method: method || (body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await handler.shutdown(); await rm(storageDir, { recursive: true, force: true }); });
  const input = { requestId: randomUUID(), prompt: 'Private image', ratio: '1:1', quality: 'auto', images: [{ dataUrl: `data:image/png;base64,${png}` }] };
  assert.equal((await request('/api/ai/images', 'alice', input)).status, 202);
  let task;
  for (let attempt = 0; attempt < 100; attempt++) {
    task = (await (await request(`/api/ai/images/${input.requestId}`, 'alice')).json()).task;
    if (task.status === 'completed') break;
    await delay(10);
  }
  assert.equal(task.status, 'completed');
  assert.equal((await (await request('/api/ai/images', 'bob')).json()).tasks.length, 0);
  assert.equal((await request(`/api/ai/images/${task.id}`, 'bob')).status, 404);
  assert.equal((await request(task.images[0].url, 'bob')).status, 404);
  assert.equal((await request(task.images[0].url, 'bob', null, 'HEAD')).status, 404);
  assert.equal((await request(task.images[0].url, 'alice')).status, 200);
  assert.equal((await request('/api/ai/images', 'bob', input)).status, 409);
  assert.equal((await (await request('/api/ai/images')).json()).tasks.length, 0);
  const chat = { requestId: randomUUID(), messages: [{ role: 'user', content: 'Private request' }] };
  assert.equal((await request('/api/ai/chat', 'alice', chat)).status, 200);
  assert.equal((await request(`/api/ai/chat/${chat.requestId}`, 'bob')).status, 404);
  assert.equal((await request('/api/ai/chat', 'bob', chat)).status, 409);
  assert.equal(calls, 2);
  await handler.shutdown();
  handler = createAIHandler(options); await handler.ready;
  assert.equal((await request(`/api/ai/images/${task.id}`, 'alice')).status, 200);
  assert.equal((await request(`/api/ai/images/${task.id}`, 'bob')).status, 404);
  assert.equal(JSON.parse(await readFile(join(storageDir, task.id, 'task.json'), 'utf8')).userId, 'alice');
  assert.equal('userId' in (await (await request(`/api/ai/images/${task.id}`, 'alice')).json()).task, false);
});
