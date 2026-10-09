import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { downloadVideo } from '../services/video/media.mjs';

const PUBLIC = 'http://video.example/result.mp4';
const ETAG = '"version-one"';
async function fixture(t, handle, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'video-download-'));
  const path = join(root, 'result.tmp'), calls = [];
  const app = createServer((req, res) => { Promise.resolve(handle(req, res, calls.length)).catch(error => res.destroy(error)); });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const base = `http://127.0.0.1:${app.address().port}`;
  const settings = {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    transport(target, config, callback) {
      calls.push({ url: String(target), headers: { ...config.headers } });
      return request(new URL(target.pathname + target.search, base), config, callback);
    },
    attemptTimeoutMs: 30_000, connectTimeoutMs: 10_000, idleTimeoutMs: 15_000, ...options,
  };
  t.after(async () => { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); await rm(root, { recursive: true, force: true }); });
  async function seed(bytes, totalBytes, etag = ETAG) {
    await writeFile(path, bytes);
    await writeFile(path + '.download.json', JSON.stringify({ version: 1, url: PUBLIC, etag, totalBytes }));
  }
  return { path, calls, settings, base, seed, run: extra => downloadVideo(PUBLIC, path, { ...settings, ...extra }) };
}
async function written(path, expected) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { if ((await stat(path)).size >= expected) return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(20);
  }
  throw new Error('The real HTTP stream did not persist its expected prefix');
}
async function partial(res, body, path) {
  res.writeHead(200, { 'Content-Length': body.length, ETag: ETAG });
  res.write(body.subarray(0, body.length / 2));
  await written(path, body.length / 2);
  res.destroy();
}
function range(res, body, offset, etag = ETAG) {
  res.writeHead(206, { ETag: etag, 'Content-Range': `bytes ${offset}-${body.length - 1}/${body.length}`, 'Content-Length': body.length - offset });
  res.end(body.subarray(offset));
}

test('an interrupted real HTTP stream resumes with Range and If-Range, retaining its prefix', async t => {
  const body = Buffer.from(Array.from({ length: 128 * 1024 }, (_, i) => i % 251));
  const app = await fixture(t, (req, res, count) => count === 1 ? partial(res, body, app.path) : range(res, body, body.length / 2));
  await assert.rejects(app.run());
  assert.equal((await stat(app.path)).size, body.length / 2);
  assert.equal(JSON.parse(await readFile(app.path + '.download.json')).etag, ETAG);
  const progress = [], result = await app.run({ onProgress: value => progress.push(value) });
  assert.deepEqual(await readFile(app.path), body);
  assert.equal(app.calls[1].headers.Range, `bytes=${body.length / 2}-`);
  assert.equal(app.calls[1].headers['If-Range'], ETAG);
  assert.equal(result.resumed, true);
  assert.equal(progress[0].bytes, body.length / 2);
  assert.equal(progress.at(-1).complete, true);
  await assert.rejects(stat(app.path + '.download.json'), { code: 'ENOENT' });
});

test('a 200 reply to a resumed request replaces the stale entity instead of appending', async t => {
  const before = Buffer.alloc(8192, 1), after = Buffer.alloc(6000, 2);
  const app = await fixture(t, (_req, res, count) => {
    if (count === 1) return partial(res, before, app.path);
    else { res.writeHead(200, { ETag: '"version-two"', 'Content-Length': after.length }); res.end(after); }
  });
  await assert.rejects(app.run());
  const result = await app.run();
  assert.equal(app.calls[1].headers['If-Range'], ETAG);
  assert.equal(result.resumed, false);
  assert.deepEqual(await readFile(app.path), after);
});

