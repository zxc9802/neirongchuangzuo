import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const source = fs.readFileSync(new URL("../src/lib/cos.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
} }).outputText;

function startApp(origin, state) {
  class COS {
    putBucketAcl(params, callback) {
      state.aclCalls.push(params);
      callback(state.failAcl ? new Error("AccessDenied") : null, {});
    }
    putBucketCors(params, callback) {
      state.corsCalls.push(params);
      state.rules = structuredClone(params.CORSRules);
      callback(null, {});
    }
    async multipartInit() { state.uploads++; return { UploadId: "test-upload" }; }
    getObjectUrl(_params, callback) { callback(null, { Url: "https://bucket.example.test/part" }); }
  }
  const deps = {
    fs, path, "cos-nodejs-sdk-v5": COS,
    "./server/safe-log": { logServerError() {} },
    "./config": { getAppConfig: () => ({
      cosSecretId: "test-id", cosSecretKey: "test-secret", cosBucket: "shared-1250000000",
      cosRegion: "ap-singapore", publicBaseUrl: origin,
    }) },
  };
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled)(name => {
    assert.ok(name in deps, `Unexpected dependency: ${name}`); return deps[name];
  }, module, module.exports);
  return module.exports.CosService;
}

const uploadKey = "uploads/users/alice/videos/test.mp4";
const existingRules = [{
  AllowedOrigin: ["https://shuziren.qycm.top", "https://nrcz.qycm.top"],
  AllowedMethod: ["GET", "PUT", "HEAD"], AllowedHeader: ["content-type", "content-length"],
  ExposeHeader: ["etag"], MaxAgeSeconds: 600,
}, {
  AllowedOrigin: ["https://legacy.example.test"], AllowedMethod: ["GET"], MaxAgeSeconds: 300,
}];

test("uploads after both shared-bucket apps restart preserve the configured CORS rules", async () => {
  const state = { rules: structuredClone(existingRules), aclCalls: [], corsCalls: [], uploads: 0 };
  for (const origin of ["https://shuziren.qycm.top", "https://nrcz.qycm.top"]) {
    const app = startApp(origin, state);
    await app.createDirectUpload(uploadKey, 100, "video/mp4");
    await app.createDirectUpload(uploadKey, 100, "video/mp4");
  }
  assert.deepEqual(state.rules, existingRules, "one application's startup must not remove another application's origin");
  assert.equal(state.corsCalls.length, 0, "upload initialization must not rewrite bucket CORS");
  assert.equal(state.aclCalls.length, 2, "each process still initializes private bucket access once");
  assert.ok(state.aclCalls.every(call => call.ACL === "private"));
  assert.equal(state.uploads, 4);
});

test("failed private-bucket initialization blocks upload and can be retried without changing CORS", async () => {
  const state = { rules: structuredClone(existingRules), aclCalls: [], corsCalls: [], uploads: 0, failAcl: true };
  const app = startApp("https://shuziren.qycm.top", state);
  await assert.rejects(app.createDirectUpload(uploadKey, 100, "video/mp4"), /AccessDenied/);
  assert.equal(state.uploads, 0);
  state.failAcl = false;
  await app.createDirectUpload(uploadKey, 100, "video/mp4");
  assert.equal(state.aclCalls.length, 2);
  assert.equal(state.uploads, 1);
  assert.deepEqual(state.rules, existingRules);
  assert.equal(state.corsCalls.length, 0);
});
