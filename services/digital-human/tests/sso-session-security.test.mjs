// SSO 会话 cookie 的密码学与结构校验，以及主站回跳/跳转地址的安全约束。
import assert from "node:assert/strict";
import test from "node:test";

const sso = await import("../src/lib/main-app-sso.ts");

const ENV_KEYS = ["APP_SESSION_SECRET", "MAIN_APP_SSO_CLIENT_SECRET", "DISABLE_SSO", "MAIN_APP_URL", "PUBLIC_APP_URL"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

test.beforeEach(() => {
  process.env.APP_SESSION_SECRET = "unit-test-session-secret";
  process.env.MAIN_APP_SSO_CLIENT_SECRET = "unit-test-client-secret";
  delete process.env.DISABLE_SSO;
  delete process.env.MAIN_APP_URL;
  delete process.env.PUBLIC_APP_URL;
});
test.after(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function session(overrides = {}) {
  const now = Date.now();
  return {
    token: "main-site-token",
    user: { id: "user-1", account: "13800000000", nickname: "测试用户", role: "member" },
    expiresAt: now + 3_600_000,
    validatedAt: now,
    ...overrides,
  };
}

function tamper(cookie, segmentIndex, position = -1) {
  const parts = cookie.split(".");
  const segment = parts[segmentIndex];
  const index = position < 0 ? segment.length + position : position;
  const replacement = segment[index] === "A" ? "B" : "A";
  parts[segmentIndex] = `${segment.slice(0, index)}${replacement}${segment.slice(index + 1)}`;
  return parts.join(".");
}

test("cookie payload is opaque: no plaintext token, account or role is visible", async () => {
  const cookie = await sso.createMainAppSessionCookie(session());
  assert.match(cookie, /^v2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, "必须是 v2.<iv>.<ciphertext> 的 base64url 结构");
  assert.doesNotMatch(cookie, /main-site-token|13800000000|user-1|member/);
  assert.ok(!cookie.includes("="), "base64url 不应带填充符，避免 cookie 解析问题");
});

test("every encryption uses a fresh IV so identical sessions never produce identical cookies", async () => {
  const fixed = session();
  const a = await sso.createMainAppSessionCookie(fixed);
  const b = await sso.createMainAppSessionCookie(fixed);
  assert.notEqual(a, b);
  assert.notEqual(a.split(".")[1], b.split(".")[1]);
  assert.deepEqual(await sso.readMainAppSessionCookie(a), fixed);
  assert.deepEqual(await sso.readMainAppSessionCookie(b), fixed);
});

test("any bit-flip in the IV or ciphertext invalidates the cookie (AES-GCM authentication)", async () => {
  const cookie = await sso.createMainAppSessionCookie(session());
  assert.equal(await sso.readMainAppSessionCookie(tamper(cookie, 1)), null, "IV 被改");
  assert.equal(await sso.readMainAppSessionCookie(tamper(cookie, 2)), null, "密文末尾被改");
  assert.equal(await sso.readMainAppSessionCookie(tamper(cookie, 2, 0)), null, "密文开头被改");
  assert.equal(await sso.readMainAppSessionCookie(cookie.slice(0, -4)), null, "密文被截断");
  assert.equal(await sso.readMainAppSessionCookie(`${cookie}AAAA`), null, "密文被追加");
});

test("cookies issued under another secret or another format version are rejected", async () => {
  const cookie = await sso.createMainAppSessionCookie(session());
  process.env.APP_SESSION_SECRET = "rotated-secret";
  assert.equal(await sso.readMainAppSessionCookie(cookie), null, "密钥轮换后旧 cookie 必须失效");

  process.env.APP_SESSION_SECRET = "unit-test-session-secret";
  assert.ok(await sso.readMainAppSessionCookie(cookie), "恢复原密钥后应能再次读出会话");
  assert.equal(await sso.readMainAppSessionCookie(cookie.replace(/^v2\./, "v1.")), null);
  assert.equal(await sso.readMainAppSessionCookie(cookie.replace(/^v2\./, "")), null);
  assert.equal(await sso.readMainAppSessionCookie(`${cookie}.extra`), null);
  assert.equal(await sso.readMainAppSessionCookie("v2..x"), null);
  assert.equal(await sso.readMainAppSessionCookie("v2.!!!.@@@"), null);
  assert.equal(await sso.readMainAppSessionCookie(undefined), null);
  assert.equal(await sso.readMainAppSessionCookie(""), null);
});

test("a correctly encrypted cookie is still rejected when its claims are stale or malformed", async () => {
  const now = Date.now();
  const rejects = async (overrides, label) => {
    const cookie = await sso.createMainAppSessionCookie(session(overrides));
    assert.equal(await sso.readMainAppSessionCookie(cookie), null, label);
  };

  await rejects({ expiresAt: now - 1 }, "已过期");
  await rejects({ expiresAt: Number.POSITIVE_INFINITY }, "无限期");
  await rejects({ expiresAt: "9999999999999" }, "expiresAt 非数字");
  await rejects({ validatedAt: now + 5 * 60_000 }, "validatedAt 超出允许的时钟偏差");
  await rejects({ validatedAt: undefined }, "缺少 validatedAt");
  await rejects({ token: 123 }, "token 非字符串");
  await rejects({ user: { id: "u", account: "a", nickname: "n" } }, "缺少 role");
  await rejects({ user: { id: 1, account: "a", nickname: "n", role: "member" } }, "id 非字符串");
  await rejects({ user: null }, "缺少 user");

  const withinSkew = await sso.createMainAppSessionCookie(session({ validatedAt: now + 30_000 }));
  assert.ok(await sso.readMainAppSessionCookie(withinSkew), "60 秒内的时钟偏差应被容忍");
});

test("validation grace window is exactly bounded and independent of expiry", () => {
  const now = Date.now();
  assert.equal(sso.isMainAppSessionWithinValidationGrace(session({ validatedAt: now })), true);
  assert.equal(sso.isMainAppSessionWithinValidationGrace(session({ validatedAt: now - 5 * 60_000 + 1_000 })), true);
  assert.equal(sso.isMainAppSessionWithinValidationGrace(session({ validatedAt: now - 5 * 60_000 - 1_000 })), false);
  assert.equal(sso.isMainAppSessionWithinValidationGrace(session({ validatedAt: now - 24 * 3_600_000 })), false);
});

test("safeRedirectPath only allows same-origin absolute paths", () => {
  assert.equal(sso.safeRedirectPath("/history"), "/history");
  assert.equal(sso.safeRedirectPath("/history?tab=done#top"), "/history?tab=done#top");
  assert.equal(sso.safeRedirectPath("  /voices  "), "/voices");

  for (const bad of [
    "//evil.example.com/phish",
    "https://evil.example.com",
    "http://evil.example.com",
    "javascript:alert(1)",
    "history",
    "\\\\evil.example.com",
    "/\\evil.example.com/x",
    "/%5cevil.example.com/x",
    "/history\nSet-Cookie: bad=1",
    "",
    "   ",
    undefined,
    null,
    42,
    { path: "/x" },
  ]) {
    assert.equal(sso.safeRedirectPath(bad), "/", `必须回退到 /: ${String(bad)}`);
  }
});

test("main-site URLs come from configuration with safe fallbacks and no trailing slashes", () => {
  assert.equal(sso.getMainAppUrl(), "https://www.qycm.top");
  process.env.MAIN_APP_URL = "https://main.example.test///";
  assert.equal(sso.getMainAppUrl(), "https://main.example.test");

  const launch = new URL(sso.getMainAppSsoLaunchUrl());
  assert.equal(launch.origin, "https://main.example.test");
  assert.equal(launch.pathname, "/home2");
  assert.equal(launch.searchParams.get("externalSso"), "shuziren");

  assert.equal(sso.getPublicShuzirenAppUrl(), "https://shuziren.qycm.top");
  process.env.PUBLIC_APP_URL = "https://shuziren.example.test";
  assert.equal(sso.getPublicShuzirenAppUrl(), "https://shuziren.example.test");
});

test("session cookie attributes are hardened and the lifetime follows expiresAt", () => {
  const options = sso.getMainAppSessionCookieOptions(Date.now() + 90_000);
  assert.equal(options.httpOnly, true);
  assert.equal(options.secure, true);
  assert.equal(options.sameSite, "lax");
  assert.equal(options.path, "/");
  assert.ok(options.maxAge >= 88 && options.maxAge <= 90, `maxAge=${options.maxAge}`);

  assert.equal(sso.getMainAppSessionCookieOptions().maxAge, 0, "不带过期时间时用于清除 cookie");
  assert.equal(sso.getMainAppSessionCookieOptions(Date.now() - 10_000).maxAge, 0, "已过期不得产生负 maxAge");
  assert.equal(sso.getMainAppSessionCookieName(), "qycm_shuziren_sso_v2");
});

test("isSsoConfigured requires both secrets and honours the explicit kill switch", () => {
  assert.equal(sso.isSsoConfigured(), true);

  process.env.APP_SESSION_SECRET = "   ";
  assert.equal(sso.isSsoConfigured(), false, "空白密钥视为未配置");
  process.env.APP_SESSION_SECRET = "unit-test-session-secret";

  delete process.env.MAIN_APP_SSO_CLIENT_SECRET;
  assert.equal(sso.isSsoConfigured(), false);
  process.env.MAIN_APP_SSO_CLIENT_SECRET = "unit-test-client-secret";

  for (const value of ["true", "1"]) {
    process.env.DISABLE_SSO = value;
    assert.equal(sso.isSsoConfigured(), false, `DISABLE_SSO=${value}`);
  }
  for (const value of ["false", "0", "yes", ""]) {
    process.env.DISABLE_SSO = value;
    assert.equal(sso.isSsoConfigured(), true, `DISABLE_SSO=${value} 不应关闭 SSO`);
  }
});

test("SSO login intent binds the callback to the initiating browser and exact state", async () => {
  const intent = await sso.createMainAppSsoIntent();
  assert.match(intent.state, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(await sso.validateMainAppSsoIntent(intent.cookieValue, intent.state), true);
  assert.equal(await sso.validateMainAppSsoIntent(intent.cookieValue, `${intent.state}x`), false);
  assert.equal(await sso.validateMainAppSsoIntent(undefined, intent.state), false);
  assert.equal(await sso.validateMainAppSsoIntent(intent.cookieValue, undefined), false);
  assert.equal(sso.getMainAppSsoIntentCookieOptions(intent.expiresAt).httpOnly, true);
  assert.equal(sso.getMainAppSsoIntentCookieOptions(intent.expiresAt).path, "/api/sso/callback");
  const launch = new URL(sso.getMainAppSsoLaunchUrl(intent.state));
  assert.equal(launch.searchParams.get("state"), intent.state);
});
