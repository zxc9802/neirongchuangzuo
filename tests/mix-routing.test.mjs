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
    const audio = req.url.endsWith('/stream');
    res.setHeader('Content-Type', audio ? 'audio/wav' : req.url.endsWith('/video') ? 'video/mp4' : 'application/json');
    res.setHeader('Upload-Offset', '12');
    if (audio && req.headers.range) { res.statusCode = 206; res.setHeader('Content-Range', 'bytes 0-3/4'); }
    res.end(audio || req.url.endsWith('/video') ? Buffer.from([0, 1, 2, 255]) : JSON.stringify({ ok: true }));
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
  for (const path of ['/api/mix/health', '/api/mix/jobs', '/api/mix/audio?kind=voice', '/api/browser-materials/devices/' + 'a'.repeat(32) + '/requests']) {
    assert.equal((await fetch(base + path, { headers: { 'x-material-owner': hash('alice') } })).status, 401);
  }
  assert.equal(received.length, 0);
});

test('browser video repair serves pinned same-origin worker assets without exposing node_modules', async t => {
  const { base } = await fixture(t);
  for (const file of ['index.js', 'classes.js', 'worker.js', 'const.js', 'errors.js', 'utils.js', 'types.js', 'ffmpeg-core.js']) {
    const response = await fetch(base + '/vendor/ffmpeg/' + file);
    assert.equal(response.status, 200, file);
    assert.match(response.headers.get('content-type'), /javascript/);
    assert.ok((await response.text()).length > 0);
  }
  const wasm = await fetch(base + '/vendor/ffmpeg/ffmpeg-core.wasm');
  assert.equal(wasm.status, 200);
  assert.equal(wasm.headers.get('content-type'), 'application/wasm');
  assert.deepEqual(new Uint8Array(await wasm.arrayBuffer()).slice(0, 4), new Uint8Array([0, 97, 115, 109]));
  for (const path of ['/vendor/ffmpeg/package.json', '/node_modules/@ffmpeg/core/package.json', '/vendor/ffmpeg/unknown.js']) {
    assert.equal((await fetch(base + path)).status, 404);
  }
});

test('audio library routes preserve raw uploads and query names while using the verified owner', async t => {
  const { base, received } = await fixture(t);
  const query = new URLSearchParams({ kind: 'voice', name: '我的音色.wav' });
  const bytes = Buffer.from([82, 73, 70, 70, 0, 1, 255]);
  const response = await fetch(base + '/api/mix/audio?' + query, { method: 'POST',
    headers: { cookie: 'session=a', Origin: 'https://studio.example', 'Content-Type': 'audio/wav',
      'x-material-owner': hash('forged'), authorization: 'Bearer forged' }, body: bytes });
  assert.equal(response.status, 200);
  assert.equal(received[0].path, '/v1/mix/audio?' + query);
  assert.deepEqual(received[0].body, bytes);
  assert.equal(received[0].headers['content-type'], 'audio/wav');
  assert.equal(received[0].headers['x-material-owner'], hash('alice'));
  assert.equal(received[0].headers.authorization, 'Bearer ' + 'a'.repeat(64));
  assert.equal(received[0].headers.cookie, undefined);
  assert.equal((await fetch(base + '/api/mix/audio?kind=music', { headers: { cookie: 'session=b' } })).status, 200);
  assert.equal(received[1].path, '/v1/mix/audio?kind=music');
  assert.equal(received[1].headers['x-material-owner'], hash('bob'));
});

test('audio preview ranges and deletion stay inside authenticated same-origin routes', async t => {
  const { base, received } = await fixture(t);
  const path = '/api/mix/audio/' + 'd'.repeat(32);
  const audio = await fetch(base + path + '/stream', { headers: { cookie: 'session=a', Range: 'bytes=0-3' } });
  assert.equal(audio.status, 206);
  assert.equal(audio.headers.get('content-type'), 'audio/wav');
  assert.equal(audio.headers.get('content-range'), 'bytes 0-3/4');
  assert.deepEqual(Buffer.from(await audio.arrayBuffer()), Buffer.from([0, 1, 2, 255]));
  assert.equal(received[0].headers.range, 'bytes=0-3');
  assert.equal((await fetch(base + path + '/stream', { method: 'HEAD', headers: { cookie: 'session=a' } })).status, 200);
  assert.equal((await fetch(base + path, { method: 'DELETE', headers: { cookie: 'session=a', Origin: 'https://attacker.example' } })).status, 403);
  assert.equal(received.length, 2);
  assert.equal((await fetch(base + path, { method: 'DELETE', headers: { cookie: 'session=a', Origin: 'https://studio.example' } })).status, 200);
  for (const suffix of ['/download', '/secret', '/stream/extra']) {
    assert.equal((await fetch(base + path + suffix, { headers: { cookie: 'session=a' } })).status, 404);
  }
  assert.equal(received.length, 3);
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
