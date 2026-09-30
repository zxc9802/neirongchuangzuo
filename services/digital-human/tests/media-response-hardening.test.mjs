// 媒体代理 servePrivateMedia / downloadTrustedMediaToFile 的运行时安全行为：
// 在临时工作目录里真实读文件，用 fetch 桩验证远程白名单、重定向、大小上限与响应头过滤。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shuziren-media-"));
const REFERENCE_URL = "https://ref.example.test/speaker.wav";

// 让 config / media-path-policy 以临时目录为工作目录，并预置一个受信任的参考音频地址
process.chdir(tmpRoot);
process.env.INDEXTTS_SPEAKER_AUDIO_URL = REFERENCE_URL;
delete process.env.INDEXTTS_EMOTION_AUDIO_URL;

const media = await import("../src/lib/server/media-response.ts");

const write = (relative, content) => {
  const target = path.join(tmpRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
};

const SECRET = write(".settings.json", '{"indexttsApiKey":"sk-secret"}');
write(".env", "APP_SESSION_SECRET=top-secret\n");
const PRIVATE_VIDEO = write(".runtime/uploads/users/u1/videos/a.mp4", "private-video-bytes");
write("public/uploads/legacy.mp4", "legacy-video-bytes");
write("public/jobs/task_1/final.mp4", "final-video-bytes");
fs.mkdirSync(path.join(tmpRoot, ".runtime/uploads/users/u1/videos/dir.mp4"), { recursive: true });

const fakeRequest = (headers = {}) => ({ headers: new Headers(headers) });
const originalFetch = globalThis.fetch;

function stubFetch(responders) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const responder = responders[Math.min(calls.length - 1, responders.length - 1)];
    return typeof responder === "function" ? responder(calls.length - 1) : responder;
  };
  return calls;
}

