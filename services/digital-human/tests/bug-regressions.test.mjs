// Regression tests for B6–B11, reproduced against e5876b2 before fixes.
// Uses production source with isolated storage and no real provider/billing calls.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repo = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(path.join(repo, "package.json"));
const ts = require("typescript");
const { NextRequest, NextResponse } = require("next/server");

function sandbox() {
  const cwd = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "digital-human-audit-"));
  const fetch = globalThis.fetch;
  process.chdir(tmp);
  globalThis.fetch = async () => { throw new Error("Real network disabled in audit"); };
  const cache = new Map();
  const overrides = new Map([
    ["src/lib/cos.ts", { CosService: { isConfigured: () => false, getManagedObjectKey: () => null } }],
    ["src/lib/access-control.ts", {
      resolveAccessContext: async () => ({ isolated: true, userId: "audit-user", isAdmin: false, session: { token: "fake" } }),
      canAccessTask: (_access, task) => task.userId === "audit-user",
      canViewAllMedia: () => false,
      unauthorizedResponse: () => NextResponse.json({}, { status: 401 }),
      taskNotFoundResponse: () => NextResponse.json({}, { status: 404 }),
    }],
  ]);
  function load(relative) {
    relative = path.normalize(relative);
    if (overrides.has(relative)) return overrides.get(relative);
    if (cache.has(relative)) return cache.get(relative).exports;
    const filename = path.join(repo, relative);
    const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
        esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX }, fileName: filename,
    }).outputText;
    const module = { exports: {} };
    cache.set(relative, module);
    new Function("require", "module", "exports", compiled)(specifier => {
      if (specifier === "server-only") return {};
      if (overrides.has(specifier)) return overrides.get(specifier);
      let target = specifier.startsWith("@/") ? `src/${specifier.slice(2)}`
        : specifier.startsWith(".") ? path.join(path.dirname(relative), specifier) : null;
      if (!target) return require(specifier);
      if (!path.extname(target)) target = [target + ".ts", target + ".tsx", path.join(target, "index.ts")]
        .find(candidate => fs.existsSync(path.join(repo, candidate))) || target + ".tsx";
      return load(target);
    }, module, module.exports);
    return module.exports;
  }
  return { tmp, load, overrides, close() {
    process.chdir(cwd); globalThis.fetch = fetch; fs.rmSync(tmp, { recursive: true, force: true });
  } };
}

function baseTask() {
  return { userId: "audit-user", status: "pending", step: "idle", progress: 0,
    billing: { isExternalUser: true, status: "reserved", requestId: "audit-reservation",
      estimatedDuration: 6, estimatedPoints: 120, reservedPoints: 120 },
    inputs: { avatarId: "audit-avatar", videoName: "audit.mp4", videoPath: "", videoUrl: "",
      scriptText: "测试", toneProfile: "low", videoFit: "smart", emotionIntensity: 0.8, lipsyncProvider: "veed" }, results: {} };
}

function recoveryStubs(s) {
  s.overrides.set("src/lib/engine/fal-veed-lipsync.ts", { FalVeedLipsyncAdapter: {} });
  s.overrides.set("src/lib/engine/openlux-lipsync.ts", { OpenLuxLipsyncAdapter: {} });
  s.overrides.set("src/lib/engine/pixverse-ingest.ts", {});
  s.overrides.set("src/lib/engine/download-file.ts", {});
  s.overrides.set("src/lib/server/outbound-url-policy.ts", { providerUrlPolicy: () => ({}) });
  s.overrides.set("src/lib/server/media-response.ts", {});
}

test("B6: retrying a claimed voice upload must preserve the first voice audio", async t => {
  const s = sandbox();
  try {
    s.overrides.set("src/lib/engine/ffmpeg.ts", {});
    s.overrides.set("src/lib/server/media-response.ts", {});
    const upload = s.load("src/lib/server/upload-policy.ts");
    const { VoiceStore } = s.load("src/lib/store/voice-store.ts");
    const { POST } = s.load("src/app/api/voices/route.ts");
    const key = `uploads/users/${upload.ownerKeyFor("audit-user")}/voices/fixture.wav`;
    const file = upload.localUploadPath(key);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.alloc(2048));
    assert.equal(upload.reservePendingUpload({ key, userId: "audit-user", folder: "voices", bytes: 2048 }), true);
    upload.markPendingUploadStored(key);
    const request = () => new NextRequest("https://app.example.test/api/voices", {
      method: "POST", body: JSON.stringify({ name: "审计音色", uploadKey: key }), headers: { "Content-Type": "application/json" },
    });
    const first = await POST(request()); const voice = (await first.json()).voice;
    assert.equal(first.status, 200); assert.equal(fs.existsSync(file), true);
    const retry = await POST(request());
    t.diagnostic(JSON.stringify({ first: first.status, retry: retry.status,
      originalRecordStillExists: Boolean(VoiceStore.get(voice.id)), audioStillExists: fs.existsSync(file) }));
    assert.equal(fs.existsSync(file), true, "Rejected duplicate request deleted the already-registered audio");
  } finally { s.close(); }
});

