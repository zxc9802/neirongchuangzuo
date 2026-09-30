import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

test("stream and cover work slots are bounded and reusable", async () => {
  const { acquireTaskStreamSlot } = await import("../src/lib/server/task-stream-limiter.ts");
  const { acquireCoverExtractionSlot } = await import("../src/lib/server/cover-extraction-limiter.ts");
  const releases = Array.from({ length: 6 }, () => acquireTaskStreamSlot("user", `task-${Math.random()}`));
  assert.ok(releases.every(Boolean));
  assert.equal(acquireTaskStreamSlot("user", "task-overflow"), null);
  releases[0]();
  assert.equal(typeof acquireTaskStreamSlot("user", "task-reused"), "function");

  const coverRelease = acquireCoverExtractionSlot("cover-user");
  assert.equal(typeof coverRelease, "function");
  assert.equal(acquireCoverExtractionSlot("cover-user"), null);
  coverRelease();
  assert.equal(typeof acquireCoverExtractionSlot("cover-user"), "function");
});

test("pending uploads persist, are owner-bound and can be claimed only once", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "upload-ledger-test-"));
  const previousPath = process.env.UPLOAD_PENDING_STATE_PATH;
  process.env.UPLOAD_PENDING_STATE_PATH = path.join(tempDir, "pending.json");
  try {
    const uploads = await import(`../src/lib/server/upload-policy.ts?test=${Date.now()}`);
    const key = `uploads/users/${uploads.ownerKeyFor("user-1")}/videos/test.mp4`;
    assert.equal(uploads.reservePendingUpload({ key, userId: "user-1", folder: "videos", bytes: 1234 }), true);
    assert.equal(uploads.markPendingUploadStored(key), true);
    assert.equal(uploads.claimPendingUpload({ key, userId: "other-user" }), false);
    assert.equal(uploads.claimPendingUpload({ key, userId: "user-1" }), true);
    assert.equal(uploads.claimPendingUpload({ key, userId: "user-1" }), false);
  } finally {
    if (previousPath === undefined) delete process.env.UPLOAD_PENDING_STATE_PATH;
    else process.env.UPLOAD_PENDING_STATE_PATH = previousPath;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("failed media cleanup can be durably queued and retried", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "deletion-ledger-test-"));
  const previousPath = process.env.UPLOAD_DELETION_STATE_PATH;
  process.env.UPLOAD_DELETION_STATE_PATH = path.join(tempDir, "pending-deletions.json");
  let localPath = "";
  try {
    const uploads = await import(`../src/lib/server/upload-policy.ts?deletion-test=${Date.now()}`);
    const key = `uploads/users/${uploads.ownerKeyFor("cleanup-user")}/thumbnails/${Date.now()}.jpg`;
    localPath = uploads.localUploadPath(key);
    await mkdir(path.dirname(localPath), { recursive: true });
    await writeFile(localPath, "thumbnail");

    uploads.queueOwnedUploadDeletion({
      source: localPath,
      userId: "cleanup-user",
      folder: "thumbnails",
    });
    const queued = JSON.parse(await readFile(process.env.UPLOAD_DELETION_STATE_PATH, "utf8"));
    assert.equal(queued.length, 1);
    assert.equal(await uploads.cleanupPendingOwnedUploadDeletions(), 1);
    await assert.rejects(access(localPath));
    assert.deepEqual(
      JSON.parse(await readFile(process.env.UPLOAD_DELETION_STATE_PATH, "utf8")),
      [],
    );
  } finally {
    if (previousPath === undefined) delete process.env.UPLOAD_DELETION_STATE_PATH;
    else process.env.UPLOAD_DELETION_STATE_PATH = previousPath;
    if (localPath) await rm(localPath, { force: true });
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("outbound URL policy rejects private addresses, credentials and control-plane origin changes", async () => {
  const policy = await import("../src/lib/server/outbound-url-policy.ts");
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "fc00::1", "::ffff:127.0.0.1"]) {
    assert.equal(policy.isPrivateOrReservedAddress(address), true, address);
  }
  assert.equal(policy.isPrivateOrReservedAddress("8.8.8.8"), false);
  await assert.rejects(
    policy.validateOutboundUrl("http://api.openlux.ai/output.mp4", policy.providerUrlPolicy("pixverse")),
    /HTTPS/,
  );
  await assert.rejects(
    policy.validateOutboundUrl("https://user:pass@api.openlux.ai/output.mp4", policy.providerUrlPolicy("pixverse")),
    /credential-free HTTPS/,
  );
  assert.throws(
    () => policy.assertSameOrigin("https://evil.example/result", "https://queue.fal.run/model"),
    /changed origin/,
  );
});

