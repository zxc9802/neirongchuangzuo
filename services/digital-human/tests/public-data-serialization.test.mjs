// 公开序列化层行为测试：任务 / 音色 / 形象在返回浏览器前必须脱掉所有供应商、模型、
// 内部路径与内部编号信息。这里直接调用 toPublic* 与 sanitizePublicText，而不是只做源码正则。
import assert from "node:assert/strict";
import test from "node:test";

const {
  resolvePrivateEngine,
  sanitizePublicText,
  toPublicAvatar,
  toPublicTask,
  toPublicVoice,
} = await import("../src/lib/server/public-data.ts");
const { LIPSYNC_PROVIDERS, resolveLipsyncProvider, isLipsyncProvider } = await import(
  "../src/lib/lipsync-provider.ts"
);

const IMPLEMENTATION_MARKERS =
  /index\s*tts|302\.ai|file\.302|fal\.ai|\bveed\b|pixverse|openlux|heygen|model\s*context\s*protocol|\bmcp\b|myqcloud|\/app\/|\.runtime|public\/uploads/i;

const COS_HOST = "https://shuziren-1410143389.cos.ap-singapore.myqcloud.com";

test("unconfigured default voices have no playable URL; saved audio uses a protected endpoint", () => {
  const empty = { id: "default_speaker_1", name: "默认音色", audioUrl: "", createdAt: 0, isDefault: true };
  assert.equal(toPublicVoice(empty, false).audioUrl, "");
  const local = toPublicVoice({ ...empty, audioPath: "/private/voice.wav" }, false);
  assert.equal(local.audioUrl, "/api/voices/default_speaker_1/audio");
  assert.equal("audioPath" in local, false);
  const remote = toPublicVoice({ ...empty, audioUrl: "https://example.com/private-voice.wav" }, false);
  assert.equal(remote.audioUrl, "/api/voices/default_speaker_1/audio");
});

function makeTask(overrides = {}) {
  const now = Date.now() - 60_000;
  return {
    id: "task_1790000000000_abcde",
    userId: "user-1",
    userAccount: "13800000000",
    createdAt: now,
    updatedAt: now + 60_000,
    status: "failed",
    step: "mcp_lipsync_polling",
    failedStep: "mcp_lipsync_submit",
    progress: 66,
    logs: [
      { timestamp: now, level: "info", message: "🚀 启动数字人对口型流水线..." },
      { timestamp: now, level: "info", message: "校验 PixVerse 对口型素材，准备上传至 OpenLux / PixVerse" },
      { timestamp: now, level: "warn", message: `HeyGen MCP 提交超时 lipsync_id: 5d2c1b3a-9f4e-4c2b-8a1d-0e7f6a5b4c3d ${COS_HOST}/jobs/x/source-video.mp4` },
      { timestamp: now, level: "error", message: "IndexTTS-2 via 302.ai 返回 402，HEYGEN_API_KEY 无效" },
    ],
    billing: {
      isExternalUser: true,
      ratePerSecond: 20,
      costCnyPerSecond: 0.2,
      requestId: "req-secret-123",
      estimatedDuration: 12,
      estimatedPoints: 240,
      costCny: 2.4,
      pointsBalanceBefore: 9999,
      pointsBalanceAfter: 9759,
      status: "reserved",
    },
    inputs: {
      avatarId: "avatar_1_x",
      videoName: "AI企业增效-HeyGen完整对口型.mp4",
      videoPath: "/app/public/uploads/users/user-1/videos/1.mp4",
      videoUrl: `${COS_HOST}/uploads/users/user-1/videos/1.mp4`,
      scriptText: "大家好，欢迎收看。",
      toneProfile: "low",
      videoFit: "smart",
      emotionIntensity: 0.8,
      speakerVoiceId: "voice_1",
      speakerAudioUrl: "https://file.302.ai/gpt/imgs/20260819/speaker.mp3",
      emotionAudioUrl: "https://file.302.ai/gpt/imgs/20260820/emotion.wav",
      lipsyncProvider: "heygen",
    },
    results: {
      originalVideoUrl: `${COS_HOST}/jobs/task_1/source-video.mp4`,
      finalVideoUrl: `${COS_HOST}/jobs/task_1/final.mp4`,
      exactAudioUrl: "/jobs/task_1/voice-track.wav",
      evidenceJsonUrl: "/jobs/task_1/production-report.json",
      heygenLipsyncId: "lipsync-secret-id",
      lipsyncProvider: "heygen",
      lipsyncCredits: 42,
      pixverseResultUrl: "https://api.openlux.ai/result/1.mp4",
      veedResultUrl: "https://fal.ai/result/1.mp4",
      chargedPoints: 240,
      costCny: 2.4,
      billingDuration: 12,
      videoDuration: 12.04,
      audioDuration: 11.98,
      resolution: "720x1280",
      fps: 30,
      sha256Video: "a".repeat(64),
      sha256Audio: "b".repeat(64),
      creditsBefore: 1000,
      creditsAfter: 958,
    },
    error: "OpenLux 返回 402 credits insufficient (https://api.openlux.ai/v1/lipsync)",
    ...overrides,
  };
}