test("B7: deleting a provider-committed task must not refund its stale initial reservation", async t => {
  const s = sandbox();
  try {
    const { TaskStore } = s.load("src/lib/store/task-store.ts");
    const source = path.join(s.tmp, "source.mp4"); const speaker = path.join(s.tmp, "speaker.wav");
    fs.writeFileSync(source, "fixture"); fs.writeFileSync(speaker, "fixture");
    const task = TaskStore.create({ ...baseTask(), inputs: { ...baseTask().inputs, videoPath: source, speakerAudioUrl: speaker } });
    const realBilling = s.load("src/lib/main-app-billing.ts");
    const calls = [];
    s.overrides.set("src/lib/main-app-billing.ts", { ...realBilling,
      releaseMainAppCredits: async () => { calls.push("release"); },
      settleMainAppCredits: async () => { calls.push("settle"); return {}; },
    });
    s.overrides.set("src/lib/config.ts", { getAppConfig: () => ({ storageDir: path.join(s.tmp, "jobs"), publicBaseUrl: "https://app.example.test" }) });
    s.overrides.set("src/lib/engine/recover-lipsync.ts", {});
    const { DELETE } = s.load("src/app/api/tasks/[id]/route.ts");
    s.overrides.set("src/lib/media-path-policy.ts", { resolveAllowedLocalMediaPath: value => value });
    s.overrides.set("src/lib/server/media-response.ts", { getTrustedExternalMediaUrl: async () => { throw new Error("local fixture"); } });
    s.overrides.set("src/lib/mcp/heygen-adapter.ts", {});
    s.overrides.set("src/lib/engine/openlux-lipsync.ts", {});
    s.overrides.set("src/lib/engine/indextts.ts", { generateIndexTTS: async (_text, options) => {
      const file = path.join(options.outDir, "voice-track.wav"); fs.writeFileSync(file, "fixture");
      return { finalWavPath: file, selectedDuration: 3, rawDuration: 3 };
    } });
    s.overrides.set("src/lib/engine/ffmpeg.ts", {
      probeMedia: async () => ({ width: 160, height: 120, durationSeconds: 3, fps: 30 }),
      sha256File: async () => "fakehash0123456789",
      prepareSourceVideo: async (_input, _seconds, output) => { fs.writeFileSync(output, "fixture"); return { duration: 3, width: 160, height: 120 }; },
      finalizeVideo: async (_video, _audio, output) => { fs.writeFileSync(output, "fixture"); return { durationSeconds: 3 }; },
    });
    s.overrides.set("src/lib/engine/fal-veed-lipsync.ts", { FalVeedLipsyncAdapter: { execute: async options => {
      options.onProviderAccepted(); options.onJobCreated({ lipsyncId: "paid-fixture-job" });
      calls.push(TaskStore.get(task.id).billing.status);
      const response = await DELETE(new NextRequest("https://app.example.test/api/tasks/fixture", { method: "DELETE" }), { params: Promise.resolve({ id: task.id }) });
      calls.push(`delete:${response.status}`);
      return { lipsyncId: "paid-fixture-job", status: "completed" };
    } } });
    await s.load("src/lib/engine/pipeline.ts").runDigitalHumanPipeline(task.id, "fake");
    t.diagnostic(JSON.stringify({ calls, recordExists: Boolean(TaskStore.get(task.id)) }));
    assert.equal(calls.includes("release"), false, "Deletion makes pipeline fall back to the old reserved state and refund accepted paid work");
  } finally { s.close(); }
});

test("B8: cloud recovery must establish duration and all deliverables before settlement", async t => {
  const s = sandbox();
  try {
    recoveryStubs(s);
    const objectsChecked = []; const settlements = [];
    s.overrides.set("src/lib/cos.ts", { CosService: {
      isConfigured: () => true, saveJsonToCos: async () => {},
      objectExists: async key => { objectsChecked.push(key); return key.endsWith("final.mp4"); },
      getPublicUrl: key => `https://storage.example.test/${key}`, getJsonFromCos: async () => null,
    } });
    globalThis.fetch = async (url, init) => {
      assert.ok(String(url).endsWith("/api/sso/billing"));
      settlements.push(JSON.parse(init.body));
      return Response.json({ success: true, data: { pointsBalance: 1000 } });
    };
    const { TaskStore } = s.load("src/lib/store/task-store.ts");
    const task = TaskStore.create({ ...baseTask(), status: "failed", billing: { ...baseTask().billing, status: "provider_committed" }, results: { heygenLipsyncId: "paid-fixture-job" } });
    await assert.rejects(s.load("src/lib/engine/recover-lipsync.ts").recoverStuckLipsyncTask(task.id, "fake"), /找不到原声音轨/);
    assert.equal(settlements.length, 0, "Incomplete media must not be billed");
    assert.equal(TaskStore.get(task.id).status, "failed");
    assert.equal(objectsChecked.some(key => key.endsWith("voice-track.wav")), true);
  } finally { s.close(); }
});