test("outbound HTTPS download supports Node lookup requests for all addresses", async () => {
  const dns = await import("node:dns");
  const https = await import("node:https");
  const policy = await import("../src/lib/server/outbound-url-policy.ts");
  const originalLookup = dns.default.promises.lookup;
  const originalRequest = https.default.request;
  dns.default.promises.lookup = async () => [{ address: "8.8.8.8", family: 4 }];
  try {
    https.default.request = (_url, options, callback) => {
      const request = new EventEmitter();
      request.write = () => true;
      request.end = () => {
        options.lookup("audio.302.ai", { all: true }, (error, addresses) => {
          if (error) {
            request.emit("error", error);
            return;
          }
          try {
            assert.deepEqual(addresses, [{ address: "8.8.8.8", family: 4 }]);
          } catch (lookupError) {
            request.emit("error", lookupError);
            return;
          }
          const response = new PassThrough();
          response.statusCode = 200;
          response.headers = { "content-length": "2" };
          callback(response);
          response.end("ok");
        });
      };
      return request;
    };

    const response = await policy.fetchWithOutboundUrlPolicy(
      "https://audio.302.ai/output.wav",
      {},
      policy.providerUrlPolicy("indextts"),
    );
    assert.equal(await response.text(), "ok");
  } finally {
    dns.default.promises.lookup = originalLookup;
    https.default.request = originalRequest;
  }
});

test("outbound URL redirects are revalidated and sensitive headers cannot cross origins", async () => {
  const dns = await import("node:dns");
  const https = await import("node:https");
  const policy = await import("../src/lib/server/outbound-url-policy.ts");
  const originalLookup = dns.default.promises.lookup;
  const originalRequest = https.default.request;
  dns.default.promises.lookup = async () => [{ address: "8.8.8.8", family: 4 }];
  try {
    let calls = 0;
    https.default.request = (_url, _options, callback) => {
      calls += 1;
      const response = new PassThrough();
      response.statusCode = 302;
      response.headers = { location: "https://127.0.0.1/private" };
      const request = new EventEmitter();
      request.write = () => true;
      request.end = () => process.nextTick(() => callback(response));
      return request;
    };
    await assert.rejects(
      policy.fetchWithOutboundUrlPolicy(
        "https://queue.fal.run/start",
        { headers: { Authorization: "Key secret" } },
        { name: "fal", allowedHosts: ["fal.run"], sensitiveHeaders: true },
      ),
      /not allow-listed|non-public/,
    );
    assert.equal(calls, 1, "private redirect must be rejected before a second fetch");

    https.default.request = (_url, _options, callback) => {
      const response = new PassThrough();
      response.statusCode = 302;
      response.headers = { location: "https://rest.fal.run/result" };
      const request = new EventEmitter();
      request.write = () => true;
      request.end = () => process.nextTick(() => callback(response));
      return request;
    };
    await assert.rejects(
      policy.fetchWithOutboundUrlPolicy(
        "https://queue.fal.run/start",
        { headers: { Authorization: "Key secret" } },
        { name: "fal", allowedHosts: ["fal.run"], sensitiveHeaders: true },
      ),
      /credential-bearing redirect changed origin/,
    );
  } finally {
    dns.default.promises.lookup = originalLookup;
    https.default.request = originalRequest;
  }
});

test("FFmpeg command wrapper kills timed-out child processes", async () => {
  const { execMediaCommand } = await import("../src/lib/engine/ffmpeg.ts");
  await assert.rejects(
    execMediaCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      timeoutMs: 40,
      maxOutputBytes: 1024,
    }),
    /timed out/,
  );
});
