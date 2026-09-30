import "server-only";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import bcrypt from "bcryptjs";

type InternalAccount = {
  id: string; email: string; nickname: string; password_hash: string;
  billing_audience: string; account_status: string; is_verified: boolean; auth_token_version: number;
};
let pool: Pool | undefined;

function database() {
  if (!process.env.INTERNAL_AUTH_DATABASE_URL) return null;
  if (!pool) {
    pool = new Pool({ connectionString: process.env.INTERNAL_AUTH_DATABASE_URL, max: 5,
      connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 5000,
      allowExitOnIdle: true, options: "-c default_transaction_read_only=on" });
    pool.on("error", () => console.error("[auth] Internal account database connection failed"));
  }
  return pool;
}

async function findAccount(column: "email" | "id", value: string): Promise<InternalAccount | null> {
  const db = database();
  if (!db) return null;
  const comparison = column === "email" ? "lower(email)" : "id";
  const { rows } = await db.query<InternalAccount>(`SELECT id,email,nickname,password_hash,billing_audience,
    account_status,is_verified,auth_token_version FROM public.users WHERE ${comparison}=$1`, [value]);
  // Ambiguous case-insensitive matches must never select an arbitrary identity.
  return rows.length === 1 ? rows[0] : null;
}

const allowed = (user: InternalAccount) => user.billing_audience === "internal" && user.account_status === "active" && user.is_verified;
export const internalRevision = (user: InternalAccount) => createHash("sha256")
  .update(`${user.auth_token_version}:${user.password_hash}`).digest("hex");
export const internalIdentity = (id: string) => `internal_${createHash("sha256").update(id).digest("hex")}`;

export async function internalAccountExists(email: string): Promise<boolean> {
  const db = database();
  if (!db) return false;
  const result = await db.query("SELECT 1 FROM public.users WHERE lower(email)=$1 AND billing_audience='internal' LIMIT 1", [email]);
  return Boolean(result.rowCount);
}

export async function authenticateInternal(email: string, password: string) {
  const user = await findAccount("email", email);
  if (!user || !allowed(user) || !/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(user.password_hash)) return null;
  if (!await bcrypt.compare(password, user.password_hash)) return null;
  // Re-read after password verification so a concurrent disable/password change wins.
  return validateInternalAccount(user.id, internalRevision(user));
}

export async function validateInternalAccount(id: string, revision: string) {
  const user = await findAccount("id", id);
  return user && allowed(user) && internalRevision(user) === revision ? user : null;
}