function hookHarness(s) {
  const state = []; const effects = []; let cursor = 0;
  const react = {
    useState: initial => {
      const index = cursor++;
      if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
      return [state[index], value => { state[index] = typeof value === "function" ? value(state[index]) : value; }];
    },
    useEffect: effect => effects.push(effect),
    useRef: value => ({ current: value }),
  };
  s.overrides.set("react", react);
  return { state, effects, render(Component, props) { cursor = 0; return Component(props); } };
}

function findElement(node, predicate) {
  if (!node || typeof node !== "object") return undefined;
  if (predicate(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const match = findElement(child, predicate); if (match) return match;
  }
}

function makeMedia(tmp, seconds = 3) {
  const video = path.join(tmp, `picture-${seconds}.mp4`);
  const audio = path.join(tmp, `audio-${seconds}.wav`);
  for (const args of [
    ["-f", "lavfi", "-i", "color=c=blue:s=64x64:r=5", "-t", String(seconds), "-c:v", "libx264", video],
    ["-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", String(seconds), audio],
  ]) {
    const result = spawnSync("ffmpeg", ["-v", "error", ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  return { video, audio };
}

test("MP3 output can be previewed and downloaded only by its owner after settlement", async () => {
  const s = sandbox();
  try {
    const { TaskStore } = s.load("src/lib/store/task-store.ts");
    const task = TaskStore.create({ ...baseTask(), status: "completed", step: "done",
      billing: { ...baseTask().billing, status: "settled" },
      inputs: { ...baseTask().inputs, avatarId: undefined, outputType: "audio" },
    });
    const file = path.join(process.cwd(), "public/jobs", task.id, "voice-track.mp3");
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, "mp3-test-bytes");
    TaskStore.update(task.id, { results: { exactAudioUrl: file, audioFormat: "mp3" } });
    const preview = s.load("src/app/api/tasks/[id]/media/[kind]/route.ts").GET;
    const download = s.load("src/app/api/tasks/[id]/download/[file]/route.ts").GET;
    const req = new NextRequest("https://app.example.test/api/tasks/preview");
    const params = { params: Promise.resolve({id: task.id, kind: "voice", file: "voice-track.mp3"}) };
    const played = await preview(req, params);
    assert.equal(played.status, 200);
    assert.equal(played.headers.get("content-type"), "audio/mpeg");
    assert.equal(await played.text(), "mp3-test-bytes");
    const downloaded = await download(req, params);
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get("content-type"), "audio/mpeg");
    assert.match(downloaded.headers.get("content-disposition"), /voice-track\.mp3/);
    assert.equal(await downloaded.text(), "mp3-test-bytes");
    const publicTask = s.load("src/lib/server/public-data.ts").toPublicTask(TaskStore.get(task.id));
    assert.equal(publicTask.results.audioFormat, "mp3");
    assert.equal(publicTask.results.exactAudioUrl, `/api/tasks/${task.id}/media/voice`);
    assert.equal(publicTask.results.finalVideoUrl, undefined);
    for (const change of [
      {userId: "other-user"},
      {userId: "audit-user", billing: {...task.billing, status: "settle_pending"}},
      {billing: {...task.billing, status: "settled"}, results: {exactAudioUrl: file.replace(task.id, "other-task")}},
    ]) {
      TaskStore.update(task.id, change);
      assert.equal((await preview(req, params)).status, 404);
      assert.equal((await download(req, params)).status, 404);
    }
  } finally { s.close(); }
});

test("audio-only result renders an audio player and MP3 download without video controls", () => {
  const s = sandbox();
  try {
    const hooks = hookHarness(s);
    const Player = s.load("src/components/PlayerComparison.tsx").default;
    const tree = hooks.render(Player, {taskId: "audio-task", exactAudioUrl: "/api/tasks/audio-task/media/voice", audioFormat: "mp3"});
    assert.equal(findElement(tree, node => node.type === "audio").props.src, "/api/tasks/audio-task/media/voice");
    assert.equal(findElement(tree, node => node.type === "a").props.href, "/api/tasks/audio-task/download/voice-track.mp3");
    assert.equal(findElement(tree, node => node.type === "video"), undefined);
  } finally { s.close(); }
});

test("B10: restoring a task must retain a usable avatar when making the next task", async t => {
  const s = sandbox(); const savedStorage = globalThis.localStorage;
  try {
    const hooks = hookHarness(s);
    s.overrides.set("src/components/index.ts", {});
    const stored = new Map([["active_lipsync_task_id", "previous-task"], ["preselected_avatar_id", "new-avatar"]]);
    globalThis.localStorage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) };
    const posts = [];
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith("/api/session")) return Response.json({ data: { user: { role: "admin" } } });
      if (String(url).startsWith("/api/avatars")) return Response.json({ avatars: [{ id: "new-avatar", name: "新形象", videoUrl: "/api/avatars/new-avatar/media?kind=video" }] });
      if (String(url).startsWith("/api/tasks/previous-task")) return Response.json({ task: {
        id: "previous-task", status: "completed", step: "done", progress: 100,
        inputs: { scriptText: "测试", toneProfile: "low", videoFit: "smart", emotionIntensity: 0.8 },
        results: { originalVideoUrl: "/api/tasks/previous-task/media/original" }, logs: [],
      } });
      assert.equal(String(url), "/api/tasks"); const body = JSON.parse(init.body); posts.push(body);
      return body.avatarId
        ? Response.json({ task: { id: "new-task" } })
        : Response.json({ error: "缺少口播形象或文本内容" }, { status: 400 });
    };
    const Component = s.load("src/app/page.tsx").default;
    hooks.render(Component); hooks.effects[0]();
    await new Promise(resolve => setImmediate(resolve));
    const tree = hooks.render(Component);
    const button = findElement(tree, node => node.type === "button" && typeof node.props.onClick === "function" &&
      node.props.onClick.name === "handleStartPipeline");
    assert.ok(button, "actual component start button located");
    assert.equal(button.props.disabled, false);
    await button.props.onClick();
    t.diagnostic(JSON.stringify({ selectedInLibrary: "new-avatar", submittedAvatarId: posts[0].avatarId, error: hooks.state[10] }));
    assert.equal(posts[0].avatarId, "new-avatar", "Restore overwrote the selected avatar with an empty ID while keeping Start enabled");
    assert.equal(hooks.state[10], null);
  } finally { globalThis.localStorage = savedStorage; s.close(); }
});

