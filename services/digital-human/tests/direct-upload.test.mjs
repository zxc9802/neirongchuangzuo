import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import COS from "cos-nodejs-sdk-v5";
import { NextRequest } from "next/server";

const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "direct-upload-test-"));
process.chdir(tmp);
Object.assign(process.env, {
  COS_SECRET_ID: "test-id", COS_SECRET_KEY: "test-secret", COS_BUCKET: "test-1250000000",
  COS_REGION: "ap-guangzhou", PUBLIC_BASE_URL: "https://app.example.test",
  MAIN_APP_SSO_CLIENT_SECRET: "test-sso", APP_SESSION_SECRET: "test-session",
});
delete process.env.DISABLE_SSO;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, init) => {
  const id = new Headers(init?.headers).get("Authorization")?.replace("Bearer ", "");
  return Response.json({ success: true, data: { user: { id, account: id, nickname: id, role: "member" } } });
};
const sso = await import("../src/lib/main-app-sso.ts");
const sessions = new Map();
const uploads = new Map();
let sequence = 0;
const signed = [];
mock.method(COS.prototype, "putBucketAcl", (_p, cb) => cb(null, {}));
mock.method(COS.prototype, "putBucketCors", (_p, cb) => cb(null, {}));
mock.method(COS.prototype, "multipartInit", async p => {
  const UploadId = `upload-${++sequence}`;
  uploads.set(p.Key, { id: UploadId, parts: [], complete: false });
  return { UploadId };
});
mock.method(COS.prototype, "multipartListPart", async p => {
  const upload = uploads.get(p.Key);
  if (!upload || upload.id !== p.UploadId || upload.complete) throw new Error("NoSuchUpload");
  return { Part: upload.parts, IsTruncated: "false" };
});
mock.method(COS.prototype, "multipartComplete", async p => {
  const upload = uploads.get(p.Key);
  if (!upload || upload.complete) throw new Error("NoSuchUpload");
  upload.completedParts = p.Parts;
  upload.complete = true;
  return {};
});
mock.method(COS.prototype, "multipartAbort", async p => {
  const upload = uploads.get(p.Key);
  if (upload && !upload.complete) uploads.delete(p.Key);
});
mock.method(COS.prototype, "headObject", (p, cb) => {
  const upload = uploads.get(p.Key);
  if (!upload?.complete) return cb(new Error("NoSuchKey"));
  cb(null, { headers: { "content-length": String(upload.parts.reduce((sum, part) => sum + part.Size, 0)) } });
});
mock.method(COS.prototype, "putObject", (_p, cb) => cb(null, {}));
mock.method(COS.prototype, "deleteObject", (p, cb) => { uploads.delete(p.Key); cb(null, {}); });
const realGetUrl = COS.prototype.getObjectUrl;
mock.method(COS.prototype, "getObjectUrl", function(p, cb) {
  if (p.Method === "PUT") signed.push(p);
  return realGetUrl.call(this, p, cb);
});

async function request(body, user = "alice", route = "/api/upload/direct") {
  if (user && !sessions.has(user)) sessions.set(user, await sso.createMainAppSessionCookie({
    token: user, user: { id: user, account: user, nickname: user, role: "member" },
    expiresAt: Date.now() + 60_000, validatedAt: Date.now(),
  }));
  return new NextRequest(`https://app.example.test${route}`, {
    method: "POST", headers: { "Content-Type": "application/json",
      ...(user ? { Cookie: `${sso.getMainAppSessionCookieName()}=${sessions.get(user)}` } : {}) },
    body: JSON.stringify(body),
  });
}

test.after(() => {
  mock.restoreAll(); globalThis.fetch = originalFetch;
  process.chdir(cwd); fs.rmSync(tmp, { recursive: true, force: true });
});

test("165 MB video gets account-scoped direct part grants with bounded sizes", async () => {
  const { POST } = await import("../src/app/api/upload/direct/route.ts");
  const response = await POST(await request({ folder: "videos", fileName: "黄总.mp4",
    fileSize: 165 * 1024 * 1024, contentType: "video/mp4" }));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.direct, true);
  assert.equal(data.parts.length, 21);
  assert.match(data.uploadKey, /^uploads\/users\/u_[a-f0-9]{32}\/videos\/[a-f0-9-]+\.mp4$/);
  assert.equal(data.parts.reduce((sum, part) => sum + part.size, 0), 173015040);
  for (const [index, part] of data.parts.entries()) {
    const url = new URL(part.url);
    assert.equal(url.hostname, "test-1250000000.cos.ap-guangzhou.myqcloud.com");
    assert.equal(url.protocol, "https:");
    assert.equal(url.searchParams.get("partNumber"), String(index + 1));
    assert.equal(url.searchParams.get("uploadId"), uploads.get(data.uploadKey).id);
    assert.match(url.searchParams.get("q-header-list"), /content-length/);
    assert.match(url.searchParams.get("q-url-param-list"), /partnumber/);
    assert.match(url.searchParams.get("q-url-param-list"), /uploadid/);
    assert.equal(signed[index].Headers["Content-Length"], String(part.size));
  }
  assert.equal(JSON.stringify(data).includes("test-secret"), false);
  assert.equal(fs.existsSync(path.join(tmp, ".runtime", "uploads")), false);
});

