import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import { NextRequest, NextResponse } from "next/server.js";
import * as library from "../src/lib/server/digital-human-library.ts";
import * as publicData from "../src/lib/server/public-data.ts";
import * as mediaPolicy from "../src/lib/media-access-policy.ts";

const query = values => library.parseLibraryQuery(new URLSearchParams(values));
const key = item => `${item.kind}:${item.id}`;
const records = [
  { kind: "task", id: "b", createdAt: 300 },
  { kind: "avatar", id: "a", createdAt: 300 },
  { kind: "task", id: "a", createdAt: 300 },
  { kind: "avatar", id: "old", createdAt: 100 },
  { kind: "task", id: "middle", createdAt: 200 },
];

test("library keyset pages resolve timestamp and cross-kind ID ties without duplicates", () => {
  const seen = [];
  let cursor;
  do {
    const page = library.paginateLibrary(records, query({ limit: "2", ...(cursor ? { cursor } : {}) }));
    seen.push(...page.items.map(key));
    assert.equal(page.total, 5);
    assert.deepEqual(page.counts, { all: 5, avatars: 2, tasks: 3 });
    assert.equal(page.hasMore, page.nextCursor !== null);
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, ["avatar:a", "task:a", "task:b", "task:middle", "avatar:old"]);
  assert.equal(new Set(seen).size, records.length);
});

test("newer inserts and deletion of the cursor item do not shift subsequent pages", () => {
  const first = library.paginateLibrary(records, query({ limit: "2" }));
  const changed = records.filter(item => key(item) !== "task:a");
  changed.push({ kind: "avatar", id: "new", createdAt: 400 });
  const next = library.paginateLibrary(changed, query({ cursor: first.nextCursor, limit: "48" }));
  assert.deepEqual(next.items.map(key), ["task:b", "task:middle", "avatar:old"]);
  assert.equal(next.hasMore, false);
});

test("kind filters retain independent counts and cannot reuse another filter's cursor", () => {
  const first = library.paginateLibrary(records, query({ kind: "tasks", limit: "1" }));
  assert.equal(first.total, 3);
  assert.equal(first.items[0].kind, "task");
  assert.deepEqual(first.counts, { all: 5, avatars: 2, tasks: 3 });
  const second = library.paginateLibrary(records, query({ kind: "tasks", cursor: first.nextCursor }));
  assert.deepEqual(second.items.map(key), ["task:b", "task:middle"]);
  assert.throws(() => query({ kind: "all", cursor: first.nextCursor }), library.LibraryQueryError);
  const empty = library.paginateLibrary([], query({}));
  assert.deepEqual(empty, { items: [], total: 0, counts: { all: 0, avatars: 0, tasks: 0 }, hasMore: false, nextCursor: null });
});

test("malformed cursors, repeated parameters, invalid filters and out-of-range limits are rejected", () => {
  assert.equal(query({}).limit, 12);
  assert.equal(query({ limit: "1" }).limit, 1);
  assert.equal(query({ limit: "48" }).limit, 48);
  for (const limit of ["", "0", "49", "-1", "1.5", "Infinity", "1e1", " 2", "001"]) {
    assert.throws(() => query({ limit }), library.LibraryQueryError, limit);
  }
  for (const cursor of ["", "!invalid", "e30", "W10", "null", Buffer.from(JSON.stringify({ v: 1, filter: "all", kind: "avatar", id: "x", createdAt: "300" })).toString("base64url")]) {
    assert.throws(() => query({ cursor }), library.LibraryQueryError, cursor);
  }
  assert.throws(() => query({ kind: "images" }), library.LibraryQueryError);
  assert.throws(() => query({ avatarId: "" }), library.LibraryQueryError);
  assert.throws(() => query({ taskId: "x\n" }), library.LibraryQueryError);
  assert.throws(() => library.parseLibraryQuery(new URLSearchParams("limit=2&limit=3")), library.LibraryQueryError);
});

function fixtureAvatar(id, userId, createdAt) {
  return { id, userId, createdAt, name: id, videoPath: "D:/private/person.mp4", videoUrl: "https://private.example/video?secret=hidden", coverUrl: "https://private.example/cover", durationSeconds: 8, width: 720, height: 1280, fileSize: 1024 };
}

