// 账号访问上下文的运行时行为：SSO 开/关、生产环境兜底、Cookie 篡改、任务归属判断。
import assert from "node:assert/strict";
import test from "node:test";

const access = await import("../src/lib/access-control.ts");
const sso = await import("../src/lib/main-app-sso.ts");

const COOKIE = sso.getMainAppSessionCookieName();
const originalFetch = globalThis.fetch;
const ENV_KEYS = ["MAIN_APP_SSO_CLIENT_SECRET", "APP_SESSION_SECRET", "DISABLE_SSO", "NODE_ENV"];

function snapshotEnv() {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  return () => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
}

function enableSso() {
  process.env.MAIN_APP_SSO_CLIENT_SECRET = "test-client-secret";
  process.env.APP_SESSION_SECRET = "test-session-secret";
  delete process.env.DISABLE_SSO;
}

function fakeRequest(cookieValue) {
  return {
    cookies: {
      get: (name) => (name === COOKIE && cookieValue !== undefined ? { value: cookieValue } : undefined),
    },
  };
}

async function sessionCookie(overrides = {}) {
  const now = Date.now();
  return sso.createMainAppSessionCookie({
    token: `token-${Math.random().toString(36).slice(2)}`,
    user: { id: "user-1", account: "13800000000", nickname: "测试用户", role: "member" },
    expiresAt: now + 60_000,
    validatedAt: now,
    ...overrides,
  });
}

