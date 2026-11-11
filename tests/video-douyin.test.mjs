import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer } from 'node:http';
import { once, EventEmitter } from 'node:events';
import { douyinShareURL, parseDouyinVideo, extractDouyinVideo, downloadDouyinVideo, createDouyinHandler } from '../services/video/douyin.mjs';
import { createVideoHandler } from '../services/video/server.mjs';

const ID = '6961737553342991651', LINK = `https://www.douyin.com/video/${ID}`;
const VIDEO = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(100)]);
const item = { aweme_id: ID, desc: '示例视频', video: { play_addr: { url_list: ['https://aweme.snssdk.com/aweme/v1/playwm/?video_id=example&ratio=720p'] }, download_addr: { url_list: ['https://watermarked.example/video.mp4'] } } };
const html = value => `<script>window._ROUTER_DATA = ${JSON.stringify({ loaderData: { 'video_(id)/page': { videoInfoRes: { item_list: [value] } } } })};</script>`;
async function folder(t) {
  const root = await mkdtemp(join(tmpdir(), 'douyin-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('share text, short URLs and modal links are accepted, other domains and credentials are rejected', () => {
  assert.equal(douyinShareURL(`看看这个视频 ${LINK} 复制打开抖音`).href, LINK);
  assert.equal(douyinShareURL('https://v.douyin.com/abc/。').hostname, 'v.douyin.com');
  assert.equal(douyinShareURL(`https://www.douyin.com/user/test?modal_id=${ID}`).searchParams.get('modal_id'), ID);
  for (const input of ['', null, 'x'.repeat(5001), 'https://127.0.0.1/video/123', 'https://douyin.com.evil.example/', 'https://douyin.com@evil.example/', 'https://user:pass@www.douyin.com/', 'https://www.douyin.com:444/video/123']) {
    assert.throws(() => douyinShareURL(input), { status: 400 });
  }
});

test('parser selects the requested video playback URL without a watermark and rejects image posts', () => {
  const parsed = parseDouyinVideo(html(item), ID);
  assert.equal(parsed.name, '示例视频');
  assert.equal(new URL(parsed.url).pathname, '/aweme/v1/play/');
  assert.equal(parseDouyinVideo(html(item), '7777777777777777777'), null);
  assert.equal(parseDouyinVideo('<script>window._ROUTER_DATA = invalid;</script>', ID), null);
  assert.throws(() => parseDouyinVideo(html({ ...item, images: [{}] }), ID), /图文/);
  assert.throws(() => parseDouyinVideo(html({ ...item, video: { download_addr: item.video.download_addr } }), ID), /未找到/);
});

test('short links follow trusted redirects and obtain visitor cookies before downloading a verified MP4', async t => {
  const path = join(await folder(t), 'video.mp4'), calls = [];
  const result = await extractDouyinVideo('分享 https://v.douyin.com/abc/', path, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.includes('v.douyin.com')) return new Response(null, { status: 302, headers: { Location: LINK } });
      if (!options.headers.Cookie) return new Response('<html>打开 App</html>', { headers: { 'Set-Cookie': 'ttwid=visitor; Secure; HttpOnly' } });
      return new Response(html(item));
    },
    download: async (url, output, options) => { assert.equal(new URL(url).pathname, '/aweme/v1/play/'); assert.ok(options.signal); await writeFile(output, VIDEO); },
    probe: async output => { assert.deepEqual(await readFile(output), VIDEO); return { duration: 19, audio: true }; },
  });
  assert.equal(result.filename, '示例视频.mp4'); assert.equal(result.metadata.duration, 19);
  assert.ok(calls.some(call => call.options.headers.Cookie === 'ttwid=visitor'));
});

test('redirects outside Douyin are stopped before fetching and unavailable posts never download', async t => {
  const path = join(await folder(t), 'video.mp4'); let calls = 0;
  await assert.rejects(extractDouyinVideo('https://v.douyin.com/abc/', path, { fetchImpl: async () => {
    calls++; return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } });
  } }), { status: 400 });
  assert.equal(calls, 1);
  await assert.rejects(extractDouyinVideo(LINK, path, { fetchImpl: async () => new Response('打开 App'), download: () => assert.fail('no video to download') }), { status: 422 });
});