test("sanitizePublicText removes provider names, URLs and internal identifiers", () => {
  const cases = [
    ["HeyGen 提交失败", /heygen/i],
    ["IndexTTS-2 合成失败", /index\s*tts/i],
    ["IndexTTS2 合成失败", /index\s*tts/i],
    ["302.ai 请求超时", /302\.ai/],
    ["fal.ai queue timeout", /fal\.ai/],
    ["VEED Lipsync 返回 500", /veed/i],
    ["PixVerse-lipsync 队列已满", /pixverse/i],
    ["OpenLux.ai 余额不足", /openlux/i],
    ["MCP 工具调用失败", /\bmcp\b/i],
    ["Model Context Protocol handshake failed", /model\s*context\s*protocol/i],
    ["下载失败 https://shuziren-1410143389.cos.ap-singapore.myqcloud.com/jobs/a/b.mp4", /https?:|myqcloud/],
    ["task_id: task_1790000000000_abcde 已提交", /task_1790/],
    ["lipsync-id=5d2c1b3a-9f4e-4c2b-8a1d-0e7f6a5b4c3d", /5d2c1b3a/],
    ["缺少 HEYGEN_API_KEY", /HEYGEN_API_KEY/],
  ];

  for (const [input, forbidden] of cases) {
    const output = sanitizePublicText(input);
    assert.doesNotMatch(output, forbidden, `"${input}" → "${output}"`);
    assert.ok(output.length > 0, "脱敏后不能为空字符串");
  }
});

test("sanitizePublicText falls back for empty or non-string input and collapses whitespace", () => {
  assert.equal(sanitizePublicText(""), "处理失败，请稍后重试");
  assert.equal(sanitizePublicText("   "), "处理失败，请稍后重试");
  assert.equal(sanitizePublicText(undefined, "自定义兜底"), "自定义兜底");
  assert.equal(sanitizePublicText(null, "自定义兜底"), "自定义兜底");
  assert.equal(sanitizePublicText(42, "自定义兜底"), "自定义兜底");
  assert.equal(sanitizePublicText("a    b\n\n c"), "a b c");
});

test("sanitizePublicText keeps ordinary words intact (no partial-word replacement)", () => {
  // 供应商词替换必须以词界为准，否则 default / false / fallback 会被打成乱文，
  // 反而向用户暴露"有内容被打码"这一事实。
  for (const word of ["default", "false", "fallback", "defaults"]) {
    const output = sanitizePublicText(`使用 ${word} 配置继续`);
    assert.ok(output.includes(word), `"${word}" 不应被替换，实际输出: "${output}"`);
  }
  assert.ok(
    sanitizePublicText("上游返回 HTTP 302 重定向").includes("302"),
    "HTTP 302 状态码不是供应商标识，不应被替换"
  );
});

test("sanitizePublicText removes upstream media and plain numeric IDs", () => {
  assert.doesNotMatch(
    sanitizePublicText("[engine] 视频已就绪 (media_id: 987654321)"),
    /987654321|media_id/i
  );
  assert.doesNotMatch(
    sanitizePublicText("[engine] 任务已建立 (ID: 123456789)"),
    /123456789/
  );
  assert.doesNotMatch(sanitizePublicText("request req_secret123 ready"), /req_secret123/);
});