test("B11: deleting the selected first voice must select an existing fallback", async t => {
  const s = sandbox(); const savedConfirm = globalThis.confirm;
  try {
    const hooks = hookHarness(s); const selections = [];
    globalThis.confirm = () => true;
    globalThis.fetch = async (url, init) => {
      assert.equal(init.method, "DELETE"); return Response.json({ success: true });
    };
    const Component = s.load("src/components/VoiceSelector.tsx").default;
    const props = { selectedVoiceId: "custom-first", onSelectVoice: voice => selections.push(voice.id) };
    hooks.render(Component, props);
    hooks.state[0] = [{ id: "custom-first", name: "新音色", canManage: true }, { id: "default", name: "默认", isDefault: true }];
    hooks.state[1] = false;
    const tree = hooks.render(Component, props);
    const button = findElement(tree, node => node.type === "button" && String(node.props.onClick).includes("handleDeleteVoice"));
    assert.ok(button, "actual component delete button located");
    await button.props.onClick({ stopPropagation() {} });
    t.diagnostic(JSON.stringify({ remainingVoiceIds: hooks.state[0].map(voice => voice.id), selectedVoiceId: selections.at(-1) }));
    assert.equal(hooks.state[0].some(voice => voice.id === selections.at(-1)), true, "Component selected the just-deleted voice");
  } finally { globalThis.confirm = savedConfirm; s.close(); }
});

