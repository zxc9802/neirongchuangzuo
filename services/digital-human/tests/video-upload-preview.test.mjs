import assert from "node:assert/strict";
import test from "node:test";

test("video preparation waits for asynchronous thumbnail encoding and keeps actual metadata", async () => {
  const { inspectVideoFile } = await import("../src/lib/client-video-preview.ts");
  const oldDocument = globalThis.document;
  const revoked = [];
  const oldRevoke = URL.revokeObjectURL;
  let encode;
  let canvas;
  const thumbnail = new Blob(["jpeg"], { type: "image/jpeg" });
  const video = { videoWidth: 1080, videoHeight: 1920, duration: 86, currentTime: 0,
    load() {}, removeAttribute() {}, pause() {},
    set src(value) { queueMicrotask(() => this.onloadeddata?.()); },
  };
  Object.defineProperty(video, "currentTime", { get: () => 0, set() { queueMicrotask(() => video.onseeked?.()); } });
  globalThis.document = { createElement: type => type === "video" ? video : (canvas = {
    getContext: () => ({ drawImage() {} }), toBlob: callback => { encode = callback; },
  }) };
  URL.revokeObjectURL = url => revoked.push(url);
  try {
    let resolved = false;
    const pending = inspectVideoFile(new Blob(["video"], { type: "video/mp4" })).then(result => { resolved = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(resolved, false, "Thumbnail may finish after metadata and fast uploads");
    encode(thumbnail);
    const result = await pending;
    assert.equal(result.thumbnail, thumbnail);
    assert.equal(result.durationSeconds, 86);
    assert.equal(result.width, 1080);
    assert.equal(result.height, 1920);
    assert.equal(canvas.width, 360, "Thumbnail is resized without changing the video metadata");
    assert.equal(canvas.height, 640);
    assert.equal(revoked.length, 1);
  } finally { globalThis.document = oldDocument; URL.revokeObjectURL = oldRevoke; }
});

test("automatic cover recovery deduplicates cards and serializes extraction requests", async () => {
  const { ensureAvatarCover } = await import("../src/lib/client-video-preview.ts");
  const oldFetch = globalThis.fetch;
  const calls = [];
  const completions = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.onlyIfMissing, true);
    calls.push(body.id);
    await new Promise(resolve => completions.push(resolve));
    return Response.json({ success: true, coverUrl: `/covers/${body.id}.jpg` });
  };
  try {
    const first = ensureAvatarCover("one");
    const duplicate = ensureAvatarCover("one");
    const second = ensureAvatarCover("two");
    assert.equal(first, duplicate);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ["one"]);
    completions.shift()();
    assert.equal(await first, "/covers/one.jpg");
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ["one", "two"]);
    completions.shift()();
    assert.equal(await second, "/covers/two.jpg");
  } finally { globalThis.fetch = oldFetch; }
});


test("unsupported local video decoding settles and server cover recovery can succeed or fail safely", async () => {
  const { inspectVideoFile, recoverAvatarCover } = await import("../src/lib/client-video-preview.ts");
  const oldDocument = globalThis.document;
  const oldFetch = globalThis.fetch;
  const video = { load() {}, removeAttribute() {}, duration: NaN,
    set src(value) { queueMicrotask(() => this.onerror?.()); },
  };
  globalThis.document = {createElement: () => video};
  try {
    const result = await inspectVideoFile(new Blob(["unsupported"], {type:"video/quicktime"}));
    assert.equal(result.thumbnail, null);
    assert.equal(result.durationSeconds, 0);
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "/api/avatars/extract-cover");
      assert.deepEqual(JSON.parse(init.body), {id:"avatar-test", timestamp:1});
      return Response.json({success:true, coverUrl:"/api/avatars/avatar-test/media?kind=cover"});
    };
    assert.equal(await recoverAvatarCover("avatar-test"), "/api/avatars/avatar-test/media?kind=cover");
    globalThis.fetch = async () => Response.json({error:"unavailable"}, {status:503});
    assert.equal(await recoverAvatarCover("avatar-test"), null);
    globalThis.fetch = async () => { throw new Error("offline"); };
    assert.equal(await recoverAvatarCover("avatar-test"), null);
  } finally { globalThis.document = oldDocument; globalThis.fetch = oldFetch; }
});
