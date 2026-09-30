import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (relativePath) =>
  readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

const IMPLEMENTATION_MARKERS =
  /index\s*tts|302\.ai|fal\.ai|\bveed\b|pixverse|openlux|heygen|model\s*context\s*protocol|\bmcp\b/i;

test("client-facing source contains no provider or model identity", async () => {
  const clientFiles = [
    "src/app/page.tsx",
    "src/app/history/page.tsx",
    "src/app/voices/page.tsx",
    "src/app/avatars/page.tsx",
    "src/app/settings/page.tsx",
    "src/app/mcp/page.tsx",
    "src/components/AvatarLibrary.tsx",
    "src/components/Navbar.tsx",
    "src/components/PipelineVisualizer.tsx",
    "src/components/PlayerComparison.tsx",
    "src/components/TaskTerminal.tsx",
    "src/components/VideoUploader.tsx",
    "src/components/VoiceSelector.tsx",
    "src/components/index.ts",
    "src/lib/client-media-upload.ts",
    "src/lib/public-contract.ts",
  ];

  for (const file of clientFiles) {
    assert.doesNotMatch(await read(file), IMPLEMENTATION_MARKERS, file);
  }
});

test("task APIs serialize the private task before returning it", async () => {
  const files = [
    "src/app/api/tasks/route.ts",
    "src/app/api/tasks/[id]/route.ts",
    "src/app/api/tasks/[id]/recover/route.ts",
    "src/app/api/tasks/[id]/stream/route.ts",
  ];
  for (const file of files) {
    assert.match(await read(file), /toPublicTask/, file);
  }

  const createRoute = await read("src/app/api/tasks/route.ts");
  const requestFields = createRoute.slice(
    createRoute.indexOf("const {"),
    createRoute.indexOf("} = body")
  );
  assert.match(requestFields, /avatarId/);
  assert.match(requestFields, /engine/);
  assert.doesNotMatch(requestFields, /videoPath|videoUrl|speakerAudioUrl|emotionAudioUrl/);
});

test("public media DTOs use application-owned proxy URLs", async () => {
  const serializer = await read("src/lib/server/public-data.ts");
  assert.match(serializer, /\/api\/tasks\/\$\{encodeURIComponent\(task\.id\)\}\/media/);
  assert.match(serializer, /\/api\/voices\/\$\{encodeURIComponent\(voice\.id\)\}\/audio/);
  assert.match(serializer, /\/api\/avatars\/\$\{encodeURIComponent\(avatar\.id\)\}\/media/);
  assert.doesNotMatch(await read("src/lib/public-contract.ts"), /videoPath|audioPath|serverUrl|baseUrl/);
});

test("browser management surfaces and direct public storage are closed", async () => {
  const middleware = await read("src/middleware.ts");
  assert.match(middleware, /pathname\.startsWith\("\/api\/mcp\/"\)/);
  assert.match(middleware, /pathname === "\/api\/settings"/);
  assert.match(middleware, /pathname\.startsWith\("\/jobs\/"\)/);
  assert.match(middleware, /pathname\.startsWith\("\/uploads\/"\)/);

  for (const file of ["src/app/settings/page.tsx", "src/app/mcp/page.tsx"]) {
    assert.match(await read(file), /notFound\(\)/, file);
  }
  for (const file of [
    "src/app/api/settings/route.ts",
    "src/app/api/mcp/tools/route.ts",
    "src/app/api/mcp/call/route.ts",
    "src/app/api/cos/test/route.ts",
    "src/app/api/cos/presign/route.ts",
  ]) {
    assert.match(await read(file), /status: 404/, file);
  }
});

test("task deletion creates a tombstone and cleans the entire task prefix", async () => {
  const store = await read("src/lib/store/task-store.ts");
  const route = await read("src/app/api/tasks/[id]/route.ts");
  const pipeline = await read("src/lib/engine/pipeline.ts");
  assert.match(store, /deletedTaskIds\.add\(id\)/);
  assert.match(store, /isDeleted\(id: string\)/);
  assert.match(route, /TaskStore\.delete\(id\)/);
  assert.match(route, /listFiles\(`jobs\/\$\{id\}\//);
  assert.match(pipeline, /TaskStore\.isDeleted\(taskId\)/);
  assert.match(pipeline, /listFiles\(`jobs\/\$\{taskId\}\//);
});

test("stores keep active raw records under ignored runtime state only", async () => {
  for (const file of [
    "src/lib/store/task-store.ts",
    "src/lib/store/voice-store.ts",
    "src/lib/store/avatar-store.ts",
  ]) {
    const source = await read(file);
    assert.match(source, /path\.join\(process\.cwd\(\), "\.runtime", "state"\)/, file);
    const activeBackupDeclaration = source.match(/const BACKUP_[A-Z_]+ = [^;]+;/)?.[0] || "";
    assert.doesNotMatch(activeBackupDeclaration, /public|jobs|uploads/, file);
  }

  assert.match(await read("docker-compose.yml"), /\.\/data\/state:\/app\/\.runtime\/state/);
});

test("tracked defaults contain no literal credentials or reference-media URLs", async () => {
  const source = `${await read("src/lib/config.ts")}\n${await read("docker-compose.yml")}`;
  assert.doesNotMatch(source, /sk-[A-Za-z0-9]{24,}/);
  assert.doesNotMatch(source, /AKID[A-Za-z0-9]{20,}/);
  assert.doesNotMatch(source, /file\.302\.ai\/gpt\/imgs/);
});

test("generated report schema is implementation-neutral", async () => {
  for (const file of [
    "src/lib/engine/pipeline.ts",
    "src/lib/engine/recover-lipsync.ts",
  ]) {
    const source = await read(file);
    const report = source.slice(
      source.indexOf("const evidencePayload"),
      source.indexOf("const evidencePath")
    );
    assert.doesNotMatch(report, /provider\s*:|model\s*:|lipsync_id|submission_title|credits\s*:/, file);
  }
});