test('an idle timeout preserves bytes and the next request completes the original entity', async t => {
  const body = Buffer.alloc(8192, 3);
  const app = await fixture(t, (_req, res, count) => {
    if (count === 1) { res.writeHead(200, { ETag: ETAG, 'Content-Length': body.length }); res.write(body.subarray(0, 4096)); }
    else range(res, body, 4096);
  });
  await assert.rejects(app.run({ idleTimeoutMs: 5000 }), /stalled/);
  assert.equal((await stat(app.path)).size, 4096);
  await app.run();
  assert.deepEqual(await readFile(app.path), body);
});

test('overall cancellation also retains safe resume metadata, while steady streams finish', async t => {
  const body = Buffer.alloc(4096, 4);
  const app = await fixture(t, (_req, res, count) => {
    if (count > 1) { range(res, body, 1024); return; }
    res.writeHead(200, { ETag: ETAG, 'Content-Length': body.length }); res.write(body.subarray(0, 1024));
  });
  await assert.rejects(app.run({ attemptTimeoutMs: 5000 }), /timed out|abort/i);
  assert.equal((await stat(app.path)).size, 1024);
  await app.run(); assert.deepEqual(await readFile(app.path), body);
  const steadyBody = Buffer.alloc(7 * 1024, 4);
  const steady = await fixture(t, async (_req, res) => {
    res.writeHead(200, { ETag: ETAG, 'Content-Length': steadyBody.length });
    for (let i = 0; i < 7; i++) {
      res.write(steadyBody.subarray(i * 1024, (i + 1) * 1024));
      await written(steady.path, (i + 1) * 1024);
      if (i < 6) await delay(1000);
    }
    res.end();
  });
  const started = Date.now();
  await steady.run({ idleTimeoutMs: 5000 });
  assert.ok(Date.now() - started >= 6000, 'Steady transfer must outlive one complete idle timeout window');
  assert.deepEqual(await readFile(steady.path), steadyBody);
});

test('the previous AbortSignal argument remains supported and progress observers cannot break a download', async t => {
  const body = Buffer.alloc(4096, 5), controller = new AbortController();
  const app = await fixture(t, async (_req, res, count) => {
    if (count === 1) {
      res.writeHead(200, { ETag: ETAG, 'Content-Length': body.length }); res.write(body.subarray(0, 1024));
      await written(app.path, 1024); controller.abort();
    } else range(res, body, 1024);
  });
  await assert.rejects(downloadVideo(PUBLIC, app.path, controller.signal, app.settings), /abort/i);
  assert.equal((await stat(app.path)).size, 1024);
  await app.run({ onProgress: async () => { throw new Error('Disconnected observer'); } });
  assert.deepEqual(await readFile(app.path), body);
});

test('206 responses require an exact offset, valid total, matching length and strong entity validator', async t => {
  for (const headers of [
    { ETag: ETAG, 'Content-Range': 'bytes 2-7/8', 'Content-Length': '6' },
    { ETag: ETAG, 'Content-Range': 'bytes 4-8/8', 'Content-Length': '5' },
    { ETag: ETAG, 'Content-Range': 'bytes 4-7/9', 'Content-Length': '4' },
    { ETag: ETAG, 'Content-Range': 'bytes 4-7/8', 'Content-Length': '3' },
    { ETag: '"other"', 'Content-Range': 'bytes 4-7/8', 'Content-Length': '4' },
    { 'Content-Range': 'bytes 4-7/8', 'Content-Length': '4' },
    { ETag: ETAG, 'Content-Range': 'bytes 4-7/*', 'Content-Length': '4' },
  ]) {
    await t.test(JSON.stringify(headers), async child => {
      const app = await fixture(child, (_req, res) => { res.writeHead(206, headers); res.end(Buffer.alloc(4, 2)); });
      await app.seed(Buffer.alloc(4, 1), 8);
      await assert.rejects(app.run(), /content range/);
      assert.deepEqual(await readFile(app.path), Buffer.alloc(4, 1));
      await assert.rejects(stat(app.path + '.download.json'), { code: 'ENOENT' });
    });
  }
});