test.after(() => {
  globalThis.fetch = originalFetch;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("missing or empty sources return 404 without touching the filesystem or network", async () => {
  const calls = stubFetch([]);
  for (const source of [undefined, "", null]) {
    const response = await media.servePrivateMedia(fakeRequest(), source);
    assert.equal(response.status, 404);
  }
  assert.equal(calls.length, 0);
});

test("absolute paths outside the media roots are rejected even when the file exists (no LFI)", async () => {
  for (const source of [
    SECRET,
    path.join(tmpRoot, ".env"),
    "/etc/passwd",
    "/proc/self/environ",
    path.join(tmpRoot, ".runtime/uploads/../../.settings.json"),
  ]) {
    const response = await media.servePrivateMedia(fakeRequest(), source);
    assert.equal(response.status, 404, `必须拒绝 ${source}`);
  }
});

test("relative /uploads and /jobs references cannot traverse out of public/", async () => {
  for (const source of [
    "/uploads/../../.settings.json",
    "/uploads/../.env",
    "/jobs/../../.settings.json",
    "/uploads/..%2F..%2F.settings.json",
  ]) {
    const response = await media.servePrivateMedia(fakeRequest(), source);
    assert.equal(response.status, 404, `必须拒绝 ${source}`);
  }
});

test("files inside the private runtime root are served with private, non-sniffable headers", async () => {
  const response = await media.servePrivateMedia(fakeRequest(), PRIVATE_VIDEO, {
    contentType: "video/mp4",
    downloadName: "digital-human-video.mp4",
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "private-video-bytes");
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.equal(response.headers.get("content-length"), String("private-video-bytes".length));
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    response.headers.get("content-disposition"),
    'attachment; filename="digital-human-video.mp4"'
  );
});

test("legacy public/uploads and public/jobs references remain readable for compatibility", async () => {
  const legacy = await media.servePrivateMedia(fakeRequest(), "/uploads/legacy.mp4");
  assert.equal(legacy.status, 200);
  assert.equal(await legacy.text(), "legacy-video-bytes");
  assert.equal(legacy.headers.get("content-type"), "application/octet-stream");

  const job = await media.servePrivateMedia(fakeRequest(), "/jobs/task_1/final.mp4", { contentType: "video/mp4" });
  assert.equal(job.status, 200);
  assert.equal(await job.text(), "final-video-bytes");
});

test("private local videos serve byte ranges so crop preview can seek", async () => {
  const bytes="private-video-bytes";
  for(const [range,start,end] of [["bytes=2-6",2,6],["bytes=8-",8,18],["bytes=-5",14,18],["bytes=10-999",10,18]]) {
    const response=await media.servePrivateMedia(fakeRequest({range}),PRIVATE_VIDEO,{contentType:"video/mp4"});
    assert.equal(response.status,206);
    assert.equal(await response.text(),bytes.slice(start,end+1));
    assert.equal(response.headers.get("content-range"),`bytes ${start}-${end}/${bytes.length}`);
    assert.equal(response.headers.get("content-length"),String(end-start+1));
    assert.equal(response.headers.get("accept-ranges"),"bytes");
    assert.equal(response.headers.get("cache-control"),"private, no-store");
    assert.equal(response.headers.get("x-content-type-options"),"nosniff");
  }
  for(const range of ["bytes=19-","bytes=9-2","bytes=-0","bytes=0-1,4-5","bytes=999999999999999999999999-"]) {
    const response=await media.servePrivateMedia(fakeRequest({range}),PRIVATE_VIDEO);
    assert.equal(response.status,416); assert.equal(response.headers.get("content-range"),"bytes */19");
    assert.equal(await response.text(),"");
  }
  const head=await media.servePrivateMedia({...fakeRequest({range:"bytes=2-6"}),method:"HEAD"},PRIVATE_VIDEO);
  assert.equal(head.status,206); assert.equal(head.headers.get("content-length"),"5"); assert.equal(await head.text(),"");
  assert.equal((await media.servePrivateMedia(fakeRequest({range:"bytes=0-4"}),SECRET)).status,404);
});

test("allowed roots still 404 for missing files and directories", async () => {
  const missing = await media.servePrivateMedia(fakeRequest(), "/uploads/does-not-exist.mp4");
  assert.equal(missing.status, 404);
  const directory = await media.servePrivateMedia(
    fakeRequest(),
    path.join(tmpRoot, ".runtime/uploads/users/u1/videos/dir.mp4")
  );
  assert.equal(directory.status, 404);
});

test("remote sources outside the allow-list are never fetched (no SSRF)", async () => {
  const calls = stubFetch([new Response("should-not-be-served", { status: 200 })]);
  for (const source of [
    "https://169.254.169.254/latest/meta-data/iam/",
    "http://127.0.0.1:3000/api/settings",
    "https://internal.service.local/admin",
    "https://file.302.ai/gpt/imgs/a.mp3",
    "file:///etc/passwd",
    "data:text/plain,hello",
    "ftp://ref.example.test/speaker.wav",
    "http://ref.example.test/speaker.wav",
    REFERENCE_URL, // 未显式允许配置引用时同样拒绝
    `${REFERENCE_URL}?x=1`,
    "https://ref.example.test/other.wav",
  ]) {
    const response = await media.servePrivateMedia(fakeRequest(), source);
    assert.equal(response.status, 404, `必须拒绝 ${source}`);
  }
  assert.equal(calls.length, 0, "任何未授权远程地址都不应触发网络请求");
});

test("the configured reference audio is only fetchable when explicitly allowed, with Range forwarded and upstream headers filtered", async () => {
  const calls = stubFetch([
    new Response("wav-bytes", {
      status: 206,
      headers: {
        "content-type": "audio/wav",
        "content-length": "9",
        "content-range": "bytes 0-8/9",
        "accept-ranges": "bytes",
        server: "heygen-edge",
        "x-amz-request-id": "leak",
        "set-cookie": "upstream=1",
        "x-provider": "302.ai",
      },
    }),
  ]);

  const response = await media.servePrivateMedia(fakeRequest({ range: "bytes=0-8" }), REFERENCE_URL, {
    allowConfiguredReference: true,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, REFERENCE_URL);
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.headers.Range, "bytes=0-8");

  assert.equal(response.status, 206);
  assert.equal(await response.text(), "wav-bytes");
  assert.equal(response.headers.get("content-type"), "audio/wav");
  assert.equal(response.headers.get("content-range"), "bytes 0-8/9");
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  for (const leaked of ["server", "x-amz-request-id", "set-cookie", "x-provider"]) {
    assert.equal(response.headers.get(leaked), null, `上游响应头 ${leaked} 不得透传`);
  }
});

test("redirects are followed only within the same allowed origin and capped", async () => {
  const crossOrigin = stubFetch([
    new Response(null, { status: 302, headers: { location: "https://evil.example.test/steal" } }),
    new Response("evil", { status: 200 }),
  ]);
  const blocked = await media.servePrivateMedia(fakeRequest(), REFERENCE_URL, { allowConfiguredReference: true });
  assert.equal(blocked.status, 404);
  assert.equal(crossOrigin.length, 1, "跨域重定向后不得继续请求");

  const downgrade = stubFetch([
    new Response(null, { status: 302, headers: { location: "http://ref.example.test/speaker.wav" } }),
  ]);
  const downgraded = await media.servePrivateMedia(fakeRequest(), REFERENCE_URL, { allowConfiguredReference: true });
  assert.equal(downgraded.status, 404);
  assert.equal(downgrade.length, 1, "降级到 http 的重定向必须拒绝");

  const sameOrigin = stubFetch([
    new Response(null, { status: 302, headers: { location: "/cdn/speaker.wav" } }),
    new Response("wav-bytes", { status: 200, headers: { "content-type": "audio/wav" } }),
  ]);
  const followed = await media.servePrivateMedia(fakeRequest(), REFERENCE_URL, { allowConfiguredReference: true });
  assert.equal(followed.status, 200);
  assert.equal(await followed.text(), "wav-bytes");
  assert.deepEqual(
    sameOrigin.map((call) => call.url),
    [REFERENCE_URL, "https://ref.example.test/cdn/speaker.wav"]
  );

  const loop = stubFetch([
    () => new Response(null, { status: 302, headers: { location: "/loop" } }),
  ]);
  const looped = await media.servePrivateMedia(fakeRequest(), REFERENCE_URL, { allowConfiguredReference: true });
  assert.equal(looped.status, 404);
  assert.ok(loop.length <= 5, `重定向必须有上限，实际请求了 ${loop.length} 次`);
});

test("oversized or failing upstream responses are not proxied", async () => {
  stubFetch([
    new Response("x", {
      status: 200,
      headers: { "content-length": String(media.MAX_REMOTE_MEDIA_BYTES + 1) },
    }),
  ]);
  const tooLarge = await media.servePrivateMedia(fakeRequest(), REFERENCE_URL, { allowConfiguredReference: true });
  assert.equal(tooLarge.status, 413);

  stubFetch([new Response("upstream error", { status: 500 })]);
  const failing = await media.servePrivateMedia(fakeRequest(), REFERENCE_URL, { allowConfiguredReference: true });
  assert.equal(failing.status, 404);

  stubFetch([new Response("forbidden", { status: 403 })]);
  const forbidden = await media.servePrivateMedia(fakeRequest(), REFERENCE_URL, { allowConfiguredReference: true });
  assert.equal(forbidden.status, 404);
});

test("isTrustedStoredMediaSource mirrors the serving rules", async () => {
  assert.equal(await media.isTrustedStoredMediaSource(PRIVATE_VIDEO), true);
  assert.equal(await media.isTrustedStoredMediaSource("/uploads/legacy.mp4"), true);
  assert.equal(await media.isTrustedStoredMediaSource(SECRET), false);
  assert.equal(await media.isTrustedStoredMediaSource("/uploads/../.env"), false);
  assert.equal(await media.isTrustedStoredMediaSource("https://169.254.169.254/"), false);
  assert.equal(await media.isTrustedStoredMediaSource(REFERENCE_URL), false);
  assert.equal(await media.isTrustedStoredMediaSource(REFERENCE_URL, true), true);
  assert.equal(await media.isTrustedStoredMediaSource(undefined), false);
  assert.equal(await media.isTrustedStoredMediaSource(""), false);
});

test("downloadTrustedMediaToFile copies only allowed local files and enforces the byte cap on remote bodies", async () => {
  const output = path.join(tmpRoot, ".runtime/provider-input/task_1/source-video.mp4");
  const bytes = await media.downloadTrustedMediaToFile({ source: PRIVATE_VIDEO, outputPath: output });
  assert.equal(bytes, "private-video-bytes".length);
  assert.equal(fs.readFileSync(output, "utf8"), "private-video-bytes");

  await assert.rejects(
    media.downloadTrustedMediaToFile({ source: SECRET, outputPath: path.join(tmpRoot, ".runtime/x/secret.copy") }),
    /Media download failed|not allowed/
  );
  assert.equal(fs.existsSync(path.join(tmpRoot, ".runtime/x/secret.copy")), false);

  const calls = stubFetch([]);
  await assert.rejects(
    media.downloadTrustedMediaToFile({
      source: "https://169.254.169.254/latest/meta-data/",
      outputPath: path.join(tmpRoot, ".runtime/x/ssrf.bin"),
    }),
    /Media download failed/
  );
  assert.equal(calls.length, 0);

  stubFetch([new Response("0123456789", { status: 200 })]);
  const capped = path.join(tmpRoot, ".runtime/x/capped.wav");
  await assert.rejects(
    media.downloadTrustedMediaToFile({
      source: REFERENCE_URL,
      outputPath: capped,
      allowConfiguredReference: true,
      maxBytes: 4,
    }),
    /size limit/
  );
  assert.equal(fs.existsSync(capped), false, "超限下载必须清理残留文件");

  stubFetch([new Response("0123", { status: 200 })]);
  const okPath = path.join(tmpRoot, ".runtime/x/ok.wav");
  const okBytes = await media.downloadTrustedMediaToFile({
    source: REFERENCE_URL,
    outputPath: okPath,
    allowConfiguredReference: true,
    maxBytes: 4,
  });
  assert.equal(okBytes, 4);
  assert.equal(fs.readFileSync(okPath, "utf8"), "0123");

  await assert.rejects(
    media.downloadTrustedMediaToFile({
      source: PRIVATE_VIDEO,
      outputPath: path.join(tmpRoot, ".runtime/x/too-big.mp4"),
      maxBytes: 3,
    }),
    /size limit/
  );
});


test("remote preview propagates an upstream timeout without an uncaught server exception", {timeout:2000}, async () => {
  let upstream;
  stubFetch([new Response(new ReadableStream({start(controller) {upstream = controller;}}))]);
  const response = await media.servePrivateMedia(fakeRequest(), REFERENCE_URL, {allowConfiguredReference:true});
  const reading = response.arrayBuffer();
  const rejected = assert.rejects(reading, /preview timeout/);
  upstream.error(new DOMException("preview timeout", "TimeoutError"));
  await rejected;
});

test("cancelling a video preview also cancels its upstream body", async () => {
  let cancelled = false;
  stubFetch([new Response(new ReadableStream({cancel() {cancelled = true;}}))]);
  const response = await media.servePrivateMedia(fakeRequest(), REFERENCE_URL, {allowConfiguredReference:true});
  await response.body.cancel();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, true);
});


test("preview still enforces the byte limit when upstream omits Content-Length", async () => {
  let cancelled = false;
  const chunk = new Uint8Array(1024 * 1024);
  stubFetch([new Response(new ReadableStream({
    pull(controller) {controller.enqueue(chunk);},
    cancel() {cancelled = true;},
  }))]);
  const response = await media.servePrivateMedia(fakeRequest(), REFERENCE_URL, {allowConfiguredReference:true});
  const reader = response.body.getReader();
  let bytes = 0;
  await assert.rejects(async () => {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
    }
  }, /size limit/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bytes, media.MAX_REMOTE_MEDIA_BYTES);
  assert.equal(cancelled, true);
});
