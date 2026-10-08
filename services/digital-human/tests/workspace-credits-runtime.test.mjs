import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import ts from "typescript";
import { NextRequest, NextResponse } from "next/server.js";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dh-workspace-credits-"));
const saved = { AUTH_DATABASE_URL: process.env.AUTH_DATABASE_URL, NODE_ENV: process.env.NODE_ENV,
  WORKSPACE_DATA_DIR: process.env.WORKSPACE_DATA_DIR };
delete process.env.AUTH_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.WORKSPACE_DATA_DIR = temp;
const billing = await import("../src/lib/main-app-billing.ts");
const { getWorkspaceCreditsLedger } = await import("../src/lib/server/workspace-credits.ts");
const ledger = getWorkspaceCreditsLedger();
const workers = await import("../src/lib/server/task-worker.ts");
const publicData = await import("../src/lib/server/public-data.ts");
function loadSource(relative, deps) {
  const code = ts.transpileModule(fs.readFileSync(new URL(relative, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", code)(name => {
    assert.ok(name in deps, `unexpected dependency ${name}`); return deps[name];
  }, module, module.exports);
  return module.exports;
}
function mutableTaskStore(initial) {
  let task = initial;
  return { get: () => task, getAsync: async () => task, isDeleted: () => false,
    addLog: (_id, message) => task.logs.push({ message }),
    update: (_id, value) => task = { ...task, ...value, results: { ...task.results, ...value.results } } };
}
await ledger.ready;
test.after(async () => {
  await ledger.close();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(temp, { recursive: true, force: true });
});

test("standalone accounts, including admins, share 1000 credits and can complete three real 30 second results", async () => {
  const user = { id: "three-videos", role: "admin", billingAudience: "standalone" };
  assert.equal(billing.billingSource(user), "workspace");
  assert.equal(billing.calculateRequiredPoints(30, "workspace"), 333);
  assert.equal(billing.calculateRequiredPoints(60, "workspace"), 666);
  assert.equal(billing.calculateRequiredPoints(30.01, "workspace"), 334);
  assert.equal(billing.calculateRequiredPoints(30), 600, "external SSO fee is unchanged");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("standalone billing must not contact external SSO"); };
  try {
    for (let index = 0; index < 3; index++) {
      const reservation = await billing.reserveMainAppCredits({ user, taskId: `thirty-${index}`,
        estimatedDuration: 39, minimumDuration: 30 });
      assert.equal(reservation.source, "workspace");
      assert.equal(reservation.chargeRequired, true);
      if (index === 2) assert.equal(reservation.reservedPoints, 334, "only margin is capped at available credits");
      const reservedPoints = await billing.extendTaskCreditCoverage({ userId: user.id,
        billing: { ...reservation, status: "reserved", isExternalUser: true }, durationSeconds: 30 });
      assert.ok(reservedPoints >= 333);
      const settled = await billing.settleMainAppCredits({ userId: user.id,
        requestId: reservation.requestId, actualDuration: 30, source: "workspace", chargedPoints: 1 });
      assert.equal(settled.chargedPoints, 333, "client point hints cannot override actual duration pricing");
      const replay = await billing.settleMainAppCredits({ userId: user.id,
        requestId: reservation.requestId, actualDuration: 30, source: "workspace" });
      assert.equal(replay.chargedPoints, 333, "recovery settles the same reservation once");
    }
    assert.equal((await ledger.snapshot(user.id)).available, 1);
    assert.equal((await ledger.snapshot(user.id)).held, 0);
    await assert.rejects(billing.reserveMainAppCredits({ user, estimatedDuration: 6, minimumDuration: 3 }),
      error => error.status === 402 && error.code === "INSUFFICIENT_POINTS");
  } finally { globalThis.fetch = originalFetch; }
});