test("B9: recovery of a split job must recover all video segments", async t => {
  const s = sandbox();
  try {
    recoveryStubs(s);
    const video = path.join(s.tmp, "last-segment.mp4");
    const firstVideo = path.join(s.tmp, "first-segment.mp4");
    const audio = path.join(s.tmp, "full-voice.wav");
    for (const args of [
      ["-f", "lavfi", "-i", "color=c=blue:s=64x64:r=5", "-t", "90", "-c:v", "libx264", firstVideo],
      ["-f", "lavfi", "-i", "color=c=red:s=64x64:r=5", "-t", "10", "-c:v", "libx264", video],
      ["-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", "100", audio],
    ]) {
      const created = spawnSync("ffmpeg", ["-v", "error", ...args], { encoding: "utf8" });
      assert.equal(created.status, 0, created.stderr);
    }
    const fetchedJobs = [];
    s.overrides.set("src/lib/engine/fal-veed-lipsync.ts", { FalVeedLipsyncAdapter: { fetchResult: async id => {
      fetchedJobs.push(id); return { status: "COMPLETED", url: `https://provider.example.test/${id}.mp4` };
    } } });
    s.overrides.set("src/lib/engine/download-file.ts", { downloadFileToDisk: async ({ url, outputPath }) => {
      fs.copyFileSync(url.includes("segment-1") ? firstVideo : video, outputPath); return { bytes: fs.statSync(outputPath).size };
    } });
    const { TaskStore } = s.load("src/lib/store/task-store.ts");
    const task = TaskStore.create({ ...baseTask(), status: "failed", billing: { ...baseTask().billing, isExternalUser: false, status: "not_applicable" },
      results: { heygenLipsyncId: "segment-2", veedResultUrl: "https://provider.example.test/last-segment.mp4" } });
    TaskStore.addLog(task.id, "[VEED] 任务已建立 (ID: segment-1)，开始轮询进度...", "info");
    TaskStore.addLog(task.id, "[VEED] 任务已建立 (ID: segment-2)，开始轮询进度...", "info");
    const dir = path.join(s.tmp, ".runtime/jobs", task.id); fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(audio, path.join(dir, "voice-track.wav"));
    const recovered = await s.load("src/lib/engine/recover-lipsync.ts").recoverStuckLipsyncTask(task.id);
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", path.join(dir, "final.mp4")], { encoding: "utf8" });
    assert.equal(probe.status, 0, probe.stderr);
    const streams = JSON.parse(probe.stdout).streams;
    t.diagnostic(JSON.stringify({ fetchedJobs, status: recovered.status, reportedDuration: recovered.results.videoDuration, streams }));
    assert.deepEqual(fetchedJobs, ["segment-1", "segment-2"], "Only the last paid segment was fetched; full audio is muxed with an incomplete picture");
    assert.ok(Number(streams.find(stream => stream.codec_type === "video").duration) >= 99.9);
    assert.equal(recovered.billing.status, "not_applicable");
  } finally { s.close(); }
});

test("B7: deletion keeps unfinished billing records but allows settled, refunded and internal finished tasks", async () => {
  const s = sandbox();
  try {
    s.overrides.set("src/lib/engine/recover-lipsync.ts", {});
    const { TaskStore } = s.load("src/lib/store/task-store.ts");
    const { DELETE } = s.load("src/app/api/tasks/[id]/route.ts");
    for (const [status, billingStatus, external, expected] of [
      ["pending", "reserved", true, 409], ["processing", "provider_committed", true, 409],
      ["failed", "reserved", true, 409], ["failed", "provider_committed", true, 409],
      ["failed", "settle_pending", true, 409], ["processing", "not_applicable", false, 409],
      ["completed", "settled", true, 200], ["failed", "released", true, 200],
      ["failed", "not_applicable", false, 200],
    ]) {
      const task = TaskStore.create({ ...baseTask(), status, billing: { ...baseTask().billing, status: billingStatus, isExternalUser: external } });
      const dir = path.join(s.tmp, ".runtime/jobs", task.id); fs.mkdirSync(dir, { recursive: true });
      const response = await DELETE(new NextRequest("https://app.example.test/api/tasks/fixture", { method: "DELETE" }), { params: Promise.resolve({ id: task.id }) });
      assert.equal(response.status, expected, `${status}/${billingStatus}`);
      assert.equal(Boolean(TaskStore.get(task.id)), expected === 409);
      assert.equal(fs.existsSync(dir), expected === 409);
    }
  } finally { s.close(); }
});

