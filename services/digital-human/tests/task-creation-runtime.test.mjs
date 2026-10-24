import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { NextRequest, NextResponse } from "next/server.js";
import * as access from "../src/lib/access-control.ts";
import * as sso from "../src/lib/main-app-sso.ts";
import * as billing from "../src/lib/main-app-billing.ts";
import * as estimate from "../src/lib/billing-estimate.ts";
import * as publicData from "../src/lib/server/public-data.ts";
import * as publicContract from "../src/lib/public-contract.ts";
import * as limit from "../src/lib/server/generation-limit.ts";
import * as safeLog from "../src/lib/server/safe-log.ts";

test("task POST enforces credits and concurrency, sanitizes errors, and keeps internal users free", async () => {
  const savedFetch = globalThis.fetch;
  const keys = ["NODE_ENV", "APP_SESSION_SECRET", "MAIN_APP_SSO_CLIENT_SECRET", "DISABLE_SSO", "GENERATION_LIMIT_PATH"];
  const savedEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "task-create-test-"));
  const finishes = [];
  const finish = () => { for (const resolve of finishes.splice(0)) resolve(); };
  try {
    process.env.NODE_ENV = "production";
    process.env.APP_SESSION_SECRET = "test-session-secret";
    process.env.MAIN_APP_SSO_CLIENT_SECRET = "test-client-secret";
    process.env.GENERATION_LIMIT_PATH = path.join(tmp, "limits.json");
    delete process.env.DISABLE_SSO;
    let user = {id: "external", account: "external", nickname: "用户", role: "member", billingAudience: "external"};
    let mode = "insufficient";
    const requests = [];
    const tasks = [];
    const pipelines = [];
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith("/api/sso/session")) return Response.json({success: true, data: {user}});
      assert.ok(String(url).endsWith("/api/sso/billing"), "no real network");
      const body = JSON.parse(init.body); requests.push(body);
      if (mode === "insufficient") return Response.json({success: false, code: "INSUFFICIENT_CREDITS"}, {status: 402});
      if (mode === "unsafe") return Response.json({success: false, error: "NewVendor api_key=FAKE_SECRET", code: "FAKE_SECRET"}, {status: 500});
      return Response.json({success: true, data: {requestId: body.requestId, reservedCredits: body.points, chargeRequired: true}});
    };
    const deps = {
      "next/server": {NextRequest, NextResponse},
      "@/lib/server/safe-log": safeLog,
      "@/lib/store/task-store": {TaskStore: {create: data => {
        const task = {...data, id: `task-${tasks.length}`, logs: [], createdAt: Date.now()}; tasks.push(task); return task;
      }}},
      "@/lib/engine/pipeline": {runDigitalHumanPipeline: id => {
        pipelines.push(id); return new Promise(resolve => {finishes.push(resolve);});
      }},
      "@/lib/store/avatar-store": {AvatarStore: {get: id => id === "avatar" ? ({id: "avatar", userId: user.id, videoPath: "fixture"}) : undefined}},
      "@/lib/store/voice-store": {VoiceStore: {
        getDefault: () => ({id: "voice", isDefault: true, audioPath: "fixture"}),
        get: id => id === "chosen-voice" ? {id, userId: user.id, audioPath: "chosen-audio"}
          : id === "foreign-voice" ? {id, userId: "someone-else", audioPath: "private-audio"} : undefined,
      }},
      "@/lib/server/public-data": publicData,
      "@/lib/public-contract": publicContract,
      "@/lib/main-app-billing": {...billing},
      "@/lib/billing-estimate": estimate,
      "@/lib/server/generation-limit": limit,
      "@/lib/access-control": {...access},
      "@/lib/server/upload-policy": {isOwnedUploadSource: () => true},
      "@/lib/server/media-response": {isTrustedStoredMediaSource: () => true},
      "@/lib/server/task-worker": {currentTaskWorker: () => ({pid: process.pid, host: os.hostname(), instance: "fixture", startedAt: Date.now()})},
      "@/lib/server/workspace-task-recovery": {reconcileWorkspaceTask: async task => task},
    };
    const code = ts.transpileModule(fs.readFileSync(new URL("../src/app/api/tasks/route.ts", import.meta.url), "utf8"), {
      compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
    }).outputText;
    const module = {exports: {}};
    new Function("require", "module", "exports", code)(name => {
      assert.ok(name in deps, name); return deps[name];
    }, module, module.exports);
    const post = async (body = {avatarId: "avatar", scriptText: "你好"}, authenticated = true) => {
      const cookie = await sso.createMainAppSessionCookie({token: "fake", user, expiresAt: Date.now() + 60000, validatedAt: Date.now()});
      return module.exports.POST(new NextRequest("https://app.example.test/api/tasks", {
        method: "POST", headers: {"Content-Type": "application/json", ...(authenticated ? {Cookie: `${sso.getMainAppSessionCookieName()}=${cookie}`} : {})},
        body: JSON.stringify(body),
      }));
    };
    assert.equal((await post(undefined, false)).status, 401);
    assert.equal((await post({avatarId: "avatar", scriptText: "x".repeat(5001)})).status, 400);
    for (const engine of ["a", "c", "veed-v2", "unknown", null]) {
      assert.equal((await post({avatarId: "avatar", scriptText: "你好", engine})).status, 400);
    }
    for (const toneProfile of ["invalid", "1.5", 1.5, null]) {
      assert.equal((await post({avatarId: "avatar", scriptText: "你好", toneProfile})).status, 400);
    }
    assert.equal(requests.length, 0);
    assert.equal((await post()).status, 402);
    assert.equal(pipelines.length, 0);
    mode = "ok";
    const successful = await post();
    assert.equal(successful.status, 200);
    assert.equal(tasks[0].billing.reservedPoints, 120, "3 second estimate reserves 6 seconds including margin");
    for (let i = 1; i < 4; i++) {
      assert.equal((await post({avatarId: "avatar", scriptText: `口播${i}`})).status, 200);
      assert.equal(tasks[i].inputs.scriptText, `口播${i}`);
    }
    assert.equal(new Set(tasks.map(task => task.billing.requestId)).size, 4, "parallel jobs reserve credits independently");
    const ledgerCount = requests.length;
    assert.equal((await post()).status, 429);
    assert.equal(requests.length, ledgerCount, "the fifth concurrent attempt must stop before reserving again");
    assert.equal(pipelines.length, 4);
    finish(); await new Promise(resolve => setImmediate(resolve));
    mode = "unsafe";
    const failure = await post();
    assert.equal(failure.status, 503);
    assert.doesNotMatch(JSON.stringify(await failure.json()), /NewVendor|FAKE_SECRET/);
    assert.equal(pipelines.length, 4);
    user = {...user, id: "admin", role: "admin", billingAudience: "internal"};
    const countBeforeAdmin = requests.length;
    assert.equal((await post()).status, 200);
    assert.equal(requests.length, countBeforeAdmin);
    assert.equal(tasks.at(-1).billing.isExternalUser, false);
    finish(); await new Promise(resolve => setImmediate(resolve));
    user = {...user, id: "audio-user", role: "member", billingAudience: "external"};
    mode = "ok";
    const beforeAudio = tasks.length;
    assert.equal((await post({scriptText: "你好", speakerVoiceId: "foreign-voice"})).status, 404);
    assert.equal((await post({scriptText: "你好", avatarId: "missing-avatar"})).status, 404);
    assert.equal((await post({scriptText: "你好", avatarId: {}})).status, 400);
    assert.equal((await post({scriptText: "  ", speakerVoiceId: "chosen-voice"})).status, 400);
    assert.equal(tasks.length, beforeAudio);
    for (const avatarId of [undefined, null, ""]) {
      const response = await post({avatarId, scriptText: "你好", speakerVoiceId: "chosen-voice"});
      assert.equal(response.status, 200);
      const task = tasks.at(-1);
      assert.equal(task.inputs.outputType, "audio");
      assert.equal(task.inputs.avatarId, undefined);
      assert.equal(task.inputs.videoPath, "");
      assert.equal(task.inputs.speakerAudioUrl, "chosen-audio");
      assert.equal(task.billing.status, "reserved");
      assert.equal((await response.json()).task.inputs.outputType, "audio");
      finish(); await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(tasks[0].inputs.outputType, "video");
    user = {...user, id: "model-admin", role: "admin", billingAudience: "internal"};
    for (const [toneProfile, seconds] of [["half", 27], ["slow", 19], ["gentle", 17], ["low", 15], ["high", 14], ["fast", 11]]) {
      const response = await post({avatarId: "avatar", scriptText: "一".repeat(44), toneProfile});
      assert.equal(response.status, 200);
      assert.equal(tasks.at(-1).billing.estimatedDuration, seconds);
      assert.equal(tasks.at(-1).inputs.toneProfile, toneProfile);
      assert.equal((await response.json()).task.inputs.toneProfile, toneProfile);
      finish(); await new Promise(resolve => setImmediate(resolve));
    }
    for (const [engine, provider] of [["b", "veed"], ["d", "latentsync"], ["e", "veed-v2"]]) {
      const response = await post({avatarId: "avatar", scriptText: "你好", engine});
      assert.equal(response.status, 200);
      assert.equal(tasks.at(-1).inputs.lipsyncProvider, provider);
      assert.equal((await response.json()).task.inputs.engine, engine);
      finish(); await new Promise(resolve => setImmediate(resolve));
    }
    user = {...user, id: "standalone-unlimited", role: "member", billingAudience: "standalone", callsUnlimited: true};
    deps["@/lib/access-control"].resolveAccessContext = async () => ({isolated: true, userId: user.id, isAdmin: false, session: {user}});
    deps["@/lib/main-app-billing"].reserveMainAppCredits = async () => ({requestId: crypto.randomUUID(), source: "internal", chargeRequired: false, reservedPoints: 0});
    fs.writeFileSync(process.env.GENERATION_LIMIT_PATH, JSON.stringify(Array.from({length: 30}, () => ({userId: user.id, at: Date.now()}))));
    for (let i = 0; i < 8; i++) {
      assert.equal((await post()).status, 200, "unlimited standalone account bypasses full hourly budgets");
      finish(); await new Promise(resolve => setImmediate(resolve));
    }
    user = {...user, callsUnlimited: false};
    assert.equal((await post()).status, 429, "revoking exemption restores hourly limits");
  } finally {
    finish?.(); globalThis.fetch = savedFetch;
    for (const key of keys) {
      if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
    }
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});
