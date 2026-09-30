import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { NextRequest } from "next/server.js";

if (!process.env.TEST_DATABASE_URL) {
  test("PostgreSQL account integration", { skip: "Set TEST_DATABASE_URL to a disposable PostgreSQL server" }, () => {});
} else {
const admin = new Client({ connectionString: process.env.TEST_DATABASE_URL });
await admin.connect();
const databaseName = `studio_test_${randomUUID().replaceAll("-", "")}`;
await admin.query(`CREATE DATABASE "${databaseName}"`);
const databaseUrl = new URL(process.env.TEST_DATABASE_URL);
databaseUrl.pathname = `/${databaseName}`;
process.env.AUTH_MODE = "standalone";
process.env.AUTH_DATABASE_URL = databaseUrl.toString();
const database = new Client({ connectionString: process.env.AUTH_DATABASE_URL });
await database.connect();
process.env.AUTH_PUBLIC_URL = "https://studio.test";
process.env.NODE_ENV = "production";
const auth = await import("../src/lib/server/standalone-auth.ts");
const { POST, GET } = await import("../src/app/api/auth/[action]/route.ts");
const { GET: sessionGET } = await import("../src/app/api/session/route.ts");
const { middleware } = await import("../src/middleware.ts");
const { resolveAccessContext, canAccessTask } = await import("../src/lib/access-control.ts");
const { isExternallyBilledUser } = await import("../src/lib/main-app-billing.ts");
test.after(async () => {
  await database.end();
  await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin.end();
});

function request(url, { cookie, body, origin = "https://studio.test" } = {}) {
  return new NextRequest(`https://studio.test${url}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { origin, "content-type": "application/json", ...(cookie ? { cookie: `${auth.AUTH_COOKIE}=${cookie}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const context = action => ({ params: Promise.resolve({ action }) });
const post = (action, body = {}, options = {}) => POST(request(`/api/auth/${action}`, { body, ...options }), context(action));
const tokenOf = response => response.cookies.get(auth.AUTH_COOKIE)?.value;
const signup = (email, extra = {}) => post("register", { email, nickname: "创作者", password: "correct horse 123", ...extra });

test("registration issues a secure session without exposing a token, hash, or admin role", async () => {
  const response = await signup("First@Example.com", { role: "admin", billingAudience: "internal" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true });
  const cookie = response.headers.get("set-cookie");
  for (const attribute of ["HttpOnly", "Secure", "SameSite=lax", "Expires="]) assert.ok(cookie.includes(attribute));
  const token = tokenOf(response);
  const session = await auth.readStandaloneSession(token);
  assert.equal(session.user.account, "first@example.com");
  assert.equal(session.user.role, "member");
  assert.equal(session.user.billingAudience, "standalone");
  assert.equal(isExternallyBilledUser(session.user), false);
  const data = await (await sessionGET(request("/api/session", { cookie: token }))).json();
  assert.equal(data.data.authMode, "standalone");
  assert.doesNotMatch(JSON.stringify(data), /password|token|hash|99999/);
  const { rows: [saved] } = await database.query("SELECT password FROM digital_human_auth.users WHERE email = 'first@example.com'");
  const { rows: sessions } = await database.query("SELECT hash FROM digital_human_auth.sessions");
  assert.notEqual(saved.password, "correct horse 123");
  assert.equal(sessions.some(s => s.hash === token), false);
});

test("duplicate normalized emails are rejected even with concurrent registration", async () => {
  const responses = await Promise.all([signup("collision@example.com"), signup("COLLISION@example.com")]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
});

test("password and input validation reject malformed requests", async () => {
  for (const data of [{ email: "bad" }, { password: "short" }, { password: "a".repeat(129) }, { nickname: "" }]) {
    assert.equal((await signup("invalid@example.com", data)).status, 400);
  }
  assert.equal((await post("login", { email: "invalid@example.com", password: "a".repeat(5000) })).status, 413);
});

test("login validates credentials and logout revokes the server-side session", async () => {
  await signup("logout@example.com");
  const bad = await post("login", { email: "logout@example.com", password: "wrong password" });
  const missing = await post("login", { email: "missing@example.com", password: "wrong password" });
  assert.equal(bad.status, 401);
  assert.deepEqual(await bad.json(), await missing.json());
  const good = await post("login", { email: "logout@example.com", password: "correct horse 123" });
  assert.equal(good.status, 200);
  const token = tokenOf(good);
  assert.ok(await auth.readStandaloneSession(token));
  assert.equal((await post("logout", {}, { cookie: token })).status, 200);
  assert.equal(await auth.readStandaloneSession(token), null);
});

test("cross-origin registration, login, logout and password changes are blocked", async () => {
  for (const action of ["register", "login", "logout", "password"]) {
    assert.equal((await post(action, {}, { origin: "https://attacker.test" })).status, 403);
    assert.equal((await post(action, {}, { origin: "null" })).status, 403);
  }
});

test("the configured desktop origin can register while unlisted origins remain blocked", async () => {
  process.env.AUTH_DESKTOP_URL = "https://desktop.studio.test";
  try {
    const response = await post("register", { email: "desktop-origin@example.com", nickname: "桌面验收", password: "correct horse 123" }, { origin: "https://desktop.studio.test" });
    assert.equal(response.status, 200);
    assert.equal((await post("login", {}, { origin: "https://unlisted.test" })).status, 403);
  } finally { delete process.env.AUTH_DESKTOP_URL; }
});

test("password change revokes all previous sessions and rejects the old password", async () => {
  const first = tokenOf(await signup("change@example.com"));
  const second = tokenOf(await post("login", { email: "change@example.com", password: "correct horse 123" }));
  const change = await post("password", { currentPassword: "correct horse 123", password: "new correct horse 456" }, { cookie: first });
  assert.equal(change.status, 200);
  assert.equal(await auth.readStandaloneSession(first), null);
  assert.equal(await auth.readStandaloneSession(second), null);
  assert.ok(await auth.readStandaloneSession(tokenOf(change)));
  assert.equal((await post("login", { email: "change@example.com", password: "correct horse 123" })).status, 401);
  assert.equal((await post("login", { email: "change@example.com", password: "new correct horse 456" })).status, 200);
});

test("sessions survive a new server process, and forged tokens fail", async () => {
  const token = tokenOf(await signup("persistent@example.com"));
  const child = spawnSync(process.execPath, ["--import", "./tests/helpers/register.mjs", "--input-type=module", "-e",
    "const {readStandaloneSession}=await import('./src/lib/server/standalone-auth.ts'); console.log((await readStandaloneSession(process.env.TEST_SESSION))?.user.account);"],
  { cwd: process.cwd(), env: { ...process.env, TEST_SESSION: token }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), "persistent@example.com");
  assert.equal(await auth.readStandaloneSession("a".repeat(43)), null);
  assert.equal(await auth.readStandaloneSession(token + "bad"), null);
});

test("expired sessions are denied", async () => {
  const token = tokenOf(await signup("expired@example.com"));
  const user = (await auth.readStandaloneSession(token)).user;
  await database.query("UPDATE digital_human_auth.sessions SET expires_at = 1 WHERE user_id = $1", [user.id]);
  assert.equal(await auth.readStandaloneSession(token), null);
});

test("standalone mode always isolates users and never calls SSO", async () => {
  const first = tokenOf(await signup("owner@example.com"));
  const second = tokenOf(await signup("other@example.com"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("SSO must not be called"); };
  try {
    const a = await resolveAccessContext(request("/api/tasks", { cookie: first }));
    const b = await resolveAccessContext(request("/api/tasks", { cookie: second }));
    assert.equal(a.isolated, true); assert.equal(a.isAdmin, false);
    assert.equal(canAccessTask(a, { userId: a.userId }), true);
    assert.equal(canAccessTask(b, { userId: a.userId }), false);
    assert.equal(canAccessTask(a, {}), false);
    assert.equal((await middleware(request("/api/tasks", { cookie: first }))).headers.get("x-middleware-next"), "1");
    assert.equal((await middleware(request("/api/tasks"))).status, 401);
    assert.equal((await middleware(request("/api/tasks.png"))).status, 401);
    assert.equal((await middleware(request("/api/sso/session"))).status, 404);
    const redirect = await middleware(request("/history"));
    assert.equal(new URL(redirect.headers.get("location")).pathname, "/login");
  } finally { globalThis.fetch = originalFetch; }
});

test("server discovery is public, but auth endpoints do not activate in SSO mode", async () => {
  const info = await GET(request("/api/auth/info"), context("info"));
  assert.equal((await info.json()).authMode, "standalone");
  process.env.AUTH_MODE = "sso";
  try { assert.equal((await signup("disabled@example.com")).status, 404); }
  finally { process.env.AUTH_MODE = "standalone"; }
});

test("authentication attempts are persistently rate limited", async () => {
  for (let i = 0; i < 3; i++) await auth.consumeAuthAttempt("test-limit", 3);
  await assert.rejects(() => auth.consumeAuthAttempt("test-limit", 3), error => error.status === 429);
});

test("hybrid mode accepts local accounts without calling SSO, while preserving the SSO branch", async () => {
  const token = tokenOf(await signup("hybrid@example.com"));
  process.env.AUTH_MODE = "hybrid";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Independent account must not call SSO"); };
  try {
    assert.equal((await GET(request("/api/auth/info"), context("info"))).status, 200);
    assert.equal((await middleware(request("/login"))).headers.get("x-middleware-next"), "1");
    assert.equal((await middleware(request("/api/tasks", { cookie: token }))).headers.get("x-middleware-next"), "1");
    assert.equal((await resolveAccessContext(request("/api/tasks", { cookie: token }))).session.user.billingAudience, "standalone");
    assert.equal((await middleware(request("/api/tasks", { cookie: "invalid" }))).status, 401);
    const { usesStandaloneAuth } = await import("../src/lib/auth-mode.ts");
    assert.equal(usesStandaloneAuth(false), false);
    assert.equal((await middleware(request("/api/sso/callback"))).headers.get("x-middleware-next"), "1");
  } finally { process.env.AUTH_MODE = "standalone"; globalThis.fetch = originalFetch; }
});

test("parallel database attempts cannot exceed the rate limit", async () => {
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => auth.consumeAuthAttempt("parallel-limit", 4)));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 4);
  assert.equal(results.filter(r => r.status === "rejected" && r.reason.status === 429).length, 16);
});
}