function fixtureTask(id, userId, createdAt, status = "completed") {
  return {
    id, userId, createdAt, updatedAt: createdAt, status, step: status === "completed" ? "done" : "tts", progress: 50, logs: [],
    inputs: { videoName: id, videoPath: "D:/private/person.mp4", videoUrl: "https://private.example/video", scriptText: "门店宣传文案", toneProfile: "low", videoFit: "smart", emotionIntensity: 0.8 },
    results: { finalVideoUrl: "https://private.example/output?secret=hidden", exactAudioUrl: "D:/private/audio.wav", heygenLipsyncId: "hidden-provider-id" },
  };
}

function mockRoute() {
  let context = { isolated: true, userId: "owner", isAdmin: false, session: { user: { account: "ordinary" } } };
  const avatars = [fixtureAvatar("own-avatar", "owner", 100), fixtureAvatar("foreign-avatar", "other", 500)];
  const tasks = [fixtureTask("own-task", "owner", 400), fixtureTask("own-active", "owner", 300, "processing"), fixtureTask("foreign-active", "other", 600, "pending")];
  const reads = [];
  const deps = {
    "next/server": { NextRequest, NextResponse },
    "@/lib/store/avatar-store": { AvatarStore: { getAllAsync: async owner => { reads.push(owner); return avatars; } } },
    "@/lib/store/task-store": { TaskStore: { getAllAsync: async () => tasks } },
    "@/lib/server/public-data": publicData,
    "@/lib/server/digital-human-library": library,
    "@/lib/access-control": { ...mediaPolicy, resolveAccessContext: async () => context, unauthorizedResponse: () => NextResponse.json({ error: "请登录" }, { status: 401 }) },
  };
  const code = ts.transpileModule(fs.readFileSync(new URL("../src/app/api/digital-human/library/route.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", code)(name => {
    assert.ok(name in deps, `Unexpected dependency: ${name}`);
    return deps[name];
  }, module, module.exports);
  return {
    reads,
    setContext(value) { context = { ...context, ...value }; },
    get(values = {}) { return module.exports.GET(new NextRequest(`https://example.test/api/digital-human/library?${new URLSearchParams(values)}`)); },
  };
}

test("library route filters records, hidden selections and active tasks before pagination", async () => {
  const route = mockRoute();
  const response = await route.get({ limit: "1", avatarId: "foreign-avatar", taskId: "foreign-active" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const page = await response.json();
  assert.equal(page.items.length, 1);
  assert.deepEqual(page.counts, { all: 3, avatars: 1, tasks: 2 });
  assert.deepEqual(page.selection, {});
  assert.deepEqual(page.activeTasks.map(task => task.id), ["own-active"]);
  assert.doesNotMatch(JSON.stringify(page), /private\.example|D:\/private|hidden-provider-id|secret=hidden|userId/);
  const selected = await (await route.get({ kind: "tasks", avatarId: "own-avatar", taskId: "own-task" })).json();
  assert.equal(selected.selection.avatar.id, "own-avatar", "selection does not depend on current gallery kind/page");
  assert.equal(selected.selection.task.id, "own-task");
  assert.equal(selected.selection.avatar.canManage, true);
});

test("global media viewers see foreign avatars but not foreign tasks; admins keep original access", async () => {
  const route = mockRoute();
  route.setContext({ session: { user: { account: "11111111" } } });
  const shared = await (await route.get({ avatarId: "foreign-avatar", taskId: "foreign-active" })).json();
  assert.deepEqual(shared.counts, { all: 4, avatars: 2, tasks: 2 });
  assert.equal(shared.selection.avatar.canManage, false);
  assert.equal(shared.selection.task, undefined);
  assert.deepEqual(shared.activeTasks.map(task => task.id), ["own-active"]);
  route.setContext({ isAdmin: true });
  const admin = await (await route.get({ taskId: "foreign-active" })).json();
  assert.deepEqual(admin.counts, { all: 5, avatars: 2, tasks: 3 });
  assert.equal(admin.selection.task.id, "foreign-active");
  assert.deepEqual(admin.activeTasks.map(task => task.id), ["foreign-active", "own-active"]);
  assert.equal(route.reads.at(-1), "owner");
});

test("library route rejects unauthenticated and malformed requests before reading stores", async () => {
  const route = mockRoute();
  route.setContext({ userId: null, session: null });
  assert.equal((await route.get()).status, 401);
  assert.equal(route.reads.length, 0);
  route.setContext({ userId: "owner" });
  assert.equal((await route.get({ limit: "99" })).status, 400);
  assert.equal((await route.get({ cursor: "garbage" })).status, 400);
  assert.equal(route.reads.length, 0);
});
