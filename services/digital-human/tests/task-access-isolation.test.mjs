import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (relativePath) =>
  readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

test("access-control denies anonymous requests when SSO is configured", async () => {
  const source = await read("src/lib/access-control.ts");

  assert.match(source, /isSsoConfigured\(\)/);
  assert.match(source, /isolated: true/);
  assert.match(source, /userId: null/);
  assert.match(source, /task\.userId === ctx\.userId/);
  assert.match(source, /status: 401/);
});

test("all task API routes enforce account isolation", async () => {
  const routes = [
    "src/app/api/tasks/route.ts",
    "src/app/api/tasks/[id]/route.ts",
    "src/app/api/tasks/[id]/stream/route.ts",
    "src/app/api/tasks/[id]/recover/route.ts",
    "src/app/api/tasks/[id]/download/[file]/route.ts",
  ];

  for (const route of routes) {
    const source = await read(route);
    assert.match(
      source,
      /resolveAccessContext\(req\)/,
      `${route} 必须解析账号上下文`
    );
    assert.match(
      source,
      /access\.isolated && !access\.userId/,
      `${route} 必须在 SSO 模式下拒绝未登录请求`
    );
    assert.match(
      source,
      /unauthorizedResponse\(\)/,
      `${route} 必须返回 401 未登录响应`
    );
  }
});

test("single task routes verify ownership and hide existence with 404", async () => {
  const routes = [
    "src/app/api/tasks/[id]/route.ts",
    "src/app/api/tasks/[id]/stream/route.ts",
    "src/app/api/tasks/[id]/recover/route.ts",
    "src/app/api/tasks/[id]/download/[file]/route.ts",
  ];

  for (const route of routes) {
    const source = await read(route);
    assert.match(
      source,
      /canAccessTask\(access,\s*task\)/,
      `${route} 必须校验任务归属`
    );
    assert.match(
      source,
      /taskNotFoundResponse\(\)/,
      `${route} 必须用 404 隐藏他人任务`
    );
  }
});

test("task list is filtered by owner and admins see all", async () => {
  const source = await read("src/app/api/tasks/route.ts");

  assert.match(source, /tasks\.filter\(\(task\) => task\.userId === access\.userId\)/);
  assert.match(source, /access\.isAdmin/);
});

test("task creation no longer trusts spoofable x-user-id fallback when SSO is on", async () => {
  const source = await read("src/app/api/tasks/route.ts");

  assert.match(
    source,
    /access\.isolated && !access\.session/,
    "SSO 模式下创建任务必须要求有效会话"
  );
  assert.doesNotMatch(
    source,
    /billingAudience: isSsoConfigured\(\) \? "external" : "internal"/,
    "不得在缺少会话时默认按外部计费用户创建任务"
  );
});