test("real audio coverage expands atomically and failures release the same reservation", async () => {
  const user = { id: "extension", role: "member", billingAudience: "standalone" };
  const reserved = await billing.reserveMainAppCredits({ user, taskId: "extend-audio", estimatedDuration: 6 });
  assert.equal(reserved.reservedPoints, 67);
  const points = await billing.extendTaskCreditCoverage({ userId: user.id,
    billing: { ...reserved, isExternalUser: true, status: "reserved" }, durationSeconds: 30 });
  assert.equal(points, 333);
  assert.equal((await ledger.snapshot(user.id)).available, 667);
  await billing.releaseMainAppCredits({ userId: user.id, requestId: reserved.requestId, source: "workspace" });
  await billing.releaseMainAppCredits({ userId: user.id, requestId: reserved.requestId, source: "workspace" });
  assert.equal((await ledger.snapshot(user.id)).available, 1000);
  assert.equal((await ledger.snapshot(user.id)).held, 0);
  await assert.rejects(billing.extendTaskCreditCoverage({ userId: user.id,
    billing: { ...reserved, isExternalUser: true, status: "reserved" }, durationSeconds: 60 }));
});

test("task creation failure refunds its reservation and the persisted task ID matches the wallet ID", async () => {
  const user = { id: "task-create-owner", account: "owner", role: "member", billingAudience: "standalone" };
  let failCreation = true;
  let submitted;
  let finish;
  const originalReserve = ledger.reserve;
  let calls = 0;
  let loseResponse = false;
  ledger.reserve = async input => {
    calls++;
    assert.equal(submitted.id, input.taskId, "task identity is persisted before wallet reservation");
    assert.equal(submitted.billing.status, "reserving");
    assert.equal(submitted.executionOwner.pid, process.pid);
    const result = await originalReserve(input);
    if (loseResponse) throw new Error("reserve committed but its response was lost");
    return result;
  };
  const deps = {
    "next/server": { NextRequest, NextResponse },
    "@/lib/server/safe-log": { logServerError: () => undefined },
    "@/lib/store/task-store": { TaskStore: { create: data => {
      if (failCreation) throw new Error("simulated disk failure");
      submitted = { ...data, createdAt: Date.now(), updatedAt: Date.now(), logs: [] }; return submitted;
    }, update: (_id, partial) => { submitted = { ...submitted, ...partial }; return submitted; } } },
    "@/lib/engine/pipeline": { runDigitalHumanPipeline: () => new Promise(resolve => { finish = resolve; }) },
    "@/lib/store/avatar-store": { AvatarStore: { get: () => undefined } },
    "@/lib/store/voice-store": { VoiceStore: { getDefault: () => ({ id: "default", isDefault: true, audioPath: "fixture" }) } },
    "@/lib/server/public-data": { toPublicTask: data => data, resolvePrivateEngine: () => "veed" },
    "@/lib/main-app-billing": billing,
    "@/lib/billing-estimate": await import("../src/lib/billing-estimate.ts"),
    "@/lib/server/generation-limit": { acquireGenerationSlot: () => () => undefined, GenerationLimitError: class extends Error {} },
    "@/lib/access-control": { resolveAccessContext: async () => ({ isolated: true, userId: user.id, session: { user } }),
      unauthorizedResponse: () => NextResponse.json({}, { status: 401 }), canViewAllMedia: () => false },
    "@/lib/server/upload-policy": { isOwnedUploadSource: () => true },
    "@/lib/server/media-response": { isTrustedStoredMediaSource: () => true },
    "@/lib/server/task-worker": workers,
    "@/lib/server/workspace-task-recovery": { reconcileWorkspaceTask: async task => task },
  };
  const code = ts.transpileModule(fs.readFileSync(new URL("../src/app/api/tasks/route.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", code)(name => {
    assert.ok(name in deps, `unexpected dependency ${name}`); return deps[name];
  }, module, module.exports);
  const post = () => module.exports.POST(new NextRequest("https://example.test/api/tasks", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scriptText: "你好" }),
  }));
  assert.equal((await post()).status, 500);
  assert.equal(calls, 0, "failed task persistence must stop before freezing any credits");
  assert.equal((await ledger.snapshot(user.id)).available, 1000);
  assert.equal((await ledger.snapshot(user.id)).held, 0);
  failCreation = false;
  try {
    assert.equal((await post()).status, 200);
    assert.equal(submitted.id, submitted.billing.requestId);
    assert.equal(submitted.billing.source, "workspace");
    assert.equal((await ledger.reservation(user.id, submitted.id)).status, "reserved");
    await billing.releaseMainAppCredits({ userId: user.id, requestId: submitted.id, source: "workspace" });
    finish?.();
    loseResponse = true;
    assert.equal((await post()).status, 503);
    assert.equal(submitted.status, "failed");
    assert.equal(submitted.billing.status, "released", "lost COMMIT response still refunds the persisted task identity");
    assert.equal((await ledger.snapshot(user.id)).held, 0);
    assert.equal((await ledger.snapshot(user.id)).available, 1000);
  } finally { finish?.(); ledger.reserve = originalReserve; }
});