test("toPublicTask exposes no provider, model, raw URL, local path or billing internals", () => {
  const publicTask = toPublicTask(makeTask());
  const serialized = JSON.stringify(publicTask);

  assert.doesNotMatch(serialized, IMPLEMENTATION_MARKERS, serialized);
  assert.doesNotMatch(serialized, /https?:\/\//, "公开 DTO 里不得出现任何绝对 URL");
  assert.doesNotMatch(serialized, /5d2c1b3a|lipsync-secret-id|req-secret-123/, "内部编号不得外泄");

  for (const forbiddenKey of [
    "videoPath",
    "videoUrl",
    "speakerAudioUrl",
    "emotionAudioUrl",
    "lipsyncProvider",
    "heygenLipsyncId",
    "lipsyncCredits",
    "pixverseResultUrl",
    "veedResultUrl",
    "requestId",
    "pointsBalanceBefore",
    "pointsBalanceAfter",
    "creditsBefore",
    "creditsAfter",
    "userAccount",
  ]) {
    assert.ok(!serialized.includes(`"${forbiddenKey}"`), `公开 DTO 不得包含字段 ${forbiddenKey}`);
  }
  // The library already exposes this app-owned ID; restoring a task needs it.
  assert.equal(publicTask.inputs.avatarId, makeTask().inputs.avatarId);
});

test("toPublicTask maps private providers to neutral engine codes and steps to neutral names", () => {
  const engineMap = { pixverse: "a", veed: "b", heygen: "c" };
  for (const [provider, code] of Object.entries(engineMap)) {
    const fromInputs = toPublicTask(
      makeTask({ inputs: { ...makeTask().inputs, lipsyncProvider: provider }, results: {} })
    );
    assert.equal(fromInputs.inputs.engine, code, `inputs.lipsyncProvider=${provider}`);

    const fromResults = toPublicTask(
      makeTask({
        inputs: { ...makeTask().inputs, lipsyncProvider: undefined },
        results: { lipsyncProvider: provider },
      })
    );
    assert.equal(fromResults.inputs.engine, code, `results.lipsyncProvider=${provider}`);
  }

  const stepMap = {
    idle: "idle",
    tts: "voice",
    media_prep: "prepare",
    mcp_preflight: "check",
    mcp_lipsync_submit: "render",
    mcp_lipsync_polling: "render",
    finalize: "finalize",
    done: "done",
    error: "error",
  };
  for (const [privateStep, publicStep] of Object.entries(stepMap)) {
    const task = toPublicTask(makeTask({ step: privateStep, failedStep: privateStep }));
    assert.equal(task.step, publicStep, `step ${privateStep}`);
    assert.equal(task.failedStep, publicStep, `failedStep ${privateStep}`);
  }
  assert.equal(toPublicTask(makeTask({ failedStep: undefined })).failedStep, undefined);
});

test("toPublicTask rewrites every media reference to an application-owned proxy URL", () => {
  const task = makeTask({
    status: "completed",
    billing: { ...makeTask().billing, status: "settled" },
  });
  const publicTask = toPublicTask(task);
  const base = `/api/tasks/${task.id}/media`;

  assert.equal(publicTask.results.originalVideoUrl, `${base}/original`);
  assert.equal(publicTask.results.finalVideoUrl, `${base}/final`);
  assert.equal(publicTask.results.exactAudioUrl, `${base}/voice`);
  assert.equal(
    publicTask.results.evidenceJsonUrl,
    `/api/tasks/${task.id}/download/production-report.json`
  );

  const empty = toPublicTask(
    makeTask({ inputs: { ...task.inputs, videoPath: "", videoUrl: "" }, results: {} })
  );
  assert.equal(empty.results.originalVideoUrl, undefined);
  assert.equal(empty.results.finalVideoUrl, undefined);
  assert.equal(empty.results.exactAudioUrl, undefined);
  assert.equal(empty.results.evidenceJsonUrl, undefined);

  const weirdId = toPublicTask(makeTask({
    id: "task with/slash?x",
    status: "completed",
    billing: { ...makeTask().billing, status: "settled" },
  }));
  assert.equal(
    weirdId.results.finalVideoUrl,
    `/api/tasks/${encodeURIComponent("task with/slash?x")}/media/final`
  );
});

test("unsettled external tasks never publish final output URLs", () => {
  for (const status of ["reserved", "provider_committed", "settle_pending", "released"]) {
    const publicTask = toPublicTask(makeTask({
      status: status === "released" ? "failed" : "completed",
      billing: { ...makeTask().billing, status },
    }));
    assert.equal(publicTask.results.finalVideoUrl, undefined, status);
    assert.equal(publicTask.results.exactAudioUrl, undefined, status);
    assert.equal(publicTask.results.evidenceJsonUrl, undefined, status);
  }
});

test("toPublicTask computes recoverable only for unfinished tasks with paid lipsync artifacts", () => {
  assert.equal(toPublicTask(makeTask({ status: "failed" })).recoverable, true);
  assert.equal(
    toPublicTask(makeTask({
      status: "completed",
      billing: { ...makeTask().billing, status: "settled" },
    })).recoverable,
    false,
  );
  assert.equal(
    toPublicTask(makeTask({
      status: "completed",
      billing: { ...makeTask().billing, status: "settle_pending" },
    })).recoverable,
    true,
  );
  assert.equal(
    toPublicTask(
      makeTask({
        status: "failed",
        results: { lipsyncChunks: [{ index: 0, status: "ready" }] },
      })
    ).recoverable,
    true
  );
  assert.equal(toPublicTask(makeTask({ status: "failed", results: {} })).recoverable, false);
  assert.equal(
    toPublicTask(makeTask({ billing: { ...makeTask().billing, status: "released" } })).recoverable,
    false,
  );
});

test("toPublicTask sanitizes logs, error and video name but keeps the user's script verbatim", () => {
  const task = makeTask();
  const publicTask = toPublicTask(task);

  assert.equal(publicTask.logs.length, task.logs.length);
  for (const entry of publicTask.logs) {
    assert.doesNotMatch(entry.message, IMPLEMENTATION_MARKERS, entry.message);
    assert.ok(["info", "warn", "error", "success"].includes(entry.level));
  }
  assert.doesNotMatch(publicTask.error, IMPLEMENTATION_MARKERS);
  assert.doesNotMatch(publicTask.inputs.videoName, /heygen/i);
  assert.equal(publicTask.inputs.scriptText, task.inputs.scriptText);
  assert.equal(toPublicTask(makeTask({ error: undefined })).error, undefined);
  assert.equal(toPublicTask(makeTask({ logs: undefined })).logs.length, 0);
});

test("toPublicTask keeps only user-facing billing fields", () => {
  const publicTask = toPublicTask(makeTask());
  assert.deepEqual(Object.keys(publicTask.billing).sort(), [
    "actualDuration",
    "chargedPoints",
    "costCny",
    "estimatedDuration",
    "estimatedPoints",
    "isExternalUser",
    "reservedPoints",
    "source",
    "status",
  ]);
  assert.equal(toPublicTask(makeTask({ billing: undefined })).billing, undefined);
});

test("toPublicVoice and toPublicAvatar hide storage locations behind proxy URLs", () => {
  const voice = toPublicVoice(
    {
      id: "voice_1",
      userId: "user-1",
      name: "HeyGen 同款音色",
      description: "来自 file.302.ai 的参考音频",
      audioUrl: "https://file.302.ai/gpt/imgs/20260819/speaker.mp3",
      audioPath: "/app/.runtime/uploads/users/user-1/voices/a.mp3",
      createdAt: 1,
      isDefault: false,
    },
    true
  );
  const voiceJson = JSON.stringify(voice);
  assert.equal(voice.audioUrl, "/api/voices/voice_1/audio");
  assert.doesNotMatch(voiceJson, IMPLEMENTATION_MARKERS, voiceJson);
  assert.ok(!voiceJson.includes("audioPath"));
  assert.ok(!voiceJson.includes("userId"));
  assert.equal(voice.canManage, true);

  const avatar = toPublicAvatar(
    {
      id: "avatar_1",
      userId: "user-1",
      name: "AI企业增效-HeyGen完整对口型",
      videoUrl: `${COS_HOST}/uploads/users/user-1/videos/1.mp4`,
      videoPath: "/app/.runtime/uploads/users/user-1/videos/1.mp4",
      coverUrl: `${COS_HOST}/uploads/users/user-1/thumbnails/1.jpg`,
      durationSeconds: 86.8,
      width: 720,
      height: 1280,
      fps: 30,
      fileSize: 21808067,
      isCos: true,
      createdAt: 1,
    },
    false
  );
  const avatarJson = JSON.stringify(avatar);
  assert.equal(avatar.videoUrl, "/api/avatars/avatar_1/media?kind=video");
  assert.match(avatar.coverUrl, /^\/api\/avatars\/avatar_1\/media\?kind=cover&v=[a-f0-9]{24}$/);
  assert.equal(avatar.storedRemotely, true);
  assert.equal(avatar.canManage, false);
  assert.doesNotMatch(avatarJson, IMPLEMENTATION_MARKERS, avatarJson);
  assert.ok(!avatarJson.includes("videoPath"));
  assert.ok(!avatarJson.includes("isCos"));

  const noCover = toPublicAvatar({ id: "avatar_2", name: "x", videoUrl: "u", coverUrl: "", createdAt: 1 });
  assert.equal(noCover.coverUrl, undefined);
});

test("public engine codes round-trip to exactly one private provider each", () => {
  assert.equal(resolvePrivateEngine("a"), "pixverse");
  assert.equal(resolvePrivateEngine("b"), "veed");
  assert.equal(resolvePrivateEngine("c"), "heygen");
  // 非法输入必须落到固定默认值，而不是把客户端字符串透传给流水线
  for (const junk of [undefined, null, "", "heygen", "pixverse", "z", 1, {}]) {
    assert.equal(resolvePrivateEngine(junk), "veed", `engine=${String(junk)}`);
  }

  for (const provider of LIPSYNC_PROVIDERS) {
    assert.ok(isLipsyncProvider(provider));
    assert.equal(resolveLipsyncProvider(provider, "veed"), provider);
  }
  assert.equal(resolveLipsyncProvider("HeyGen", "veed"), "veed", "大小写不匹配时应落到默认值");
  assert.equal(resolveLipsyncProvider(undefined, "pixverse"), "pixverse");
  assert.equal(isLipsyncProvider(null), false);
});