test('416 is accepted only for a complete length-matched and validator-matched saved file', async t => {
  const body = Buffer.from('complete');
  const app = await fixture(t, (_req, res) => { res.writeHead(416, { ETag: ETAG, 'Content-Range': 'bytes */8' }); res.end(); });
  await app.seed(body, 8);
  assert.equal((await app.run()).bytes, 8);
  assert.deepEqual(await readFile(app.path), body);
  for (const headers of [
    { ETag: ETAG, 'Content-Range': 'bytes */9' },
    { ETag: '"changed"', 'Content-Range': 'bytes */8' },
    { 'Content-Range': 'bytes */8' },
  ]) {
    await t.test(JSON.stringify(headers), async child => {
      const invalid = await fixture(child, (_req, res) => { res.writeHead(416, headers); res.end(); });
      await invalid.seed(body, 8);
      await assert.rejects(invalid.run(), /does not match/);
      assert.deepEqual(await readFile(invalid.path), body);
      await assert.rejects(stat(invalid.path + '.download.json'), { code: 'ENOENT' });
    });
  }
});

test('a valid shorter range retains its received bytes and resumes again until the entire asset exists', async t => {
  const body = Buffer.from('complete');
  const app = await fixture(t, (_req, res, count) => {
    if (count === 1) { res.writeHead(206, { ETag: ETAG, 'Content-Range': 'bytes 2-4/8', 'Content-Length': 3 }); res.end(body.subarray(2, 5)); }
    else range(res, body, 5);
  });
  await app.seed(body.subarray(0, 2), body.length);
  await assert.rejects(app.run(), /incomplete/);
  assert.deepEqual(await readFile(app.path), body.subarray(0, 5));
  await app.run(); assert.deepEqual(await readFile(app.path), body);
  assert.equal(app.calls[1].headers.Range, 'bytes=5-');
});

test('resume requires a strong ETag; weak validators and untracked partial files restart safely', async t => {
  const body = Buffer.alloc(8, 2);
  for (const etag of [null, 'W/"version-one"']) {
    await t.test(String(etag), async child => {
      const app = await fixture(child, (_req, res) => { res.writeHead(200, { ETag: ETAG }); res.end(body); });
      await app.seed(Buffer.alloc(4, 1), 8, etag);
      await app.run(); assert.deepEqual(await readFile(app.path), body);
      assert.equal(app.calls[0].headers.Range, undefined);
    });
  }
  const untracked = await fixture(t, (_req, res) => { res.writeHead(200); res.end(body); });
  await writeFile(untracked.path, Buffer.alloc(4, 1));
  await untracked.run(); assert.deepEqual(await readFile(untracked.path), body);
});

test('the byte limit includes retained bytes, declared totals and chunked bodies', async t => {
  const resumed = await fixture(t, (_req, res) => range(res, Buffer.alloc(100), 60));
  await resumed.seed(Buffer.alloc(60), 100);
  await assert.rejects(resumed.run({ maxBytes: 80 }), /too large/);
  assert.equal((await stat(resumed.path)).size, 60);
  const declared = await fixture(t, (_req, res) => { res.writeHead(200, { 'Content-Length': 200 * 1024 * 1024 + 1 }); res.end('x'); });
  await assert.rejects(declared.run({ maxBytes: 1024 * 1024 * 1024 }), /too large/);
  await assert.rejects(stat(declared.path), { code: 'ENOENT' });
  const chunked = await fixture(t, async (_req, res) => {
    res.writeHead(200, { ETag: ETAG }); res.write(Buffer.alloc(60));
    await written(chunked.path, 60); res.end(Buffer.alloc(30));
  });
  await assert.rejects(chunked.run({ maxBytes: 80 }), /too large/);
  assert.equal((await stat(chunked.path)).size, 60);
});

