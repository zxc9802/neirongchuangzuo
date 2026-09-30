import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";

const cwd = process.cwd();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "avatar-cover-performance-"));
process.chdir(temporary);
process.env.NODE_ENV = "development";
process.env.DISABLE_SSO = "true";
delete process.env.AUTH_MODE;
delete process.env.COS_SECRET_ID;
delete process.env.COS_SECRET_KEY;

const { AvatarStore } = await import("../src/lib/store/avatar-store.ts");
const { localUploadPath, ownerKeyFor } = await import("../src/lib/server/upload-policy.ts");
const { GET } = await import("../src/app/api/avatars/[id]/media/route.ts");
const coverPath = localUploadPath(`uploads/users/${ownerKeyFor(null)}/thumbnails/cover.jpg`);
fs.mkdirSync(path.dirname(coverPath), { recursive: true });
fs.writeFileSync(coverPath, Buffer.alloc(120_000, 1));
const avatar = AvatarStore.create({
  name: "performance fixture", coverUrl: coverPath, videoUrl: "", durationSeconds: 113,
  width: 720, height: 1280, fileSize: 81_010_000,
});
const requestCover = (headers = {}) => GET(
  new NextRequest(`http://localhost/api/avatars/${avatar.id}/media?kind=cover`, { headers }),
  { params: Promise.resolve({ id: avatar.id }) },
);

test.after(() => {
  process.chdir(cwd);
  fs.rmSync(temporary, { recursive: true, force: true });
});

test("reopening an unchanged cover transfers no image bytes after authorization", async () => {
  const first = await requestCover();
  assert.equal(first.status, 200);
  const bytes = (await first.arrayBuffer()).byteLength;
  const second = await requestCover({ "If-None-Match": first.headers.get("etag") || '"missing"' });
  const repeatedBytes = (await second.arrayBuffer()).byteLength;
  console.log(JSON.stringify({ firstBytes: bytes, repeatedBytes, repeatedStatus: second.status }));
  assert.equal(second.status, 304, "Reopening should reuse the downloaded cover, not transfer it again");
  assert.equal(repeatedBytes, 0);
  assert.match(first.headers.get("cache-control"), /private/);
  assert.doesNotMatch(first.headers.get("cache-control"), /no-store/);
});

test("replacing a cover invalidates its validator and returns the new image", async () => {
  const first = await requestCover();
  await first.arrayBuffer();
  const replacement = coverPath.replace("cover.jpg", "replacement.jpg");
  fs.writeFileSync(replacement, "replacement cover");
  AvatarStore.update(avatar.id, { coverUrl: replacement });
  try {
    const updated = await requestCover({ "If-None-Match": first.headers.get("etag") || '"missing"' });
    assert.equal(updated.status, 200);
    assert.equal(await updated.text(), "replacement cover");
    assert.notEqual(updated.headers.get("etag"), first.headers.get("etag"));
  } finally { AvatarStore.update(avatar.id, { coverUrl: coverPath }); }
});

test("a cached cover cannot bypass a missing login", async () => {
  const first = await requestCover();
  await first.arrayBuffer();
  process.env.NODE_ENV = "production";
  try {
    const response = await requestCover({ "If-None-Match": first.headers.get("etag") || '"missing"' });
    assert.equal(response.status, 401);
  } finally { process.env.NODE_ENV = "development"; }
});

test("automatic repair keeps an existing cover without decoding the video again", async () => {
  const { POST } = await import("../src/app/api/avatars/extract-cover/route.ts");
  const response = await POST(new NextRequest("http://localhost/api/avatars/extract-cover", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: avatar.id, onlyIfMissing: true }),
  }));
  assert.equal(response.status, 200, "The existing cover can be reused even without a source video");
  assert.match((await response.json()).coverUrl, /kind=cover&v=/);
  assert.equal(AvatarStore.get(avatar.id).coverUrl, coverPath);
});

test("an unchanged cloud cover skips the object-storage download on subsequent visits", async t => {
  const { CosService } = await import("../src/lib/cos.ts");
  const key = `uploads/users/${ownerKeyFor(null)}/thumbnails/cloud-cover.jpg`;
  const source = `https://fixture.example/${key}`;
  t.mock.method(CosService, "getManagedObjectKey", value => value === source ? key : null);
  t.mock.method(CosService, "getDownloadUrl", async () => source);
  let downloads = 0;
  t.mock.method(globalThis, "fetch", async () => {
    downloads++;
    return new Response("cloud cover", { headers: { "Content-Type": "image/jpeg" } });
  });
  AvatarStore.update(avatar.id, { coverUrl: source });
  try {
    const first = await requestCover();
    assert.equal(await first.text(), "cloud cover");
    const repeated = await requestCover({ "If-None-Match": `W/${first.headers.get("etag")}` });
    assert.equal(repeated.status, 304);
    assert.equal((await repeated.arrayBuffer()).byteLength, 0);
    assert.equal(downloads, 1);
  } finally { AvatarStore.update(avatar.id, { coverUrl: coverPath }); }
});