test('media downloader follows only Douyin CDN redirects and streams complete bytes to disk', async t => {
  const path = join(await folder(t), 'video.mp4'), calls = [];
  await downloadDouyinVideo('https://aweme.snssdk.com/aweme/v1/play/?video_id=example', path, { fetchImpl: async (url, options) => {
    calls.push(url); assert.match(options.headers['User-Agent'], /iPhone/);
    return calls.length === 1 ? new Response(null, { status: 302, headers: { Location: 'https://v26.douyinvod.com/video.mp4' } })
      : new Response(VIDEO, { headers: { 'Content-Length': String(VIDEO.length) } });
  } });
  assert.equal(calls.length, 2); assert.deepEqual(await readFile(path), VIDEO);
});

test('media downloader rejects external redirects, oversized bodies and truncated streams', async t => {
  const path = join(await folder(t), 'video.mp4');
  for (const location of ['https://127.0.0.1/private', 'https://douyinvod.com.evil.example/file', 'https://user:pass@v26.douyinvod.com/file']) {
    let calls = 0;
    await assert.rejects(downloadDouyinVideo('https://aweme.snssdk.com/play/', path, { fetchImpl: async () => {
      calls++; return new Response(null, { status: 302, headers: { Location: location } });
    } }), /不受支持/);
    assert.equal(calls, 1);
  }
  await assert.rejects(downloadDouyinVideo('https://v26.douyinvod.com/file', path, { fetchImpl: async () => new Response('x', { headers: { 'Content-Length': '400000000' } }) }), { status: 413 });
  await assert.rejects(downloadDouyinVideo('https://v26.douyinvod.com/file', path, { fetchImpl: async () => new Response('x', { headers: { 'Content-Length': '100' } }) }), /不完整/);
});

test('extraction endpoint requires authentication and same-origin POST, returns media and cleans temporary files without creating a task', async t => {
  const root = await folder(t); let extractedPath, count = 0;
  const handler = createVideoHandler({ storageDir: root, env: {}, config: { enabled: false },
    douyin: createDouyinHandler({ extract: async (_text, path) => {
      count++; extractedPath = path; await writeFile(path, VIDEO); return { id: ID, filename: '示例视频.mp4', metadata: { duration: 19 } };
    } }),
  });
  await handler.ready;
  const server = createServer((req, res) => { req.authenticatedUserId = req.headers['x-user']; void handler(req, res); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await handler.shutdown(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/api/video-replica`;
  const send = headers => fetch(base + '/douyin', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ text: LINK }) });
  assert.equal((await send({})).status, 401);
  assert.equal((await send({ 'X-User': 'alice', Origin: 'https://evil.example' })).status, 403);
  assert.equal(count, 0);
  const response = await send({ 'X-User': 'alice' });
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(decodeURIComponent(response.headers.get('x-video-name')), '示例视频.mp4');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), VIDEO);
  for (let i = 0; i < 30 && await stat(dirname(extractedPath)).catch(() => null); i++) await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(stat(dirname(extractedPath)), { code: 'ENOENT' });
  const tasks = await (await fetch(base + '/tasks', { headers: { 'X-User': 'alice' } })).json();
  assert.deepEqual(tasks.tasks, []); assert.equal(count, 1);
});

test('concurrent extraction is limited per owner and a failed download cleans partial files and allows retry', async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { started = resolve; });
  const paths = [];
  const handler = createDouyinHandler({ extract: async (_text, path) => {
    paths.push(path); await writeFile(path, 'partial'); started(); await gate; throw new Error('download failed');
  } });
  const req = { authenticatedUserId: 'alice' };
  const first = assert.rejects(handler(req, new EventEmitter(), LINK), /download failed/);
  await entered;
  await assert.rejects(handler(req, new EventEmitter(), LINK), { status: 429 });
  release(); await first;
  await assert.rejects(handler(req, new EventEmitter(), LINK), /download failed/);
  assert.equal(paths.length, 2); assert.notEqual(paths[0], paths[1]);
  for (const path of paths) await assert.rejects(stat(dirname(path)), { code: 'ENOENT' });
});
