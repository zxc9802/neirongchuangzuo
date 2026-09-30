import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createPreviewServer } from '../preview.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function workspace(t) {
  let offline = false;
  const backend = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (offline) { res.writeHead(503); res.end('{}'); return; }
    if (req.headers.cookie !== 'digital_human_session=valid') { res.writeHead(401); res.end('{}'); return; }
    res.end(JSON.stringify({ success: true, data: { authMode: 'standalone', user: { id: 'account_owner', account: 'owner@example.com', nickname: '创作者', role: 'member' } } }));
  });
  const handler = async (req, res) => { res.end(JSON.stringify({ userId: req.authenticatedUserId })); return true; };
  handler.ready = Promise.resolve(); handler.shutdown = async () => {};
  const preview = createPreviewServer({ backendUrl: await listen(backend), authRequired: true, createAI: () => handler });
  const base = await listen(preview);
  t.after(async () => { await preview.shutdown(); backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); });
  return { base, offline: () => { offline = true; } };
}

test('anonymous visitors see login and cannot access AI APIs or impersonate a user through headers', async t => {
  const { base } = await workspace(t);
  const home = await fetch(base + '/', { redirect: 'manual' });
  assert.equal(home.status, 302);
  assert.equal(home.headers.get('location'), '/login');
  assert.equal((await fetch(base + '/login')).status, 200);
  assert.equal((await fetch(base + '/register')).status, 200);
  const response = await fetch(base + '/api/ai/images', { headers: { 'x-user-id': 'account_owner' } });
  assert.equal(response.status, 401);
  assert.equal((await fetch(base + '/api/workspace/session')).status, 401);
});

test('verified sessions supply the server-side identity and expose only the account display fields', async t => {
  const { base } = await workspace(t);
  const headers = { cookie: 'digital_human_session=valid', 'x-user-id': 'forged' };
  assert.equal((await fetch(base + '/', { headers })).status, 200);
  assert.deepEqual(await (await fetch(base + '/api/ai/status', { headers })).json(), { userId: 'account_owner' });
  const response = await fetch(base + '/api/workspace/session', { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).user.id, 'account_owner');
});

test('an unavailable account service fails closed without destroying the login page', async t => {
  const app = await workspace(t); app.offline();
  const headers = { cookie: 'digital_human_session=valid' };
  assert.equal((await fetch(app.base + '/api/ai/status', { headers })).status, 503);
  assert.equal((await fetch(app.base + '/', { headers })).status, 503);
  assert.equal((await fetch(app.base + '/login')).status, 200);
});