test('unsolicited range responses and encoded entities are rejected before opening the output', async t => {
  for (const headers of [
    { 'Content-Range': 'bytes 0-3/4', 'Content-Length': 4, ETag: ETAG },
    { 'Content-Encoding': 'gzip', 'Content-Length': 4, ETag: ETAG },
  ]) {
    await t.test(JSON.stringify(headers), async child => {
      const status = headers['Content-Range'] ? 206 : 200;
      const app = await fixture(child, (_req, res) => { res.writeHead(status, headers); res.end('test'); });
      await assert.rejects(app.run()); await assert.rejects(stat(app.path), { code: 'ENOENT' });
    });
  }
});

test('all redirect hops are DNS-pinned and private, mixed, credentialed and port URLs remain rejected', async t => {
  const app = await fixture(t, (_req, res) => { res.writeHead(302, { Location: 'http://private.example/result.mp4' }); res.end(); }, {
    lookup: async host => [{ address: host === 'private.example' ? '10.0.0.1' : '8.8.8.8', family: 4 }],
  });
  await assert.rejects(app.run(), /Private video address/);
  assert.equal(app.calls.length, 1);
  await assert.rejects(stat(app.path), { code: 'ENOENT' });
  await assert.rejects(app.run({ lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] }), /Private video address/);
  for (const url of ['file:///etc/passwd', 'http://user:pass@video.example/result', 'http://video.example:8080/result']) {
    await assert.rejects(downloadVideo(url, app.path, app.settings), /Invalid video URL/);
  }
  const loop = await fixture(t, (_req, res) => { res.writeHead(302, { Location: '/loop' }); res.end(); });
  await assert.rejects(loop.run(), /Invalid video URL/); assert.equal(loop.calls.length, 4);
});

test('a safe redirect preserves Range and If-Range only after rechecking its public destination', async t => {
  const body = Buffer.from('complete'), lookups = [];
  const app = await fixture(t, (req, res) => {
    if (req.url === '/result.mp4') { res.writeHead(302, { Location: 'http://cdn.example/final' }); res.end(); }
    else range(res, body, 4);
  }, { lookup: async host => { lookups.push(host); return [{ address: '8.8.8.8', family: 4 }]; } });
  await app.seed(body.subarray(0, 4), 8);
  await app.run(); assert.deepEqual(await readFile(app.path), body);
  assert.deepEqual(lookups, ['video.example', 'cdn.example']);
  assert.equal(app.calls[1].headers.Range, 'bytes=4-'); assert.equal(app.calls[1].headers['If-Range'], ETAG);
});

test('a stalled DNS lookup respects the overall abort deadline before any connection or write', async t => {
  const app = await fixture(t, (_req, res) => res.end(), { lookup: () => new Promise(() => {}) });
  await assert.rejects(app.run({ attemptTimeoutMs: 1000 }), /timed out/);
  assert.equal(app.calls.length, 0); await assert.rejects(stat(app.path), { code: 'ENOENT' });
});

test('connection failures try another vetted address without changing the destination host', async t => {
  const body = Buffer.from('public'), attempts = [];
  const app = await fixture(t, (_req, res) => { res.writeHead(200, { 'Content-Length': body.length }); res.end(body); });
  await app.run({
    lookup: async () => [{ address: '2001:4860:4860::8888', family: 6 }, { address: '8.8.8.8', family: 4 }],
    transport(target, settings, callback) {
      let pinned;
      settings.lookup(target.hostname, { all: false }, (_error, address) => { pinned = address; });
      attempts.push({ host: target.hostname, pinned });
      // Port 1 refuses the first real TCP request; the second uses our HTTP fixture.
      return request(pinned === '8.8.8.8' ? 'http://127.0.0.1:1/result.mp4' : new URL(target.pathname, app.base), settings, callback);
    },
  });
  assert.deepEqual(attempts, [{ host: 'video.example', pinned: '8.8.8.8' }, { host: 'video.example', pinned: '2001:4860:4860::8888' }]);
  assert.deepEqual(await readFile(app.path), body);
});
