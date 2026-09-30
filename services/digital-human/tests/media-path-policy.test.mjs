// 媒体路径与上传凭证策略：本地文件只能落在受控目录内，对象存储 key 只能属于本人，
// 远程地址只承认自家 bucket。这是防任意文件读取 / SSRF / 跨用户覆盖的第一道闸。
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

const policy = await import("../src/lib/media-path-policy.ts");
const upload = await import("../src/lib/server/upload-policy.ts");
const { CosService } = await import("../src/lib/cos.ts");
const { getAppConfig } = await import("../src/lib/config.ts");

const CWD = "/srv/app";

test("isPathInside treats the root itself and its descendants as inside, and rejects escapes", () => {
  assert.equal(policy.isPathInside("/srv/app/.runtime", "/srv/app/.runtime"), true);
  assert.equal(policy.isPathInside("/srv/app/.runtime", "/srv/app/.runtime/uploads/a.mp4"), true);
  assert.equal(policy.isPathInside("/srv/app/.runtime", "/srv/app/.runtime-other/a.mp4"), false);
  assert.equal(policy.isPathInside("/srv/app/.runtime", "/srv/app/.settings.json"), false);
  assert.equal(policy.isPathInside("/srv/app/.runtime", "/etc/passwd"), false);
  assert.equal(policy.isPathInside("/srv/app/.runtime", "/srv/app/.runtime/../.env"), false);
});

test("resolveAllowedLocalMediaPath only accepts files under the private runtime or legacy public media roots", () => {
  const allowed = [
    [`${CWD}/.runtime/uploads/users/u1/videos/a.mp4`, `${CWD}/.runtime/uploads/users/u1/videos/a.mp4`],
    [`${CWD}/.runtime/jobs/task_1/final.mp4`, `${CWD}/.runtime/jobs/task_1/final.mp4`],
    [`${CWD}/.runtime/provider-input/task_1/source-video.mp4`, `${CWD}/.runtime/provider-input/task_1/source-video.mp4`],
    ["/uploads/users/u1/videos/a.mp4", `${CWD}/public/uploads/users/u1/videos/a.mp4`],
    ["/jobs/task_1/voice-track.wav", `${CWD}/public/jobs/task_1/voice-track.wav`],
    [`${CWD}/public/jobs/task_1/final.mp4`, `${CWD}/public/jobs/task_1/final.mp4`],
  ];
  for (const [source, expected] of allowed) {
    assert.equal(policy.resolveAllowedLocalMediaPath(source, CWD), expected, source);
  }

  const rejected = [
    `${CWD}/.settings.json`,
    `${CWD}/.env`,
    `${CWD}/.tasks.json`,
    `${CWD}/.heygen-mcp-auth.json`,
    `${CWD}/src/lib/config.ts`,
    `${CWD}/public/index.html`,
    "/etc/passwd",
    "/proc/self/environ",
    "/uploads/../../.settings.json",
    "/uploads/../.env",
    "/jobs/../../etc/passwd",
    `${CWD}/.runtime/uploads/../../.settings.json`,
    `${CWD}/.runtime-uploads/a.mp4`,
    `${CWD}/public/uploads-old/a.mp4`,
    "relative/uploads/a.mp4",
    "uploads/users/u1/videos/a.mp4",
    "https://shuziren-1410143389.cos.ap-singapore.myqcloud.com/uploads/a.mp4",
    "",
  ];
  for (const source of rejected) {
    assert.equal(policy.resolveAllowedLocalMediaPath(source, CWD), null, `必须拒绝: ${source}`);
  }
});

test("mediaRoots are all absolute and scoped to the working directory", () => {
  const roots = policy.mediaRoots(CWD);
  assert.ok(roots.length >= 2);
  for (const root of roots) {
    assert.ok(path.isAbsolute(root), root);
    assert.ok(root.startsWith(`${CWD}${path.sep}`), `${root} 必须位于工作目录内`);
    assert.ok(!root.endsWith(path.sep));
  }
  assert.ok(roots.includes(`${CWD}/.runtime/uploads`));
  assert.ok(roots.includes(`${CWD}/.runtime/jobs`));
});

test("CosService.getManagedObjectKey only recognises the configured bucket host and rejects traversal", () => {
  const config = getAppConfig();
  const host = `${config.cosBucket}.cos.${config.cosRegion}.myqcloud.com`;

  assert.equal(
    CosService.getManagedObjectKey(`https://${host}/uploads/users/u1/videos/a.mp4`),
    "uploads/users/u1/videos/a.mp4"
  );
  assert.equal(
    CosService.getManagedObjectKey(`https://${host.toUpperCase()}/jobs/t/final.mp4`),
    "jobs/t/final.mp4",
    "主机名匹配应大小写不敏感"
  );
  assert.equal(
    CosService.getManagedObjectKey(`https://${host}/uploads/users/u1/videos/%E4%B8%AD%E6%96%87.mp4`),
    "uploads/users/u1/videos/中文.mp4"
  );

  for (const source of [
    `https://${host}/uploads/..%2F..%2Fsecret`,
    `https://${host}/uploads/a%5Cb.mp4`,
    `https://${host}/_system/tasks.json`,
    `https://${host}/jobs/t/x.wav`,
    `https://${host}/`,
    `https://evil.example.com/${host}/uploads/a.mp4`,
    `https://${host}.evil.example.com/uploads/a.mp4`,
    `https://evil.example.com/uploads/a.mp4?host=${host}`,
    "https://169.254.169.254/latest/meta-data/",
    "https://file.302.ai/gpt/imgs/a.mp3",
    "file:///etc/passwd",
    "/uploads/users/u1/videos/a.mp4",
    "not a url",
    "",
  ]) {
    assert.equal(CosService.getManagedObjectKey(source), null, `必须拒绝: ${source}`);
  }
});