test("restart recovery refunds only provably unsubmitted workspace work and protects active or committed tasks", async () => {
  const cwd = process.cwd(); process.chdir(temp);
  try {
    for (const scenario of ["pending", "tts", "media-prep", "reserving", "before-reserve", "active", "unknown-owner", "submitted", "settle-pending", "completed-during-check"]) {
      const userId = `restart-${scenario}`, taskId = `${userId}-task`;
      const reserved = scenario === "before-reserve" ? undefined : await billing.reserveMainAppCredits({
        user: { id: userId, billingAudience: "standalone" }, taskId, estimatedDuration: 6,
      });
      const owner = workers.currentTaskWorker();
      const task = { id: taskId, userId, status: scenario === "pending" ? "pending" : "processing",
        createdAt: Date.now(), updatedAt: Date.now(), step: scenario === "media-prep" ? "media_prep" : "tts", logs: [],
        executionOwner: scenario === "unknown-owner" ? undefined : { ...owner, instance: scenario === "active" ? owner.instance : "previous-process-instance" },
        billing: { source: "workspace", requestId: taskId, isExternalUser: true,
          status: ["reserving", "before-reserve"].includes(scenario) ? "reserving" : scenario === "submitted" ? "provider_committed" : scenario === "settle-pending" ? "settle_pending" : "reserved",
          reservedPoints: reserved?.reservedPoints || 0 }, inputs: { outputType: "video" }, results: {} };
      const TaskStore = mutableTaskStore(task);
      const { reconcileWorkspaceTask } = loadSource("../src/lib/server/workspace-task-recovery.ts", {
        "server-only": {}, "../store/task-store": { TaskStore }, "../main-app-billing": billing, "./task-worker": workers,
      });
      if (scenario === "completed-during-check") {
        await ledger.settle({ userId, taskId, units: 3 });
        TaskStore.update(taskId, { status: "completed", billing: { ...task.billing, status: "settled" }, results: { finalVideoUrl: "protected" } });
      }
      const result = await reconcileWorkspaceTask(task);
      const wallet = await ledger.snapshot(userId);
      if (["active", "unknown-owner"].includes(scenario)) {
        assert.equal(result.status, "processing"); assert.equal(wallet.held, 67);
        await ledger.release({ userId, taskId });
      } else if (["submitted", "settle-pending"].includes(scenario)) {
        assert.equal(result.status, "failed"); assert.equal(wallet.held, 67, "unknown paid submission cannot be refunded");
        assert.equal(result.errorCode, "TASK_RESTARTED_AFTER_SUBMISSION");
        await ledger.release({ userId, taskId });
      } else if (scenario === "completed-during-check") {
        assert.equal(result.status, "completed", "reread durable state must preserve a concurrent completion");
        assert.equal(wallet.held, 0); assert.equal(wallet.available, 966);
      } else {
        assert.equal(result.status, "failed"); assert.equal(result.billing.status, "released");
        assert.equal(wallet.available, 1000); assert.equal(wallet.held, 0);
        assert.equal(result.errorCode, "TASK_RESTARTED_BEFORE_SUBMISSION");
        assert.equal(publicData.toPublicTask(result).executionOwner, undefined);
      }
    }
  } finally { process.chdir(cwd); }
});

