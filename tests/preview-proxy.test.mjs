import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPreviewServer } from '../preview.mjs';

async function listen(server) {
  await server.ready;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
async function isolatedPreview(t, backendUrl) {
  const storageDir = await mkdtemp(join(tmpdir(), 'preview-proxy-'));
  const preview = createPreviewServer({ backendUrl, aiOptions: {
    storageDir,
    config: { apiKey: '', baseUrl: 'https://unused.invalid/v1', imageModel: 'test-image', chatModel: 'test-chat' },
    fetchImpl: async () => { throw new Error('Unexpected provider request in proxy test'); },
    downloadImpl: async () => { throw new Error('Unexpected download in proxy test'); },
  } });
  t.after(async () => { await close(preview); await rm(storageDir, { recursive: true, force: true }); });
  return preview;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

test('proxy preserves raw uploads, session cookies, origins, ranged media and streamed task updates', async t => {
  let received;
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = { url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks) };
    if (req.url.includes('/stream')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write('data: {"progress":10}\n\n');
      res.end('data: {"progress":100}\n\n');
    } else if (req.headers.range) {
      res.writeHead(206, { 'Content-Range': 'bytes 2-4/6', 'Content-Type': 'video/mp4' });
      res.end('cde');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': ['session=test; HttpOnly; Path=/', 'other=value; Path=/'] });
      res.end('{"success":true}');
    }
  });
  const backendUrl = await listen(upstream);
  const preview = await isolatedPreview(t, backendUrl);
  const base = await listen(preview);
  t.after(async () => { await close(preview); await close(upstream); });
  const bytes = Buffer.from([0, 255, 17, 23, 31]);
  const upload = await fetch(base + '/api/upload?folder=videos&fileName=test.mp4', {
    method: 'POST', body: bytes,
    headers: { 'Content-Type': 'video/mp4', Cookie: 'session=local', Origin: base },
  });
  assert.equal(upload.status, 200);
  assert.deepEqual(received.body, bytes);
  assert.equal(received.url, '/api/upload?folder=videos&fileName=test.mp4');
  assert.equal(received.headers.cookie, 'session=local');
  assert.equal(received.headers.origin, base);
  assert.equal(received.headers['content-length'], String(bytes.length));
  assert.equal(upload.headers.getSetCookie().length, 2);
  const media = await fetch(base + '/api/avatars/test/video', { headers: { Range: 'bytes=2-4' } });
  assert.equal(media.status, 206);
  assert.equal(media.headers.get('content-range'), 'bytes 2-4/6');
  assert.equal(await media.text(), 'cde');
  const stream = await fetch(base + '/api/tasks/test/stream');
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  assert.match(await stream.text(), /data: \{"progress":100\}/);
});

test('unavailable backend returns a readable error while the main workspace remains available', async t => {
  const reserve = createServer();
  const backendUrl = await listen(reserve);
  await close(reserve);
  const preview = await isolatedPreview(t, backendUrl);
  const base = await listen(preview);
  t.after(() => close(preview));
  const failed = await fetch(base + '/api/avatars');
  assert.equal(failed.status, 502);
  assert.equal((await failed.json()).code, 'SERVICE_UNAVAILABLE');
  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /起芽内容创作/);
});