test("legacy avatar key parsing is explicit, host-bound, flat and never broadens managed media", () => {
  const config = getAppConfig();
  const host = `${config.cosBucket}.cos.${config.cosRegion}.myqcloud.com`;
  const video = `https://${host}/uploads/videos/1700000000000_%E5%BD%A2%E8%B1%A1.mp4`;
  const cover = `https://${host}/uploads/thumbnails/1700000000000_%E5%BD%A2%E8%B1%A1.mp4.jpg`;

  assert.equal(
    CosService.getLegacyAvatarObjectKey(video, "videos"),
    "uploads/videos/1700000000000_形象.mp4",
  );
  assert.equal(
    CosService.getLegacyAvatarObjectKey(cover, "thumbnails"),
    "uploads/thumbnails/1700000000000_形象.mp4.jpg",
  );
  assert.equal(CosService.getManagedObjectKey(video), null);
  assert.equal(CosService.getManagedObjectKey(cover), null);
  assert.equal(
    CosService.getLegacyAvatarObjectKey(`https://${host}/uploads/videos/a.m4v`, "videos"),
    "uploads/videos/a.m4v",
  );

  for (const source of [
    `http://${host}/uploads/videos/a.mp4`,
    `https://user:pass@${host}/uploads/videos/a.mp4`,
    `https://${host}:444/uploads/videos/a.mp4`,
    `https://${host}/uploads/videos/a.mp4?download=1`,
    `https://${host}/uploads/videos/a.mp4#fragment`,
    `https://${host}/uploads/videos/nested/a.mp4`,
    `https://${host}/uploads/videos/..%2Fsecret.mp4`,
    `https://${host}/uploads/videos/a%5Cb.mp4`,
    `https://${host}/uploads/videos/a%252Fb.mp4`,
    `https://${host}/uploads/thumbnails/a.svg`,
    `https://evil.example.test/uploads/videos/a.mp4`,
    `https://${host}.evil.example.test/uploads/videos/a.mp4`,
  ]) {
    assert.equal(
      CosService.getLegacyAvatarObjectKey(
        source,
        source.includes("thumbnails") ? "thumbnails" : "videos",
      ),
      null,
      `必须拒绝: ${source}`,
    );
  }
});

test("ownerKeyFor uses a stable collision-resistant identifier rather than lossy character replacement", () => {
  assert.equal(upload.ownerKeyFor(undefined), "anonymous-local");
  assert.equal(upload.ownerKeyFor(null), "anonymous-local");
  assert.equal(upload.ownerKeyFor(""), "anonymous-local");
  assert.match(upload.ownerKeyFor("user-1_A"), /^u_[0-9a-f]{32}$/);
  assert.equal(upload.ownerKeyFor("user-1_A"), upload.ownerKeyFor("user-1_A"));
  assert.notEqual(upload.ownerKeyFor("a/b"), upload.ownerKeyFor("a_b"));
  assert.notEqual(upload.ownerKeyFor("用户1"), upload.ownerKeyFor("用户2"));
  assert.notEqual(upload.ownerKeyFor("local"), upload.ownerKeyFor(undefined));
});

test("validateOwnedUploadKey accepts exactly one flat, well-typed object under the caller's own prefix", () => {
  const me = "user-1";
  const owner = upload.ownerKeyFor(me);
  const ok = upload.validateOwnedUploadKey(`uploads/users/${owner}/videos/abc.mp4`, me, "videos");
  assert.equal(ok, `uploads/users/${owner}/videos/abc.mp4`);
  assert.equal(
    upload.validateOwnedUploadKey(`/uploads/users/${owner}/videos/abc.MP4`, me, "videos"),
    `uploads/users/${owner}/videos/abc.MP4`,
    "前导斜杠应被归一化，扩展名大小写不敏感"
  );
  assert.equal(upload.validateOwnedUploadKey(`uploads/users/${owner}/voices/a.wav`, me, "voices"), `uploads/users/${owner}/voices/a.wav`);
  assert.equal(upload.validateOwnedUploadKey(`uploads/users/${owner}/thumbnails/a.webp`, me, "thumbnails"), `uploads/users/${owner}/thumbnails/a.webp`);

  const rejected = [
    ["uploads/users/user-2/videos/abc.mp4", "他人目录"],
    ["uploads/users/local/videos/abc.mp4", "local 占位目录"],
    [`uploads/users/${owner}/voices/abc.mp3`, "目录与 folder 不匹配"],
    [`uploads/users/${owner}/videos/`, "空对象名"],
    [`uploads/users/${owner}/videos/sub/abc.mp4`, "嵌套路径"],
    [`uploads/users/${owner}/videos/../../../.settings.json`, "路径穿越"],
    [`uploads/users/${owner}/videos/abc.exe`, "禁止的扩展名"],
    [`uploads/users/${owner}/videos/abc`, "无扩展名"],
    [`uploads/users/${owner}/videos/a\\b.mp4`, "反斜杠"],
    ["jobs/task_1/source-video.mp4", "任务产物目录"],
    ["_system/tasks.json", "系统目录"],
    ["", "空字符串"],
  ];
  for (const [key, label] of rejected) {
    assert.equal(upload.validateOwnedUploadKey(key, me, "videos"), null, `${label}: ${key}`);
  }
  for (const junk of [undefined, null, 1, {}, ["uploads/users/user-1/videos/a.mp4"]]) {
    assert.equal(upload.validateOwnedUploadKey(junk, me, "videos"), null, `非字符串 ${String(junk)}`);
  }
});