test("submission and stale refunds serialize and released reservations cannot reach a paid POST", async () => {
  const cwd = process.cwd(); process.chdir(temp);
  try {
    let running = 0, maximum = 0;
    await Promise.all(Array.from({ length: 8 }, () => workers.withTaskBillingGuard("serial-test", async () => {
      maximum = Math.max(maximum, ++running);
      await new Promise(resolve => setTimeout(resolve, 5)); --running;
    })));
    assert.equal(maximum, 1);
    for (const submitFirst of [false, true]) {
      const userId = `guard-${submitFirst}`, taskId = `${userId}-task`;
      await ledger.reserve({ userId, taskId, kind: "digital-human", units: 6 });
      const task = { id: taskId, userId, status: "processing", step: "media_prep", logs: [], inputs: {}, results: {},
        executionOwner: { ...workers.currentTaskWorker(), instance: "old-process" },
        billing: { source: "workspace", isExternalUser: true, requestId: taskId, status: "reserved" } };
      const TaskStore = mutableTaskStore(task);
      const { reconcileWorkspaceTask } = loadSource("../src/lib/server/workspace-task-recovery.ts", {
        "server-only": {}, "../store/task-store": { TaskStore }, "../main-app-billing": billing, "./task-worker": workers,
      });
      const submit = () => workers.withTaskBillingGuard(taskId, async () => {
        await billing.assertWorkspaceReservationActive(userId, taskId);
        TaskStore.update(taskId, { billing: { ...TaskStore.get().billing, status: "provider_committed" } });
      });
      if (submitFirst) {
        await submit(); await reconcileWorkspaceTask(task);
        assert.equal((await ledger.snapshot(userId)).held, 67);
        await ledger.release({ userId, taskId });
      } else {
        await reconcileWorkspaceTask(task);
        await assert.rejects(submit(), error => error.code === "BILLING_RESERVATION_CLOSED");
        assert.equal((await ledger.snapshot(userId)).held, 0);
      }
    }
  } finally { process.chdir(cwd); }
});

test("billing guard coordinates separate Node workers and detects a terminated execution owner", async () => {
  const cwd = process.cwd(); process.chdir(temp);
  try {
    const file = path.join(temp, "workers-order.jsonl");
    const workerUrl = new URL("../src/lib/server/task-worker.ts", import.meta.url).href;
    const code = `import fs from 'node:fs'; import {withTaskBillingGuard,currentTaskWorker} from ${JSON.stringify(workerUrl)};
      await withTaskBillingGuard('cross-process', async () => {
        fs.appendFileSync(${JSON.stringify(file)}, JSON.stringify({phase:'enter',pid:process.pid})+'\\n');
        await new Promise(resolve=>setTimeout(resolve,100));
        fs.appendFileSync(${JSON.stringify(file)}, JSON.stringify({phase:'exit',pid:process.pid})+'\\n');
      }); console.log(JSON.stringify(currentTaskWorker()));`;
    const child = () => new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, ["--import", new URL("./helpers/register.mjs", import.meta.url).href,
        "--input-type=module", "-e", code], { cwd: temp });
      let stdout = "", stderr = "";
      proc.stdout.on("data", value => stdout += value); proc.stderr.on("data", value => stderr += value);
      proc.on("error", reject); proc.on("close", status => status === 0 ? resolve(JSON.parse(stdout.trim())) : reject(new Error(stderr)));
    });
    const owners = await Promise.all([child(), child()]);
    const records = fs.readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(records.map(value => value.phase), ["enter", "exit", "enter", "exit"]);
    assert.equal(records[0].pid, records[1].pid); assert.equal(records[2].pid, records[3].pid);
    for (const owner of owners) assert.equal(workers.taskWorkerInterrupted("cross-process", owner), true);
    const hash = crypto.createHash("sha256").update("dead-worker-lock").digest("hex");
    fs.writeFileSync(path.join(temp, ".runtime", "state", "credit-workers", hash + ".lock"),
      JSON.stringify({ ...owners[0], token: "dead-owner", at: Date.now() }));
    await workers.withTaskBillingGuard("dead-worker-lock", () => undefined);
  } finally { process.chdir(cwd); }
});

