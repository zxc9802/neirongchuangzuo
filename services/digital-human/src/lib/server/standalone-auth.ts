import "server-only";
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type { MainAppSession } from "../main-app-sso";

export const AUTH_COOKIE = "digital_human_session";
const SESSION_MS = 30 * 24 * 60 * 60_000;
const HASH_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
type UserRow = { id: string; email: string; nickname: string; password: string };
let pool: Pool | undefined;
let ready: Promise<void> | undefined;

async function db() {
  if (!pool) {
    if (!process.env.AUTH_DATABASE_URL) throw new Error("AUTH_DATABASE_URL is required");
    pool = new Pool({ connectionString: process.env.AUTH_DATABASE_URL, max: 5,
      connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, allowExitOnIdle: true });
    pool.on("error", () => console.error("[auth] Idle database connection failed"));
  }
  const database = pool;
  if (!ready) ready = (async () => {
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      // Serialize first startup across Next.js workers and deployment replicas.
      await client.query("SELECT pg_advisory_xact_lock(914281735)");
      await client.query(`
        CREATE SCHEMA IF NOT EXISTS digital_human_auth;
        CREATE TABLE IF NOT EXISTS digital_human_auth.users (
          id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, nickname TEXT NOT NULL,
          password TEXT NOT NULL, created_at BIGINT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS digital_human_auth.sessions (
          hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES digital_human_auth.users(id), expires_at BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS sessions_user ON digital_human_auth.sessions(user_id);
        CREATE TABLE IF NOT EXISTS digital_human_auth.attempts (
          bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at BIGINT NOT NULL
        );
      `);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  })().catch(error => { ready = undefined; throw error; });
  await ready;
  return database;
}

async function transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await (await db()).connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export class AuthError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

export function normalizeEmail(value: unknown): string {
  if (typeof value !== "string" || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
    throw new AuthError("请输入有效的邮箱地址");
  }
  return value.trim().toLowerCase();
}

function validatePassword(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 10 || value.length > 128) {
    throw new AuthError("密码需要 10–128 个字符");
  }
}

async function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, HASH_OPTIONS, (error, key) => error ? reject(error) : resolve(key));
  });
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${(await derive(password, salt)).toString("hex")}`;
}

async function matches(password: string, encoded?: string): Promise<boolean> {
  // Unknown accounts do the same expensive work as existing accounts.
  const [salt, digest] = (encoded || `${"0".repeat(32)}:${"0".repeat(128)}`).split(":");
  const actual = await derive(password, salt);
  return timingSafeEqual(actual, Buffer.from(digest, "hex")) && Boolean(encoded);
}

const digestToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function consumeAuthAttempt(bucket: string, limit: number): Promise<void> {
  const database = await db();
  const now = Date.now();
  await database.query("DELETE FROM digital_human_auth.attempts WHERE expires_at <= $1", [now]);
  const result = await database.query(`INSERT INTO digital_human_auth.attempts AS a VALUES ($1, 1, $2)
    ON CONFLICT(bucket) DO UPDATE SET count = a.count + 1 WHERE a.count < $3 RETURNING count`,
  [digestToken(bucket), now + 15 * 60_000, limit]);
  if (!result.rowCount) throw new AuthError("操作过于频繁，请 15 分钟后重试", 429);
}

async function issueSession(client: PoolClient, userId: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + SESSION_MS;
  await client.query("DELETE FROM digital_human_auth.sessions WHERE expires_at <= $1", [Date.now()]);
  await client.query("INSERT INTO digital_human_auth.sessions VALUES ($1, $2, $3)", [digestToken(token), userId, expiresAt]);
  return { token, expiresAt };
}

export async function registerAccount(email: string, nickname: unknown, password: unknown) {
  validatePassword(password);
  if (typeof nickname !== "string" || nickname.trim().length < 1 || nickname.trim().length > 30) {
    throw new AuthError("昵称需要 1–30 个字符");
  }
  const encoded = await hashPassword(password);
  try {
    return await transaction(async client => {
      const id = `account_${randomUUID()}`;
      await client.query("INSERT INTO digital_human_auth.users VALUES ($1, $2, $3, $4, $5)", [id, email, nickname.trim(), encoded, Date.now()]);
      return issueSession(client, id);
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new AuthError("这个邮箱已注册，请直接登录", 409);
    throw error;
  }
}

export async function loginAccount(email: string, password: unknown) {
  validatePassword(password);
  const { rows: [user] } = await (await db()).query<UserRow>("SELECT * FROM digital_human_auth.users WHERE email = $1", [email]);
  if (!await matches(password, user?.password)) throw new AuthError("邮箱或密码不正确", 401);
  return transaction(async client => {
    const result = await client.query("SELECT id FROM digital_human_auth.users WHERE id = $1 AND password = $2 FOR UPDATE", [user.id, user.password]);
    if (!result.rowCount) throw new AuthError("密码已变更，请重新登录", 401);
    return issueSession(client, user.id);
  });
}

export async function readStandaloneSession(token?: string): Promise<MainAppSession | null> {
  if (!token || !/^[\w-]{43}$/.test(token)) return null;
  const { rows: [row] } = await (await db()).query<UserRow & { expires_at: string }>(`
    SELECT u.*, s.expires_at FROM digital_human_auth.sessions s
    JOIN digital_human_auth.users u ON u.id = s.user_id WHERE hash = $1 AND expires_at > $2`,
  [digestToken(token), Date.now()]);
  if (!row) return null;
  return {
    // The opaque local token is never sent to a provider or returned in JSON.
    token: "", expiresAt: Number(row.expires_at), validatedAt: Date.now(),
    user: { id: row.id, account: row.email, nickname: row.nickname, role: "member", billingAudience: "standalone" },
  };
}

export async function revokeSession(token?: string): Promise<void> {
  if (token) await (await db()).query("DELETE FROM digital_human_auth.sessions WHERE hash = $1", [digestToken(token)]);
}

export async function changePassword(userId: string, current: unknown, next: unknown) {
  validatePassword(current);
  validatePassword(next);
  const { rows: [user] } = await (await db()).query<UserRow>("SELECT * FROM digital_human_auth.users WHERE id = $1", [userId]);
  if (!user || !await matches(current, user.password)) throw new AuthError("当前密码不正确", 400);
  const encoded = await hashPassword(next);
  return transaction(async client => {
    const result = await client.query("UPDATE digital_human_auth.users SET password = $1 WHERE id = $2 AND password = $3", [encoded, userId, user.password]);
    if (!result.rowCount) throw new AuthError("密码已变更，请重新登录", 401);
    await client.query("DELETE FROM digital_human_auth.sessions WHERE user_id = $1", [userId]);
    return issueSession(client, userId);
  });
}

export function standaloneCookieOptions(expiresAt?: number) {
  return { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production",
    path: "/", ...(expiresAt ? { expires: new Date(expiresAt) } : {}) };
}