test("B8: valid cloud media without a report is probed, rebuilt and settled once; concurrent recovery is rejected", async () => {
  const s = sandbox(); let unblock;
  try {
    recoveryStubs(s);
    const { video, audio } = makeMedia(s.tmp);
    const uploaded = []; const settlements = [];
    let started;
    const reachedDownload = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { unblock = resolve; });
    s.overrides.set("src/lib/cos.ts", { CosService: {
      isConfigured: () => true, saveJsonToCos: async () => {},
      objectExists: async key => key.endsWith("final.mp4") || key.endsWith("voice-track.wav"),
      getDownloadUrl: async key => `https://storage.example.test/${key}`,
      uploadFile: async (file, key) => { assert.ok(fs.existsSync(file)); uploaded.push(key); return `https://storage.example.test/${key}`; },
    } });
    s.overrides.set("src/lib/server/media-response.ts", { downloadTrustedMediaToFile: async ({ source, outputPath }) => {
      started(); await gate; fs.copyFileSync(source.endsWith(".wav") ? audio : video, outputPath);
    } });
    globalThis.fetch = async (url, init) => {
      assert.ok(String(url).endsWith("/api/sso/billing")); settlements.push(JSON.parse(init.body));
      return Response.json({ success: true, data: { pointsBalance: 940 } });
    };
    const { TaskStore } = s.load("src/lib/store/task-store.ts");
    const task = TaskStore.create({ ...baseTask(), status: "failed", billing: { ...baseTask().billing, status: "provider_committed" },
      results: { finalVideoUrl: "https://storage.example.test/final.mp4", videoDuration: 0 } });
    const { recoverStuckLipsyncTask } = s.load("src/lib/engine/recover-lipsync.ts");
    const running = recoverStuckLipsyncTask(task.id, "fake");
    await reachedDownload;
    await assert.rejects(recoverStuckLipsyncTask(task.id, "fake"), /任务正在处理中/);
    assert.equal(TaskStore.get(task.id).status, "processing");
    unblock(); const result = await running;
    assert.equal(result.status, "completed"); assert.equal(result.billing.status, "settled");
    assert.equal(settlements.length, 1); assert.equal(settlements[0].billableUnits, 3); assert.equal(settlements[0].points, 60);
    assert.ok(uploaded.some(key => key.endsWith("production-report.json")));
    assert.ok(uploaded.some(key => key.endsWith("voice-track.wav")));
    await recoverStuckLipsyncTask(task.id, "fake");
    assert.equal(settlements.length, 1, "Completed task recovery must be idempotent");
  } finally { unblock?.(); s.close(); }
});

test("B8: settlement failure keeps recovery retryable and invalid durations never reach the ledger", async () => {
  const s = sandbox();
  try {
    recoveryStubs(s);
    const { video, audio } = makeMedia(s.tmp);
    const { TaskStore } = s.load("src/lib/store/task-store.ts");
    const billing = s.load("src/lib/main-app-billing.ts");
    const task = TaskStore.create({ ...baseTask(), status: "failed", billing: { ...baseTask().billing, status: "provider_committed" } });
    const dir = path.join(s.tmp, ".runtime/jobs", task.id); fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(video, path.join(dir, "rendered-source.mp4")); fs.copyFileSync(audio, path.join(dir, "voice-track.wav"));
    const calls = []; let available = false;
    globalThis.fetch = async (_url, init) => {
      calls.push(JSON.parse(init.body));
      if (!available) throw new Error("mock ledger outage");
      return Response.json({ success: true, data: {} });
    };
    for (const actualDuration of [0, -1, NaN, Infinity]) {
      await assert.rejects(billing.settleMainAppCredits({ userId: "audit-user", requestId: "fixture", actualDuration }), /成片时长无效/);
    }
    assert.equal(calls.length, 0);
    const { recoverStuckLipsyncTask } = s.load("src/lib/engine/recover-lipsync.ts");
    await assert.rejects(recoverStuckLipsyncTask(task.id, "fake"), /积分结算暂未完成/);
    assert.equal(TaskStore.get(task.id).billing.status, "settle_pending");
    assert.equal(TaskStore.get(task.id).status, "failed");
    assert.equal(s.load("src/lib/server/public-data.ts").isTaskOutputDeliverable(TaskStore.get(task.id)), false);
    available = true;
    const result = await recoverStuckLipsyncTask(task.id, "fake");
    assert.equal(result.billing.status, "settled"); assert.equal(result.billing.chargedPoints, 60);
    assert.deepEqual(calls.map(call => call.action), ["settle", "settle"]);
    assert.equal(calls[0].requestId, calls[1].requestId);
  } finally { s.close(); }
});