test("validateUploadDescriptor enforces per-folder size caps, extensions and MIME families", () => {
  const MB = 1024 * 1024;
  const ok = (folder, fileName, contentType, fileSize) =>
    assert.equal(upload.validateUploadDescriptor({ folder, fileName, contentType, fileSize }), null, `${folder} ${fileName}`);
  const bad = (folder, fileName, contentType, fileSize, pattern) =>
    assert.match(
      upload.validateUploadDescriptor({ folder, fileName, contentType, fileSize }) || "",
      pattern,
      `${folder} ${fileName} size=${fileSize}`
    );

  ok("videos", "clip.mp4", "video/mp4", 100 * MB);
  ok("videos", "clip.MOV", "video/quicktime", upload.MAX_UPLOAD_BYTES.videos);
  ok("videos", "clip.webm", undefined, 1);
  ok("videos", "legacy.m4v", "video/x-m4v", 1);
  ok("voices", "voice.wav", "audio/wav", 10 * MB);
  ok("voices", "voice.mp4", "video/mp4", 10 * MB);
  ok("thumbnails", "cover.jpg", "image/jpeg", 1 * MB);

  bad("videos", "clip.mp4", "video/mp4", upload.MAX_UPLOAD_BYTES.videos + 1, /大小/);
  bad("voices", "voice.mp3", "audio/mpeg", upload.MAX_UPLOAD_BYTES.voices + 1, /大小/);
  bad("thumbnails", "cover.png", "image/png", upload.MAX_UPLOAD_BYTES.thumbnails + 1, /大小/);
  bad("videos", "clip.mp4", "video/mp4", 0, /大小/);
  bad("videos", "clip.mp4", "video/mp4", -5, /大小/);
  bad("videos", "clip.mp4", "video/mp4", Number.NaN, /大小/);
  bad("videos", "clip.exe", "video/mp4", 1, /格式/);
  bad("videos", "clip.mp4.html", "video/mp4", 1, /格式/);
  bad("videos", "clip", "video/mp4", 1, /格式/);
  bad("thumbnails", "cover.svg", "image/svg+xml", 1, /格式/);
  bad("videos", "clip.mp4", "text/html", 1, /类型/);
  bad("voices", "voice.wav", "application/octet-stream", 1, /类型/);
  bad("thumbnails", "cover.jpg", "video/mp4", 1, /类型/);

  assert.ok(upload.MAX_UPLOAD_BYTES.voices < upload.MAX_UPLOAD_BYTES.videos);
  assert.ok(upload.MAX_UPLOAD_BYTES.thumbnails < upload.MAX_UPLOAD_BYTES.voices);
});

test("upload grant budget caps both request count and declared bytes per user window", () => {
  const now = 1_800_000_000_000;
  for (let i = 0; i < 30; i += 1) {
    assert.equal(upload.consumeUploadGrantBudget("rate-user", 1, now), true);
  }
  assert.equal(upload.consumeUploadGrantBudget("rate-user", 1, now), false);
  assert.equal(upload.consumeUploadGrantBudget("byte-user", 2 * 1024 * 1024 * 1024, now), true);
  assert.equal(upload.consumeUploadGrantBudget("byte-user", 1, now), false);
  assert.equal(upload.consumeUploadGrantBudget("rate-user", 1, now + 60 * 60 * 1000), true);
});

test("localUploadPath never escapes the private runtime upload root", () => {
  const root = path.resolve(process.cwd(), ".runtime", "uploads");
  assert.equal(
    upload.localUploadPath("uploads/users/user-1/videos/a.mp4"),
    path.join(root, "users", "user-1", "videos", "a.mp4")
  );
  assert.equal(upload.localUploadPath("users/user-1/videos/a.mp4"), path.join(root, "users", "user-1", "videos", "a.mp4"));
  for (const key of ["uploads/../.settings.json", "uploads/users/../../../etc/passwd", "/etc/passwd"]) {
    assert.throws(() => upload.localUploadPath(key), /Invalid upload path/, key);
  }
});
