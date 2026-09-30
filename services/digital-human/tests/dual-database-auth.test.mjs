import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import { NextRequest } from "next/server.js";

if (!process.env.TEST_DATABASE_URL) {
  test("dual-database accounts", { skip: "Set TEST_DATABASE_URL to a disposable PostgreSQL server" }, () => {});
} else {
  const admin = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  const names = ["site", "internal"].map(kind => `auth_${kind}_${randomUUID().replaceAll("-", "")}`);
  for (const name of names) await admin.query(`CREATE DATABASE "${name}"`);
  const connection = name => { const url = new URL(process.env.TEST_DATABASE_URL); url.pathname = `/${name}`; return url.toString(); };
  process.env.AUTH_DATABASE_URL = connection(names[0]);
  process.env.INTERNAL_AUTH_DATABASE_URL = connection(names[1]);
  process.env.AUTH_MODE = "standalone";
  process.env.AUTH_PUBLIC_URL = "https://workspace.test";
  process.env.NODE_ENV = "production";
  const site = new Client({ connectionString: connection(names[0]) });
  const internal = new Client({ connectionString: connection(names[1]) });
  await site.connect(); await internal.connect();
  test.after(async () => {
    await site.end(); await internal.end();
    for (const name of names) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  });
  await internal.query(`CREATE TABLE public.users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, nickname TEXT NOT NULL,
    password_hash TEXT NOT NULL, billing_audience TEXT NOT NULL DEFAULT 'external',
    account_status TEXT NOT NULL DEFAULT 'active', is_verified BOOLEAN NOT NULL DEFAULT true,
    auth_token_version INTEGER NOT NULL DEFAULT 0, role TEXT NOT NULL DEFAULT 'member'
  )`);
  const password = "existing-password-123";
  const hash = await bcrypt.hash(password, 4);
  for (const [id, audience, status, verified] of [
    ["employee", "internal", "active", true], ["external", "external", "active", true],
    ["disabled", "internal", "disabled", true], ["pending", "internal", "active", false],
  ]) await internal.query("INSERT INTO users (id,email,nickname,password_hash,billing_audience,account_status,is_verified) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [id, `${id}@example.com`, id, hash, audience, status, verified]);
  await internal.query("INSERT INTO users (id,email,nickname,password_hash,billing_audience) VALUES ('short','staff9802','旧账号',$1,'internal')", [await bcrypt.hash("old123", 4)]);
  const auth = await import("../src/lib/server/standalone-auth.ts");
  const { POST } = await import("../src/app/api/auth/[action]/route.ts");
  const post = (action, body, token) => POST(new NextRequest(`https://workspace.test/api/auth/${action}`, {
    method: "POST", headers: { "content-type": "application/json", origin: "https://workspace.test", ...(token ? { cookie: `${auth.AUTH_COOKIE}=${token}` } : {}) }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ action }) });
  const login = (email = "employee@example.com", value = password) => post("login", { email, password: value });
  const register = email => post("register", { email, nickname: "新用户", password: "new-site-password-123" });
  const tokenOf = response => response.cookies.get(auth.AUTH_COOKIE)?.value;

  test("verified active internal users use the original bcrypt password and a session stored only in the new database", async () => {
    const response = await login();
    assert.equal(response.status, 200);
    const session = await auth.readStandaloneSession(tokenOf(response));
    assert.equal(session.user.account, "employee@example.com");
    assert.match(session.user.id, /^internal_/);
    assert.equal(session.user.role, "member");
    assert.equal(session.user.billingAudience, "standalone");
    assert.equal(session.user.authSource, "internal");
    assert.equal((await site.query("SELECT count(*)::int AS n FROM digital_human_auth.users")).rows[0].n, 0);
    assert.equal((await internal.query("SELECT count(*)::int AS n FROM users")).rows[0].n, 5);
    assert.doesNotMatch(JSON.stringify(session), /password_hash|existing-password|postgresql/);
  });

  test("internal plain accounts work with legacy short passwords and cannot be registered again", async () => {
    assert.equal((await post("login", { account: "STAFF9802", password: "old123" })).status, 200);
    assert.equal((await post("register", { account: "staff9802", password: "new-site-password-123" })).status, 409);
    assert.equal((await post("register", { email: "weak@example.com", nickname: "弱密码", password: "old123" })).status, 400);
  });

  test("external, disabled, unverified, unknown and incorrect-password users are denied", async () => {
    for (const email of ["external@example.com", "disabled@example.com", "pending@example.com", "missing@example.com"]) {
      const response = await login(email);
      assert.equal(response.status, 401, email);
      assert.deepEqual(await response.json(), { error: "账号或密码不正确" });
    }
    assert.equal((await login("employee@example.com", "wrong-password-123")).status, 401);
  });

  test("registrations are written only to the new database and cannot shadow an internal identity", async () => {
    assert.equal((await register("employee@example.com")).status, 409);
    assert.equal((await register("disabled@example.com")).status, 409);
    const response = await register("new-site@example.com");
    assert.equal(response.status, 200);
    const user = (await auth.readStandaloneSession(tokenOf(response))).user;
    assert.match(user.id, /^account_/);
    assert.equal((await site.query("SELECT count(*)::int AS n FROM digital_human_auth.users WHERE email='new-site@example.com'")).rows[0].n, 1);
    assert.equal((await internal.query("SELECT count(*)::int AS n FROM users WHERE email='new-site@example.com'")).rows[0].n, 0);
    // External accounts can register a separate local identity; their old password grants no access.
    assert.equal((await register("external@example.com")).status, 200);
    assert.equal((await login("external@example.com")).status, 401);
    assert.equal((await login("external@example.com", "new-site-password-123")).status, 200);
  });

  test("internal sessions revoke immediately after account, credential or audience changes", async () => {
    for (const [column, value] of [["account_status", "disabled"], ["billing_audience", "external"], ["is_verified", false], ["auth_token_version", 1], ["password_hash", await bcrypt.hash("changed-password-456", 4)]]) {
      const response = await login();
      assert.equal(response.status, 200);
      const token = tokenOf(response);
      await internal.query(`UPDATE users SET ${column}=$1 WHERE id='employee'`, [value]);
      assert.equal(await auth.readStandaloneSession(token), null, column);
      await internal.query("UPDATE users SET account_status='active',billing_audience='internal',is_verified=true,auth_token_version=0,password_hash=$1 WHERE id='employee'", [hash]);
      // Once rejected, a session must not revive when the old account is re-enabled.
      assert.equal(await auth.readStandaloneSession(token), null);
    }
  });

  test("internal logout is persistent and password changes never write to the original database", async () => {
    const response = await login();
    const token = tokenOf(response);
    const change = await post("password", { currentPassword: password, password: "changed-password-456" }, token);
    assert.equal(change.status, 403);
    assert.equal((await internal.query("SELECT password_hash FROM users WHERE id='employee'")).rows[0].password_hash, hash);
    assert.equal((await post("logout", {}, token)).status, 200);
    assert.equal(await auth.readStandaloneSession(token), null);
  });

  test("a missing internal database fails closed while existing new-site accounts still work", async () => {
    await internal.query("ALTER TABLE users RENAME TO unavailable_users");
    try {
      const response = await login();
      assert.equal(response.status, 503);
      assert.doesNotMatch(JSON.stringify(await response.json()), /postgresql|root|password_hash|unavailable_users/);
      assert.equal((await login("new-site@example.com", "new-site-password-123")).status, 200);
    } finally { await internal.query("ALTER TABLE unavailable_users RENAME TO users"); }
  });
}