test("workspace pipeline settles probed duration, refunds confirmed failures and keeps uncertain work frozen", async () => {
  const savedCwd = process.cwd();
  process.chdir(temp);
  const source = path.join(temp, "source.mp4");
  const speaker = path.join(temp, "speaker.wav");
  fs.writeFileSync(source, "fixture"); fs.writeFileSync(speaker, "fixture");
  const probe = { durationSeconds: 30, width: 160, height: 120, fps: 30, hasAudio: true };
  const compiled = ts.transpileModule(fs.readFileSync(new URL("../src/lib/engine/pipeline.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  try {
    for (const scenario of ["success", "confirmed-failure", "uncertain", "submit-uncertain", "settlement-pending"]) {
      const userId = `pipeline-${scenario}`;
      const reservation = await billing.reserveMainAppCredits({
        user: { id: userId, role: "member", billingAudience: "standalone" }, taskId: `video-${scenario}`, estimatedDuration: 6,
      });
      let task = { id: reservation.requestId, userId, status: "pending", logs: [],
        billing: { ...reservation, isExternalUser: true, status: "reserved" },
        inputs: { videoPath: source, outputType: "video", scriptText: "fixture", speakerAudioUrl: speaker,
          videoFit: "smart", lipsyncProvider: "veed" }, results: {} };
      const TaskStore = { get: () => task, isDeleted: () => false,
        addLog: (_id, message, level, publicMessage) => task.logs.push({ message, level, publicMessage }),
        update: (_id, value) => { task = { ...task, ...value, results: { ...task.results, ...value.results } }; return task; } };
      const deps = {
        path, fs, crypto, "../server/safe-log": { logServerError: () => undefined },
        "./task-execution": { withTaskExecution: async (_id, action) => action() },
        "../server/task-worker": workers,
        "../store/task-store": { TaskStore },
        "../config": { getAppConfig: () => ({ storageDir: path.join(temp, "jobs"), publicBaseUrl: "https://example.test", indexttsSpeakerAudioUrl: speaker }) },
        "./indextts": { generateIndexTTS: async (_script, options) => {
          const file = path.join(options.outDir, "voice-track.wav"); fs.writeFileSync(file, "fixture");
          return { finalWavPath: file, rawDuration: 30, selectedDuration: 30 };
        } },
        "./ffmpeg": { probeMedia: async () => probe, sha256File: async () => "fixture-hash",
          prepareSourceVideo: async (_input, _seconds, output) => { fs.writeFileSync(output, "fixture"); return { duration: 30, width: 160, height: 120 }; },
          finalizeVideo: async (_video, _audio, output) => { fs.writeFileSync(output, "fixture"); return probe; } },
        "../mcp/heygen-adapter": { HeyGenMcpAdapter: {} },
        "./openlux-lipsync": { OpenLuxLipsyncAdapter: {} },
        "./fal-veed-lipsync": { FalVeedLipsyncAdapter: { execute: async options => {
          assert.equal((await ledger.reservation(userId, reservation.requestId)).reservedPoints, 333,
            "real audio must expand the hold before any paid lip-sync submission");
          await options.onProviderSubmitting?.();
          if (scenario === "submit-uncertain") throw new Error("submit response was lost");
          options.onProviderAccepted(); options.onJobCreated({ lipsyncId: `fixture-${scenario}` });
          if (scenario === "confirmed-failure") throw Object.assign(new Error("provider confirmed failure"), { code: "LIPSYNC_GENERATION_FAILED" });
          if (scenario === "uncertain") throw new Error("provider poll timeout");
          return { lipsyncId: `fixture-${scenario}`, status: "completed" };
        } } },
        "../cos": { CosService: { isConfigured: () => false } },
        "../lipsync-provider": { resolveLipsyncProvider: () => "veed" },
        "../media-path-policy": { resolveAllowedLocalMediaPath: value => value },
        "../server/media-response": { getTrustedExternalMediaUrl: async () => { throw new Error("local fixture"); } },
        "../main-app-billing": scenario === "settlement-pending" ? { ...billing,
          settleMainAppCredits: async () => { throw new billing.MainAppBillingError("ledger timeout", 503, "BILLING_SETTLEMENT_FAILED"); } } : billing,
      };
      const module = { exports: {} };
      new Function("require", "module", "exports", compiled)(name => {
        assert.ok(name in deps, name); return deps[name];
      }, module, module.exports);
      await module.exports.runDigitalHumanPipeline(task.id);
      const wallet = await ledger.snapshot(userId);
      if (scenario === "success") {
        assert.equal(task.status, "completed");
        assert.equal(task.billing.status, "settled");
        assert.equal(task.results.chargedPoints, 333);
        assert.equal(wallet.available, 667); assert.equal(wallet.held, 0);
      } else if (scenario === "confirmed-failure") {
        assert.equal(task.billing.status, "released");
        assert.equal(wallet.available, 1000); assert.equal(wallet.held, 0);
      } else {
        assert.equal(task.status, "failed");
        assert.equal(task.billing.status, ["uncertain", "submit-uncertain"].includes(scenario) ? "provider_committed" : "settle_pending");
        assert.equal(task.results.finalVideoUrl, undefined, "unsettled output cannot be delivered for free");
        assert.equal(wallet.available, 667); assert.equal(wallet.held, 333);
        await ledger.release({ userId, taskId: reservation.requestId });
      }
    }
  } finally { process.chdir(savedCwd); }
});

test("workspace adapters commit holds before POST and never replay ambiguous paid submissions", async () => {
  const { FalVeedLipsyncAdapter: fal } = await import("../src/lib/engine/fal-veed-lipsync.ts");
  const { OpenLuxLipsyncAdapter: pixverse } = await import("../src/lib/engine/openlux-lipsync.ts");
  for (const [adapter, context] of [[fal, { apiKey: "fixture", model: "veed/lipsync" }],
    [pixverse, { apiKey: "fixture", model: "fixture", baseUrl: "https://example.test" }]]) {
    const original = adapter.fetchWithRetry;
    const upload = adapter.uploadMedia;
    let committed = false;
    let calls = 0;
    if (adapter === pixverse) adapter.uploadMedia = async () => "fixture-media";
    adapter.fetchWithRetry = async (_url, init, attempts) => {
      assert.equal(init.method, "POST");
      assert.equal(committed, true);
      assert.equal(attempts, 1, "a lost paid POST response must not create duplicate jobs");
      calls += 1;
      throw new Error("simulated lost response");
    };
    const options = { videoPath: "fixture", audioPath: "fixture", videoUrl: "https://example.test/video.mp4",
      audioUrl: "https://example.test/audio.wav", outputPath: path.join(temp, "unused.mp4"), onProviderSubmitting: () => { committed = true; } };
    try {
      await assert.rejects(adapter.executeOnce(options, context), /simulated lost response/);
      assert.equal(calls, 1);
      adapter.fetchWithRetry = async () => new Response("rejected", { status: 403 });
      await assert.rejects(adapter.executeOnce(options, context), error => error.code === "LIPSYNC_GENERATION_FAILED",
        "a confirmed rejected submission can release its hold");
    } finally { adapter.fetchWithRetry = original; if (adapter === pixverse) adapter.uploadMedia = upload; }
  }
});

test("MP3 settlement outages preserve a recoverable file and recovery probes and settles without regenerating", async () => {
  const cwd = process.cwd(); process.chdir(temp);
  try {
    const media = await import("../src/lib/engine/ffmpeg.ts");
    const userId = "recover-audio", taskId = "recover-audio-task";
    const speaker = path.join(temp, "audio-speaker.wav"); fs.writeFileSync(speaker, "fixture");
    const reservation = await billing.reserveMainAppCredits({ user: { id: userId, billingAudience: "standalone" },
      taskId, estimatedDuration: 6 });
    const TaskStore = mutableTaskStore({ id: taskId, userId, status: "pending", createdAt: Date.now(), updatedAt: Date.now(),
      progress: 0, step: "idle", logs: [], executionOwner: workers.currentTaskWorker(),
      billing: { ...reservation, isExternalUser: true, status: "reserved" },
      inputs: { outputType: "audio", scriptText: "fixture", speakerAudioUrl: speaker }, results: {} });
    let ttsCalls = 0, settlements = 0, downloads = 0;
    const config = { storageDir: path.join(temp, "jobs"), publicBaseUrl: "https://example.test", indexttsSpeakerAudioUrl: speaker };
    const baseDeps = {
      path, fs, crypto, "../store/task-store": { TaskStore }, "../config": { getAppConfig: () => config },
      "./task-execution": { withTaskExecution: async (_id, action) => action() },
      "./ffmpeg": media, "../cos": { CosService: { isConfigured: () => false } },
      "./fal-veed-lipsync": { FalVeedLipsyncAdapter: { execute: () => assert.fail("audio recovery must never call lip-sync") } },
      "./openlux-lipsync": { OpenLuxLipsyncAdapter: {} }, "../lipsync-provider": { resolveLipsyncProvider: () => "veed" },
    };
    const pipeline = loadSource("../src/lib/engine/pipeline.ts", { ...baseDeps,
      "../server/safe-log": { logServerError: () => undefined }, "../server/task-worker": workers,
      "../mcp/heygen-adapter": { HeyGenMcpAdapter: {} },
      "../media-path-policy": { resolveAllowedLocalMediaPath: value => value },
      "../server/media-response": { getTrustedExternalMediaUrl: async () => { throw new Error("local fixture"); } },
      "./indextts": { generateIndexTTS: async (_script, options) => {
        ttsCalls++;
        const wav = path.join(options.outDir, "voice-track.wav");
        const result = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "3", wav], { encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        return { finalWavPath: wav, rawDuration: 3, selectedDuration: 3 };
      } },
      "../main-app-billing": { ...billing, settleMainAppCredits: async () => {
        assert.equal(TaskStore.get().results.audioFormat, "mp3", "file metadata must precede settlement");
        assert.equal(fs.existsSync(TaskStore.get().results.exactAudioUrl), true);
        throw new billing.MainAppBillingError("fixture ledger outage", 503, "BILLING_SETTLEMENT_FAILED");
      } },
    });
    await pipeline.runDigitalHumanPipeline(taskId);
    const failed = TaskStore.get();
    const actualProbe = await media.probeMedia(failed.results.exactAudioUrl);
    assert.equal(failed.status, "failed"); assert.equal(failed.billing.status, "settle_pending");
    assert.equal(publicData.toPublicTask(failed).recoverable, true);
    assert.equal(publicData.toPublicTask(failed).results.exactAudioUrl, undefined);
    assert.equal((await ledger.snapshot(userId)).held, 67);
    const access = { resolveAccessContext: async () => ({ isolated: true, userId }),
      canAccessTask: (_access, task) => task.userId === userId,
      taskNotFoundResponse: () => NextResponse.json({}, { status: 404 }), unauthorizedResponse: () => NextResponse.json({}, { status: 401 }) };
    const download = loadSource("../src/app/api/tasks/[id]/download/[file]/route.ts", {
      "next/server": { NextRequest, NextResponse }, "@/lib/store/task-store": { TaskStore },
      "@/lib/server/public-data": publicData, "@/lib/access-control": access,
      "@/lib/server/media-response": { isTrustedTaskOutputSource: () => true,
        servePrivateMedia: () => { downloads++; return new NextResponse("fixture"); } },
    });
    const downloadRequest = () => download.GET(new NextRequest("https://example.test/download"), {
      params: Promise.resolve({ id: taskId, file: "voice-track.mp3" }),
    });
    assert.equal((await downloadRequest()).status, 404); assert.equal(downloads, 0);
    TaskStore.update(taskId, { results: { audioDuration: 999, chargedPoints: 1 } });
    const recovery = loadSource("../src/lib/engine/recover-lipsync.ts", { ...baseDeps,
      "./lipsync-chunks": {}, "./download-file": {}, "./pixverse-ingest": {},
      "../server/outbound-url-policy": {}, "../server/media-response": {},
      "../task-output-retention": await import("../src/lib/task-output-retention.ts"),
      "../main-app-billing": { ...billing, settleMainAppCredits: async input => {
        settlements++; return billing.settleMainAppCredits(input);
      } },
    });
    assert.equal(recovery.isRecoverableLipsyncTask(TaskStore.get()), true);
    const recovered = await recovery.recoverStuckLipsyncTask(taskId);
    const points = billing.calculateRequiredPoints(actualProbe.durationSeconds, "workspace");
    assert.equal(recovered.status, "completed"); assert.equal(recovered.billing.status, "settled");
    assert.equal(recovered.results.audioDuration, actualProbe.durationSeconds, "probe existing MP3 instead of trusting saved duration");
    assert.equal(recovered.results.chargedPoints, points);
    await recovery.recoverStuckLipsyncTask(taskId);
    assert.equal(settlements, 1); assert.equal(ttsCalls, 1);
    assert.equal((await ledger.snapshot(userId)).available, 1000 - points);
    assert.equal((await ledger.snapshot(userId)).held, 0);
    assert.equal((await downloadRequest()).status, 200); assert.equal(downloads, 1);
  } finally { process.chdir(cwd); }
});