test("B6: concurrent audio claims preserve the winner, and retrying a video upload preserves converted audio", async () => {
  const s = sandbox();
  try {
    const upload = s.load("src/lib/server/upload-policy.ts");
    const { VoiceStore } = s.load("src/lib/store/voice-store.ts");
    s.overrides.set("src/lib/server/media-response.ts", { downloadTrustedMediaToFile: async ({ source, outputPath }) => fs.copyFileSync(source, outputPath) });
    const { POST } = s.load("src/app/api/voices/route.ts");
    const { video, audio } = makeMedia(s.tmp);
    const withSound = path.join(s.tmp, "with-sound.mp4");
    const mixed = spawnSync("ffmpeg", ["-v", "error", "-i", video, "-i", audio, "-c:v", "copy", "-c:a", "aac", withSound], { encoding: "utf8" });
    assert.equal(mixed.status, 0, mixed.stderr);
    for (const [ext, source] of [[".wav", audio], [".mp4", withSound]]) {
      const key = `uploads/users/${upload.ownerKeyFor("audit-user")}/voices/fixture${ext}`;
      const file = upload.localUploadPath(key); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.copyFileSync(source, file);
      upload.reservePendingUpload({ key, userId: "audit-user", folder: "voices", bytes: fs.statSync(file).size }); upload.markPendingUploadStored(key);
      const request = () => new NextRequest("https://app.example.test/api/voices", { method: "POST", body: JSON.stringify({ name: "测试音色", uploadKey: key }) });
      const responses = ext === ".wav" ? await Promise.all([POST(request()), POST(request())]) : [await POST(request())];
      assert.equal(responses.filter(response => response.status === 200).length, 1);
      const winner = (await responses.find(response => response.status === 200).json()).voice;
      const saved = VoiceStore.get(winner.id); assert.ok(fs.existsSync(saved.audioPath));
      const retry = await POST(request()); assert.ok(retry.status >= 400);
      assert.ok(fs.existsSync(saved.audioPath)); assert.ok(VoiceStore.get(winner.id));
    }
  } finally { s.close(); }
});

test("B10: refresh restores a known avatar and allows audio-only generation with a selected voice", async () => {
  const previousStorage = globalThis.localStorage;
  for (const avatarId of ["original-avatar", undefined]) {
    const s = sandbox();
    try {
      const hooks = hookHarness(s);
      const stored = new Map([["active_lipsync_task_id", "previous-task"]]);
      globalThis.localStorage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) };
      globalThis.fetch = async url => String(url).startsWith("/api/session")
        ? Response.json({ data: { user: { role: "admin" } } })
        : Response.json({ task: { id: "previous-task", status: "completed", inputs: { avatarId, scriptText: "测试" }, results: { originalVideoUrl: "/api/tasks/previous-task/media/original" }, logs: [] } });
      s.overrides.set("src/components/index.ts", {});
      const Component = s.load("src/app/page.tsx").default;
      hooks.render(Component); hooks.effects[0]?.(); await new Promise(resolve => setImmediate(resolve));
      const tree = hooks.render(Component);
      const button = findElement(tree, node => node.type === "button" && node.props.onClick?.name === "handleStartPipeline");
      assert.equal(button.props.disabled, !avatarId);
      if (avatarId) assert.equal(hooks.state[0].avatarId, avatarId);
      hooks.state[5] = { id: "selected-voice", name: "测试音色" };
      const ready = hooks.render(Component);
      const start = findElement(ready, node => node.type === "button" && node.props.onClick?.name === "handleStartPipeline");
      assert.equal(start.props.disabled, false);
      let submitted;
      globalThis.fetch = async (_url, init) => { submitted = JSON.parse(init.body); return Response.json({task: {id: "new-task"}}); };
      await start.props.onClick();
      assert.equal(submitted.avatarId, avatarId);
      assert.equal(submitted.speakerVoiceId, "selected-voice");
      assert.equal(submitted.scriptText, "测试");
    } finally { globalThis.localStorage = previousStorage; s.close(); }
  }
});

test("B9: incomplete split recovery stays failed and retry only fetches the missing segment", async () => {
  const s = sandbox();
  try {
    recoveryStubs(s);
    const first = makeMedia(s.tmp, 90); const last = makeMedia(s.tmp, 10); const full = makeMedia(s.tmp, 100);
    let ready = false; const fetched = [];
    s.overrides.set("src/lib/engine/openlux-lipsync.ts", { OpenLuxLipsyncAdapter: { fetchResult: async id => {
      fetched.push(id);
      return id === "part-1" || ready ? { status: 1, url: `https://provider.example.test/${id}.mp4` } : { status: 0 };
    } } });
    s.overrides.set("src/lib/engine/pixverse-ingest.ts", { downloadPixverseResult: async ({ url, outputPath }) => {
      fs.copyFileSync(url.includes("part-1") ? first.video : last.video, outputPath); return { bytes: fs.statSync(outputPath).size };
    } });
    const { TaskStore } = s.load("src/lib/store/task-store.ts");
    const task = TaskStore.create({ ...baseTask(), status: "failed", inputs: { ...baseTask().inputs, lipsyncProvider: "pixverse" },
      billing: { isExternalUser: false, status: "not_applicable" }, results: { lipsyncChunks: [
        { index: 0, lipsyncId: "part-1", status: "ready" }, { index: 1, lipsyncId: "part-2", status: "created" },
      ] } });
    const dir = path.join(s.tmp, ".runtime/jobs", task.id); fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(full.audio, path.join(dir, "voice-track.wav"));
    const { recoverStuckLipsyncTask } = s.load("src/lib/engine/recover-lipsync.ts");
    await assert.rejects(recoverStuckLipsyncTask(task.id), /分段结果尚未完成/);
    assert.equal(TaskStore.get(task.id).status, "failed");
    assert.equal(TaskStore.get(task.id).results.finalVideoUrl, undefined);
    ready = true;
    const result = await recoverStuckLipsyncTask(task.id);
    assert.equal(result.status, "completed"); assert.equal(result.results.videoDuration, 100);
    assert.deepEqual(fetched, ["part-1", "part-2", "part-2"]);
  } finally { s.close(); }
});

