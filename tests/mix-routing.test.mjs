import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createPreviewServer } from '../preview.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const idleAI = () => Object.assign(async () => false, { ready: Promise.resolve(), shutdown: async () => {} });
async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t) {
  const received = [];
  const engine = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.setHeader('Content-Type', req.url.endsWith('/video') ? 'video/mp4' : 'application/json');
    res.setHeader('Upload-Offset', '12');
    res.end(req.url.endsWith('/video') ? Buffer.from([0, 1, 2, 255]) : JSON.stringify({ ok: true }));
  });
  const backend = createServer((req, res) => {
    const user = { 'session=a': 'alice', 'session=b': 'bob' }[req.headers.cookie];
    if (!user) { res.writeHead(401); res.end('{}'); return; }
    res.end(JSON.stringify({ success: true, data: { authMode: 'standalone', user: { id: user } } }));
  });
  const preview = createPreviewServer({ backendUrl: await listen(backend), publicOrigin: 'https://studio.example', authRequired: true, createAI: idleAI,
    mixOptions: { serviceUrl: await listen(engine), token: 'a'.repeat(64) } });
  const base = await listen(preview);
  t.after(async () => {
    await preview.shutdown();
    for (const server of [engine, backend]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
  return { base, received };
}

test('mix and browser catalog routes require verified accounts before launching the engine', async t => {
  const { base, received } = await fixture(t);
  for (const path of ['/api/mix/health', '/api/mix/jobs', '/api/browser-materials/devices/' + 'a'.repeat(32) + '/requests']) {
    assert.equal((await fetch(base + path, { headers: { 'x-material-owner': hash('alice') } })).status, 401);
  }
  assert.equal(received.length, 0);
});

test('proxy derives account ownership, scopes idempotency and excludes browser credentials', async t => {
  const { base, received } = await fixture(t);
  for (const cookie of ['session=a', 'session=b']) {
    assert.equal((await fetch(base + '/api/mix/jobs', { method: 'POST', headers: {
      cookie, Origin: 'https://studio.example', 'Content-Type': 'application/json', 'Idempotency-Key': 'same-key',
      authorization: 'Bearer forged', 'x-material-owner': hash('forged'), 'x-helper-token': 'forged',
    }, body: '{"text":"实拍文案"}' })).status, 200);
  }
  assert.deepEqual(received.map(item => item.headers['x-material-owner']), [hash('alice'), hash('bob')]);
  assert.notEqual(received[0].headers['idempotency-key'], received[1].headers['idempotency-key']);
  assert.equal(received[0].headers.authorization, 'Bearer ' + 'a'.repeat(64));
  assert.equal(received[0].headers.cookie, undefined);
  assert.equal(received[0].headers.origin, undefined);
  assert.equal(received[0].headers['x-helper-token'], undefined);
  assert.equal(received[0].path, '/v1/mix/jobs');
});

test('cross-origin and absent-origin production mutations are rejected before any material reads', async t => {
  const { base, received } = await fixture(t);
  for (const origin of ['https://attacker.example', undefined]) {
    const headers = { cookie: 'session=a', 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) };
    const response = await fetch(base + '/api/browser-materials/connect', { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 403);
  }
  assert.equal(received.length, 0);
});

test('chunk uploads and authenticated video bytes stream without JSON conversion', async t => {
  const { base, received } = await fixture(t);
  const bytes = Buffer.alloc(4 * 1024 * 1024, 254);
  const response = await fetch(base + `/api/browser-materials/devices/${'a'.repeat(32)}/files/${'b'.repeat(32)}`, {
    method: 'PATCH', headers: { cookie: 'session=a', Origin: 'https://studio.example', 'Content-Type': 'application/octet-stream',
      'Upload-Offset': '0', 'Upload-Checksum': 'sha256 ' + hash(bytes) }, body: bytes,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('upload-offset'), '12');
  assert.deepEqual(received[0].body, bytes);
  const video = await fetch(base + `/api/mix/jobs/${'c'.repeat(32)}/video`, { headers: { cookie: 'session=a' } });
  assert.equal(video.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(Buffer.from(await video.arrayBuffer()), Buffer.from([0, 1, 2, 255]));
});

test('only the documented mix service paths are reachable through the proxy', async t => {
  const { base, received } = await fixture(t);
  for (const path of ['/api/mix/admin', '/api/mix/jobs/invalid/video', '/api/browser-materials/pair']) {
    assert.equal((await fetch(base + path, { headers: { cookie: 'session=a' } })).status, 404);
  }
  assert.equal(received.length, 0);
});

test('explicit directory disconnect uses the verified owner and releases the private directory binding', async t => {
  const { base, received } = await fixture(t);
  const path = '/api/browser-materials/devices/' + 'd'.repeat(32);
  const response = await fetch(base + path, { method: 'DELETE', headers: { cookie: 'session=a', Origin: 'https://studio.example', 'x-material-owner': hash('bob') } });
  assert.equal(response.status, 200);
  assert.equal(received[0].path, path.replace('/api/', '/v1/'));
  assert.equal(received[0].headers['x-material-owner'], hash('alice'));
});
