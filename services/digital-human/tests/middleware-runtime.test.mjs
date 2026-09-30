// 中间件运行时行为：用真实的 NextRequest 驱动 middleware()，验证管理面关闭、
// 公开处理输入放行、SSO 各状态下的响应，以及不向浏览器泄露内部用户标识。
import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server.js";

const { middleware } = await import("../src/middleware.ts");
const sso = await import("../src/lib/main-app-sso.ts");

const COOKIE = sso.getMainAppSessionCookieName();
const ENV_KEYS = [
  "MAIN_APP_SSO_CLIENT_SECRET",
  "APP_SESSION_SECRET",
  "DISABLE_SSO",
  "NODE_ENV",
  "MAIN_APP_URL",
  "PUBLIC_APP_URL",
];

const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;

function resetEnv() {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

function enableSso() {
  process.env.MAIN_APP_SSO_CLIENT_SECRET = "test-client-secret";
  process.env.APP_SESSION_SECRET = "test-session-secret";
  process.env.MAIN_APP_URL = "https://main.example.test";
  process.env.NODE_ENV = "production";
  delete process.env.DISABLE_SSO;
}

function request(pathname, { cookie } = {}) {
  const headers = cookie ? { cookie: `${COOKIE}=${cookie}` } : undefined;
  return new NextRequest(`https://shuziren.example.test${pathname}`, { headers });
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

function mockMainSite(status) {
  globalThis.fetch = async () => {
    if (status === "down") throw new Error("simulated network failure");
    return Response.json(
      {
        success: status === 200,
        data: status === 200
          ? { user: { id: "user-1", account: "13800000000", nickname: "测试用户", role: "member" } }
          : undefined,
      },
      { status },
    );
  };
}

const isPassThrough = (response) => response.headers.get("x-middleware-next") === "1";
const clearsCookie = (response) => {
  const setCookie = response.headers.get("set-cookie") || "";
  return setCookie.includes(`${COOKIE}=;`) && /max-age=0/i.test(setCookie);
};

test.beforeEach(() => {
  console.error = () => {};
});
test.afterEach(() => {
  resetEnv();
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
});

test("management surfaces return 404 regardless of authentication state", async () => {
  enableSso();
  mockMainSite(200);
  const cookie = await sessionCookie();

  for (const pathname of [
    "/settings",
    "/settings/anything",
    "/mcp",
    "/mcp/tools",
    "/api/settings",
    "/api/mcp/tools",
    "/api/mcp/heygen/oauth/start",
    "/api/cos/test",
  ]) {
    const anonymous = await middleware(request(pathname));
    assert.equal(anonymous.status, 404, `${pathname} 匿名访问必须 404`);
    const authenticated = await middleware(request(pathname, { cookie }));
    assert.equal(authenticated.status, 404, `${pathname} 登录后也必须 404`);
    assert.equal(isPassThrough(authenticated), false);
  }
});

test("only provider-facing processing inputs under /jobs are public; everything else under /jobs and /uploads is closed", async () => {
  enableSso();
  const token = "a".repeat(48);

  for (const pathname of [
    `/jobs/input/${token}/source-video.mp4`,
    `/jobs/input/${token}/voice-track.wav`,
    `/jobs/input/${token}/speaker-reference.mp3`,
  ]) {
    assert.equal(isPassThrough(await middleware(request(pathname))), true, pathname);
  }

  for (const pathname of [
    "/jobs/task_1790000000000_abcde/final.mp4",
    "/jobs/task_1790000000000_abcde/production-report.json",
    "/jobs/task_1790000000000_abcde/evidence.json",
    "/jobs/task_1790000000000_abcde/heygen-source-video.mp4",
    "/jobs/task_1790000000000_abcde/raw-indextts.wav",
    "/jobs/a/b/source-video.mp4",
    `/jobs/input/${"b".repeat(47)}/source-video.mp4`,
    `/jobs/input/${token}/final.mp4`,
    "/jobs/source-video.mp4",
    "/uploads/users/user-1/videos/1.mp4",
    "/uploads/1787730566551_x.mp4",
  ]) {
    const response = await middleware(request(pathname));
    assert.equal(response.status, 404, `${pathname} 必须 404`);
    assert.equal(isPassThrough(response), false, pathname);
  }
});

test("production without SSO secrets fails closed with 503 instead of opening the app", async () => {
  delete process.env.MAIN_APP_SSO_CLIENT_SECRET;
  delete process.env.APP_SESSION_SECRET;
  process.env.NODE_ENV = "production";

  const api = await middleware(request("/api/tasks"));
  assert.equal(api.status, 503);
  assert.equal(api.headers.get("cache-control"), "no-store");
  assert.match((await api.json()).error, /not configured/i);

  const page = await middleware(request("/"));
  assert.equal(page.status, 503);
  assert.equal(isPassThrough(page), false);
});

test("development without SSO secrets passes through (single-user mode)", async () => {
  delete process.env.MAIN_APP_SSO_CLIENT_SECRET;
  delete process.env.APP_SESSION_SECRET;
  process.env.NODE_ENV = "development";

  assert.equal(isPassThrough(await middleware(request("/api/tasks"))), true);
  assert.equal(isPassThrough(await middleware(request("/"))), true);
});

test("SSO callback and static assets are reachable without a session", async () => {
  enableSso();
  for (const pathname of [
    "/api/sso/callback?ticket=abc",
    "/_next/static/chunks/main.js",
    "/favicon.ico",
    "/logo.svg",
    "/cover.png",
  ]) {
    assert.equal(isPassThrough(await middleware(request(pathname))), true, pathname);
  }
});

test("anonymous API requests get 401 and the stale cookie is cleared; pages redirect to the main site", async () => {
  enableSso();

  const api = await middleware(request("/api/tasks"));
  assert.equal(api.status, 401);
  assert.ok(clearsCookie(api), "401 响应必须清除会话 cookie");

  const page = await middleware(request("/history"));
  assert.equal(page.status, 307);
  const location = new URL(page.headers.get("location"));
  assert.equal(location.origin, "https://main.example.test");
  assert.equal(location.pathname, "/home2");
  assert.equal(location.searchParams.get("externalSso"), "shuziren");
  assert.ok(clearsCookie(page));
});

test("a forged or tampered cookie is treated exactly like no cookie", async () => {
  enableSso();
  mockMainSite(200);

  const valid = await sessionCookie();
  const [version, iv, payload] = valid.split(".");
  const payloadBytes = Buffer.from(payload, "base64url");
  payloadBytes[Math.floor(payloadBytes.length / 2)] ^= 0x01;
  const tampered = `${version}.${iv}.${payloadBytes.toString("base64url")}`;

  const api = await middleware(request("/api/tasks", { cookie: tampered }));
  assert.equal(api.status, 401);
  assert.ok(clearsCookie(api));

  const page = await middleware(request("/", { cookie: tampered }));
  assert.equal(page.status, 307);
});

test("a valid session confirmed by the main site passes through", async () => {
  enableSso();
  mockMainSite(200);

  const response = await middleware(request("/api/tasks", { cookie: await sessionCookie() }));
  assert.equal(isPassThrough(response), true);
  assert.equal(clearsCookie(response), false, "有效会话不得被清除");
});

test("a session rejected by the main site is logged out even if the cookie itself decrypts", async () => {
  enableSso();
  mockMainSite(401);

  const response = await middleware(request("/api/tasks", { cookie: await sessionCookie() }));
  assert.equal(response.status, 401);
  assert.ok(clearsCookie(response));
});

test("main-site outage: fresh sessions get grace, stale sessions get 503 without losing the cookie", async () => {
  enableSso();
  mockMainSite("down");

  const fresh = await middleware(request("/api/tasks", { cookie: await sessionCookie() }));
  assert.equal(isPassThrough(fresh), true);
  assert.equal(fresh.headers.get("x-sso-validation"), "grace");

  const staleCookie = await sessionCookie({ validatedAt: Date.now() - 6 * 60_000 });
  const staleApi = await middleware(request("/api/tasks", { cookie: staleCookie }));
  assert.equal(staleApi.status, 503);
  assert.equal(staleApi.headers.get("retry-after"), "3");
  assert.equal(clearsCookie(staleApi), false, "主站不可用时不得清 cookie，否则形成登录循环");

  const stalePage = await middleware(request("/", { cookie: staleCookie }));
  assert.equal(stalePage.status, 503);
  assert.match(stalePage.headers.get("content-type"), /text\/html/);
  assert.equal(clearsCookie(stalePage), false);
});

test("middleware never writes internal user identifiers into browser-visible response headers", async () => {
  enableSso();
  mockMainSite(200);
  const cookie = await sessionCookie();

  for (const pathname of ["/api/tasks", "/", "/history"]) {
    const response = await middleware(request(pathname, { cookie }));
    assert.equal(isPassThrough(response), true, pathname);
    assert.equal(
      response.headers.get("x-user-id"),
      null,
      `${pathname}: NextResponse.next() 上的 headers 是响应头，会原样发回浏览器`
    );
    assert.equal(response.headers.get("x-user-account"), null, pathname);
  }
});