test("B9: new VEED split jobs emit persistent identities for every segment", async () => {
  const s = sandbox(); const originalTimeout = globalThis.setTimeout;
  try {
    const { video, audio } = makeMedia(s.tmp, 100);
    s.overrides.set("src/lib/config.ts", { getAppConfig: () => ({ falApiKey: "test-only", falVeedModel: "veed/lipsync" }) });
    s.overrides.set("src/lib/cos.ts", { CosService: {
      isConfigured: () => true, uploadFile: async () => "https://storage.example.test/media",
      getDownloadUrl: async key => `https://storage.example.test/${key}`,
    } });
    let submissions = 0;
    const actualPolicy = s.load("src/lib/server/outbound-url-policy.ts");
    s.overrides.set("src/lib/server/outbound-url-policy.ts", { ...actualPolicy, fetchWithOutboundUrlPolicy: async (url, init) => {
      if (init?.method === "POST") {
        submissions++;
        return Response.json({ request_id: `part-${submissions}` });
      }
      if (String(url).endsWith("/status")) return Response.json({ status: "COMPLETED" });
      const id = String(url).split("/").at(-1);
      return Response.json({ video: { url: `https://provider.example.test/${id}.mp4` } });
    } });
    const dir = path.join(s.tmp, "job"); fs.mkdirSync(dir);
    s.overrides.set("src/lib/engine/download-file.ts", { downloadFileToDisk: async ({ url, outputPath }) => {
      const index = url.includes("part-1") ? 0 : 1;
      fs.copyFileSync(path.join(dir, `lipsync-chunks/video-${index}.mp4`), outputPath);
      return { bytes: fs.statSync(outputPath).size };
    } });
    globalThis.setTimeout = (fn, ms, ...args) => originalTimeout(fn, ms === 6000 ? 0 : ms, ...args);
    const chunks = new Map(); let accepted = 0;
    const { FalVeedLipsyncAdapter } = s.load("src/lib/engine/fal-veed-lipsync.ts");
    const result = await FalVeedLipsyncAdapter.execute({ videoPath: video, audioPath: audio, objectKeyPrefix: "jobs/fixture",
      onProviderAccepted: () => accepted++,
      onChunkProgress: chunk => chunks.set(chunk.index, { ...chunks.get(chunk.index), ...chunk }),
    }, dir);
    assert.equal(result.status, "completed"); assert.equal(submissions, 2); assert.equal(accepted, 2);
    assert.deepEqual([...chunks.values()].map(chunk => [chunk.index, chunk.lipsyncId, chunk.status]), [
      [0, "part-1", "downloaded"], [1, "part-2", "downloaded"],
    ]);
    assert.ok([...chunks.values()].every(chunk => chunk.resultUrl && chunk.outputName));
  } finally { globalThis.setTimeout = originalTimeout; s.close(); }
});

test("B11: voice fallback handles deleting the last item, another item and a failed delete", async () => {
  const previousConfirm = globalThis.confirm;
  for (const scenario of ["last", "other", "failed"]) {
    const s = sandbox();
    try {
      const hooks = hookHarness(s); const selections = [];
      globalThis.confirm = () => true;
      globalThis.fetch = async () => Response.json({ success: scenario !== "failed" }, { status: scenario === "failed" ? 500 : 200 });
      const Component = s.load("src/components/VoiceSelector.tsx").default;
      const props = { selectedVoiceId: scenario === "other" ? "default" : "custom",
        onSelectVoice: voice => selections.push(voice?.id ?? null) };
      hooks.render(Component, props);
      const voices = [{ id: "custom", name: "自定义", canManage: true }, ...scenario === "last" ? [] : [{ id: "default", isDefault: true }]];
      hooks.state[0] = voices; hooks.state[1] = false;
      const tree = hooks.render(Component, props);
      const button = findElement(tree, node => node.type === "button" && String(node.props.onClick).includes("handleDeleteVoice"));
      await button.props.onClick({ stopPropagation() {} });
      assert.deepEqual(selections, scenario === "last" ? [null] : []);
      assert.equal(hooks.state[0].some(voice => voice.id === "custom"), scenario === "failed");
    } finally { globalThis.confirm = previousConfirm; s.close(); }
  }
});