test("SSO configured: valid cookie yields isolated context with user identity", async () => {
  const restore = snapshotEnv();
  try {
    enableSso();
    globalThis.fetch = async (_url, init) => {
      const token = new Headers(init?.headers).get("Authorization")?.replace(/^Bearer\s+/, "");
      const user = token === "admin-token"
        ? { id: "admin-1", account: "admin", nickname: "管理员", role: "admin" }
        : { id: "user-1", account: "13800000000", nickname: "测试用户", role: "member" };
      return Response.json({ success: true, data: { user } });
    };
    const ctx = await access.resolveAccessContext(fakeRequest(await sessionCookie({ token: "member-token" })));
    assert.equal(ctx.isolated, true);
    assert.equal(ctx.userId, "user-1");
    assert.equal(ctx.isAdmin, false);
    assert.equal(ctx.session?.user.account, "13800000000");

    const adminCookie = await sessionCookie({
      token: "admin-token",
      user: { id: "admin-1", account: "admin", nickname: "管理员", role: "admin" },
    });
    const adminCtx = await access.resolveAccessContext(fakeRequest(adminCookie));
    assert.equal(adminCtx.isAdmin, true);
    assert.equal(adminCtx.userId, "admin-1");
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("authoritative claims replace stale admin and internal-billing cookie claims", async () => {
  const restore = snapshotEnv();
  try {
    enableSso();
    globalThis.fetch = async () => Response.json({
      success: true,
      data: {
        user: {
          id: "user-1",
          account: "ordinary",
          nickname: "当前用户",
          role: "member",
          billingAudience: "external",
        },
      },
    });
    const cookie = await sessionCookie({
      token: "stale-admin-token",
      user: {
        id: "user-1",
        account: "11111111",
        nickname: "旧管理员",
        role: "admin",
        billingAudience: "internal",
      },
    });
    const ctx = await access.resolveAccessContext(fakeRequest(cookie));
    assert.equal(ctx.isAdmin, false);
    assert.equal(ctx.session?.user.account, "ordinary");
    assert.equal(ctx.session?.user.billingAudience, "external");
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("validation outage grace preserves ownership but strips admin, global-viewer and billing exemptions", async () => {
  const restore = snapshotEnv();
  try {
    enableSso();
    globalThis.fetch = async () => { throw new Error("main site unavailable"); };
    const cookie = await sessionCookie({
      token: "outage-admin-token",
      user: {
        id: "user-1",
        account: "11111111",
        nickname: "旧管理员",
        role: "admin",
        billingAudience: "internal",
      },
    });
    const ctx = await access.resolveAccessContext(fakeRequest(cookie));
    assert.equal(ctx.userId, "user-1");
    assert.equal(ctx.isAdmin, false);
    assert.equal(ctx.session?.user.account, "");
    assert.equal(ctx.session?.user.billingAudience, "external");
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("SSO configured: missing, tampered, foreign-secret or expired cookies all resolve to anonymous", async () => {
  const restore = snapshotEnv();
  try {
    enableSso();
    const expectAnonymous = async (cookieValue, label) => {
      const ctx = await access.resolveAccessContext(fakeRequest(cookieValue));
      assert.equal(ctx.isolated, true, `${label}: 必须处于隔离模式`);
      assert.equal(ctx.userId, null, `${label}: 不得解析出用户`);
      assert.equal(ctx.isAdmin, false, `${label}: 不得获得管理员权限`);
      assert.equal(ctx.session, null, `${label}: 不得保留会话`);
    };

    await expectAnonymous(undefined, "无 cookie");
    await expectAnonymous("", "空 cookie");
    await expectAnonymous("v2.garbage", "格式错误");

    const valid = await sessionCookie();
    const [version, iv, payload] = valid.split(".");
    const flipped = payload[payload.length - 1] === "A" ? "B" : "A";
    await expectAnonymous(`${version}.${iv}.${payload.slice(0, -1)}${flipped}`, "密文被篡改");
    await expectAnonymous(`${valid}.extra`, "多余段");

    await expectAnonymous(await sessionCookie({ expiresAt: Date.now() - 1 }), "已过期");
    await expectAnonymous(
      await sessionCookie({ validatedAt: Date.now() + 10 * 60_000 }),
      "validatedAt 超出时钟偏差"
    );

    process.env.APP_SESSION_SECRET = "another-secret";
    await expectAnonymous(valid, "会话密钥不一致");
  } finally {
    restore();
  }
});

test("SSO not configured: development stays open, production fails closed", async () => {
  const restore = snapshotEnv();
  try {
    delete process.env.MAIN_APP_SSO_CLIENT_SECRET;
    delete process.env.APP_SESSION_SECRET;

    process.env.NODE_ENV = "development";
    const dev = await access.resolveAccessContext(fakeRequest(undefined));
    assert.deepEqual(dev, { isolated: false, userId: null, isAdmin: true, session: null });

    process.env.NODE_ENV = "production";
    const prod = await access.resolveAccessContext(fakeRequest(undefined));
    assert.deepEqual(prod, { isolated: true, userId: null, isAdmin: false, session: null });
  } finally {
    restore();
  }
});

test("DISABLE_SSO switches off isolation even when secrets are present, but never in production", async () => {
  const restore = snapshotEnv();
  try {
    enableSso();
    process.env.DISABLE_SSO = "true";
    assert.equal(sso.isSsoConfigured(), false);

    process.env.NODE_ENV = "development";
    const dev = await access.resolveAccessContext(fakeRequest(undefined));
    assert.equal(dev.isolated, false);

    process.env.NODE_ENV = "production";
    const prod = await access.resolveAccessContext(fakeRequest(undefined));
    assert.equal(prod.isolated, true);
    assert.equal(prod.userId, null);
  } finally {
    restore();
  }
});

test("canAccessTask: owner-only in isolated mode, admins and single-user mode see everything", () => {
  const owner = { isolated: true, userId: "user-1", isAdmin: false, session: null };
  const other = { isolated: true, userId: "user-2", isAdmin: false, session: null };
  const admin = { isolated: true, userId: "admin", isAdmin: true, session: null };
  const anonymous = { isolated: true, userId: null, isAdmin: false, session: null };
  const local = { isolated: false, userId: null, isAdmin: true, session: null };
  const task = { userId: "user-1" };

  assert.equal(access.canAccessTask(owner, task), true);
  assert.equal(access.canAccessTask(other, task), false);
  assert.equal(access.canAccessTask(admin, task), true);
  assert.equal(access.canAccessTask(anonymous, task), false);
  assert.equal(access.canAccessTask(local, task), true);

  // 历史遗留的无归属任务：匿名与他人都不能访问，避免 undefined === undefined 放行
  assert.equal(access.canAccessTask(anonymous, { userId: undefined }), false);
  assert.equal(access.canAccessTask(owner, { userId: undefined }), false);
  assert.equal(access.canAccessTask(owner, { userId: null }), false);
});

test("canonical error responses do not leak resource existence or implementation details", async () => {
  const unauthorized = access.unauthorizedResponse();
  assert.equal(unauthorized.status, 401);
  const unauthorizedBody = await unauthorized.json();
  assert.equal(unauthorizedBody.code, "UNAUTHENTICATED");
  assert.match(unauthorizedBody.error, /登录/);

  const taskMissing = access.taskNotFoundResponse();
  const mediaMissing = access.mediaNotFoundResponse();
  assert.equal(taskMissing.status, 404);
  assert.equal(mediaMissing.status, 404);
  const taskBody = await taskMissing.json();
  const mediaBody = await mediaMissing.json();
  assert.deepEqual(Object.keys(taskBody), ["error"]);
  assert.deepEqual(Object.keys(mediaBody), ["error"]);
  assert.doesNotMatch(JSON.stringify([taskBody, mediaBody]), /heygen|pixverse|cos|user|owner/i);
});