test("direct upload requires all verified parts, then supports confirmation retry and avatar registration", async () => {
  const { POST: prepare } = await import("../src/app/api/upload/direct/route.ts");
  const { POST: complete } = await import("../src/app/api/upload/complete/route.ts");
  const { POST: createAvatar } = await import("../src/app/api/avatars/route.ts");
  const descriptor = { folder: "videos", fileName: "黄总.mp4", fileSize: 10 * 1024 * 1024, contentType: "video/mp4" };
  const grant = await (await prepare(await request(descriptor))).json();
  const finish = (user = "alice") => request({ uploadKey: grant.uploadKey }, user, "/api/upload/complete");
  assert.equal((await complete(await finish(null))).status, 401);
  assert.equal((await complete(await finish("bob"))).status, 404);
  assert.equal((await complete(await finish())).status, 409);
  const upload = uploads.get(grant.uploadKey);
  upload.parts = [{ PartNumber: "1", Size: 8 * 1024 * 1024, ETag: '"part-one"' }];
  assert.equal((await complete(await finish())).status, 409);
  upload.parts.push({ PartNumber: "2", Size: 1, ETag: '"part-two"' });
  assert.equal((await complete(await finish())).status, 409);
  upload.parts[1].Size = 2 * 1024 * 1024;
  upload.parts.reverse(); // Concurrent transfers can finish in a different order.
  const done = await complete(await finish());
  assert.equal(done.status, 200);
  assert.deepEqual(upload.completedParts.map(part => part.PartNumber), ["1", "2"]);
  assert.equal((await done.json()).storedRemotely, true);
  assert.equal((await complete(await finish())).status, 200);
  const response = await createAvatar(await request({ name: "新形象", uploadKey: grant.uploadKey,
    width: 1080, height: 1920, durationSeconds: 86 }, "alice", "/api/avatars"));
  assert.equal(response.status, 200);
  const { avatar } = await response.json();
  assert.match(avatar.videoUrl, /^\/api\/avatars\/.+\/media\?kind=video$/);
  assert.equal(avatar.fileSize, descriptor.fileSize);
  assert.equal(avatar.storedRemotely, true);
  assert.equal((await complete(await finish())).status, 404, "Consumed grants cannot be reused");
  assert.equal(upload.complete, true, "A replay must not delete registered media");
});

test("direct upload rejects invalid descriptors and exhausted budgets before issuing storage grants", async () => {
  const { POST } = await import("../src/app/api/upload/direct/route.ts");
  const descriptor = { folder: "videos", fileName: "video.mp4", fileSize: 1024, contentType: "video/mp4" };
  const before = sequence;
  assert.equal((await POST(await request(descriptor, null))).status, 401);
  for (const change of [{fileSize: 501 * 1024 * 1024}, {fileSize: 0}, {fileSize: 1.5},
    {fileSize: "1024"}, {folder: "../jobs"}, {fileName: "config.json"}, {contentType: "text/html"}]) {
    assert.equal((await POST(await request({...descriptor, ...change}))).status, 400);
  }
  assert.equal(sequence, before);
  for (let i = 0; i < 4; i++) {
    assert.equal((await POST(await request({...descriptor, fileSize: 500 * 1024 * 1024}, "quota-user"))).status, 200);
  }
  assert.equal((await POST(await request({...descriptor, fileSize: 100 * 1024 * 1024}, "quota-user"))).status, 429);
});

test("expired multipart uploads are aborted and cannot be finalized", async () => {
  const { POST: prepare } = await import("../src/app/api/upload/direct/route.ts");
  const { POST: complete } = await import("../src/app/api/upload/complete/route.ts");
  const { cleanupExpiredPendingUploads } = await import("../src/lib/server/upload-policy.ts");
  const grant = await (await prepare(await request({folder:"voices", fileName:"voice.wav", fileSize:2048, contentType:"audio/wav"}, "expire-user"))).json();
  assert.ok(uploads.has(grant.uploadKey));
  await cleanupExpiredPendingUploads(Date.now() + 60 * 60 * 1000 + 1);
  assert.equal(uploads.has(grant.uploadKey), false);
  const response = await complete(await request({uploadKey:grant.uploadKey}, "expire-user", "/api/upload/complete"));
  assert.equal(response.status, 404);
});
