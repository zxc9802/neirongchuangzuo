import { logServerError } from "./server/safe-log";

const PRODUCT = "shuziren";
const COOKIE_NAME = "qycm_shuziren_sso_v2";
const INTENT_COOKIE_NAME = "qycm_shuziren_sso_intent_v1";
const MAIN_APP_URL_FALLBACK = "https://www.qycm.top";
const PUBLIC_SHUZIREN_APP_URL = "https://shuziren.qycm.top";
const SSO_EXCHANGE_TIMEOUT_MS = 30_000;
const SSO_SESSION_VALIDATION_TIMEOUT_MS = 20_000;
const SESSION_VALIDATION_GRACE_MS = 5 * 60_000;
const SESSION_CLOCK_SKEW_MS = 60_000;
const SSO_INTENT_TTL_MS = 10 * 60_000;

export type MainAppUser = {
  id: string;
  account: string;
  nickname: string;
  role: string;
  groupName?: string;
  billingAudience?: string;
  pointsBalance?: number;
  avatar?: string;
  createdAt?: string;
};

export type MainAppSession = {
  token: string;
  user: MainAppUser;
  expiresAt: number;
  validatedAt: number;
};

export type MainAppSessionValidationResult =
  | "valid"
  | "invalid"
  | "unavailable";

export type MainAppSessionValidationDetails =
  | { status: "valid"; session: MainAppSession }
  | { status: "invalid"; session: null }
  | { status: "unavailable"; session: null };

type MainAppSsoIntent = {
  state: string;
  expiresAt: number;
};

type ExchangeResponse = {
  success?: boolean;
  data?: {
    token?: unknown;
    redirectPath?: unknown;
    user?: unknown;
    expiresAt?: unknown;
  };
};

export function isSsoConfigured(): boolean {
  if (process.env.DISABLE_SSO === "true" || process.env.DISABLE_SSO === "1") {
    return false;
  }
  return Boolean(
    process.env.MAIN_APP_SSO_CLIENT_SECRET?.trim() &&
    process.env.APP_SESSION_SECRET?.trim()
  );
}

function base64UrlEncode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array | null {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
    const binary = atob(padded);
    const decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return base64UrlEncode(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.slice().buffer as ArrayBuffer;
}

async function sessionKey(): Promise<CryptoKey> {
  const secret = process.env.APP_SESSION_SECRET?.trim() || "default_shuziren_session_secret_key_32bytes_len";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

function isMainAppUser(value: unknown): value is MainAppUser {
  if (!value || typeof value !== "object") return false;
  const user = value as Record<string, unknown>;
  return ["id", "account", "nickname", "role"].every(
    (key) => typeof user[key] === "string",
  );
}

function isMainAppSession(value: unknown): value is MainAppSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Record<string, unknown>;
  return (
    typeof session.token === "string" &&
    isMainAppUser(session.user) &&
    typeof session.expiresAt === "number" &&
    Number.isFinite(session.expiresAt) &&
    session.expiresAt > Date.now() &&
    typeof session.validatedAt === "number" &&
    Number.isFinite(session.validatedAt) &&
    session.validatedAt <= Date.now() + SESSION_CLOCK_SKEW_MS
  );
}

function isFutureExpiration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > Date.now();
}

export function isMainAppSessionWithinValidationGrace(
  session: MainAppSession,
): boolean {
  return Date.now() - session.validatedAt <= SESSION_VALIDATION_GRACE_MS;
}

export function getMainAppUrl(): string {
  return (process.env.MAIN_APP_URL?.trim() || MAIN_APP_URL_FALLBACK).replace(
    /\/+$/,
    "",
  );
}

export function getPublicShuzirenAppUrl(): string {
  return process.env.PUBLIC_APP_URL?.trim() || PUBLIC_SHUZIREN_APP_URL;
}

export function getMainAppSsoLaunchUrl(state?: string): string {
  const url = new URL("/home2", getMainAppUrl());
  url.searchParams.set("externalSso", PRODUCT);
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

export function getMainAppSessionCookieName(): string {
  return COOKIE_NAME;
}

export function getMainAppSsoIntentCookieName(): string {
  return INTENT_COOKIE_NAME;
}

export function getMainAppSsoIntentCookieOptions(expiresAt?: number) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/api/sso/callback",
    maxAge: expiresAt
      ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
      : 0,
  };
}

export function getMainAppSessionCookieOptions(expiresAt?: number) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: expiresAt
      ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
      : 0,
  };
}

export function safeRedirectPath(value: unknown): string {
  if (typeof value !== "string") return "/";
  const redirectPath = value.trim();
  if (
    !redirectPath ||
    !redirectPath.startsWith("/") ||
    redirectPath.startsWith("//") ||
    redirectPath.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(redirectPath)
  ) {
    return "/";
  }
  try {
    const parsed = new URL(redirectPath, "https://local.invalid");
    if (
      parsed.origin !== "https://local.invalid" ||
      decodeURIComponent(parsed.pathname).includes("\\")
    ) {
      return "/";
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/";
  }
}

export async function createMainAppSessionCookie(
  session: MainAppSession,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    await sessionKey(),
    toArrayBuffer(new TextEncoder().encode(JSON.stringify(session))),
  );
  return `v2.${base64UrlEncode(iv)}.${base64UrlEncode(
    new Uint8Array(encrypted),
  )}`;
}

async function sealIntent(intent: MainAppSsoIntent): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    await sessionKey(),
    toArrayBuffer(new TextEncoder().encode(JSON.stringify(intent))),
  );
  return `i1.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(encrypted))}`;
}

export async function createMainAppSsoIntent(): Promise<{
  state: string;
  cookieValue: string;
  expiresAt: number;
}> {
  const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = Date.now() + SSO_INTENT_TTL_MS;
  return {
    state,
    expiresAt,
    cookieValue: await sealIntent({ state, expiresAt }),
  };
}

export async function validateMainAppSsoIntent(
  value: string | undefined,
  returnedState: string | undefined,
): Promise<boolean> {
  if (!value || !returnedState) return false;
  const [version, ivValue, encryptedValue, extra] = value.split(".");
  if (version !== "i1" || !ivValue || !encryptedValue || extra) return false;
  const iv = base64UrlDecode(ivValue);
  const encrypted = base64UrlDecode(encryptedValue);
  if (!iv || !encrypted) return false;
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      await sessionKey(),
      toArrayBuffer(encrypted),
    );
    const intent = JSON.parse(new TextDecoder().decode(decrypted)) as MainAppSsoIntent;
    if (
      typeof intent.state !== "string" ||
      typeof intent.expiresAt !== "number" ||
      !Number.isFinite(intent.expiresAt) ||
      intent.expiresAt <= Date.now()
    ) return false;
    const expected = new TextEncoder().encode(intent.state);
    const actual = new TextEncoder().encode(returnedState);
    if (expected.byteLength !== actual.byteLength) return false;
    let difference = 0;
    for (let index = 0; index < expected.byteLength; index += 1) {
      difference |= expected[index] ^ actual[index];
    }
    return difference === 0;
  } catch {
    return false;
  }
}

export async function readMainAppSessionCookie(
  value: string | undefined,
): Promise<MainAppSession | null> {
  if (!value) return null;
  const [version, ivValue, encryptedValue, extra] = value.split(".");
  if (version !== "v2" || !ivValue || !encryptedValue || extra) return null;
  const iv = base64UrlDecode(ivValue);
  const encrypted = base64UrlDecode(encryptedValue);
  if (!iv || !encrypted) return null;

  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      await sessionKey(),
      toArrayBuffer(encrypted),
    );
    const session = JSON.parse(new TextDecoder().decode(decrypted));
    return isMainAppSession(session) ? session : null;
  } catch {
    return null;
  }
}

export async function exchangeMainAppSsoTicket(
  ticket: string,
): Promise<{ redirectPath: string; session: MainAppSession }> {
  const exchangeUrl =
    process.env.MAIN_APP_SSO_EXCHANGE_URL?.trim() ||
    `${getMainAppUrl()}/api/external-sso/${PRODUCT}/exchange`;

  const clientSecret = process.env.MAIN_APP_SSO_CLIENT_SECRET?.trim();
  if (!clientSecret) {
    throw new Error("MAIN_APP_SSO_CLIENT_SECRET is not configured.");
  }

  const response = await fetch(exchangeUrl, {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "x-qycm-sso-client-secret": clientSecret,
    },
    body: JSON.stringify({ ticket }),
    signal: AbortSignal.timeout(SSO_EXCHANGE_TIMEOUT_MS),
  });

  const payload = (await response
    .json()
    .catch(() => ({}))) as ExchangeResponse;
  const token = payload.data?.token;
  const user = payload.data?.user;
  const expiresAt = payload.data?.expiresAt;

  if (
    !response.ok ||
    !payload.success ||
    typeof token !== "string" ||
    !isMainAppUser(user) ||
    !isFutureExpiration(expiresAt)
  ) {
    throw new Error("Main-site SSO exchange was rejected.");
  }

  return {
    redirectPath: safeRedirectPath(payload.data?.redirectPath),
    session: {
      token,
      user,
      expiresAt,
      validatedAt: Date.now(),
    },
  };
}

export async function validateMainAppSessionDetails(
  session: MainAppSession,
): Promise<MainAppSessionValidationDetails> {
  const probeUrl = `${getMainAppUrl()}/api/sso/session`;
  try {
    const response = await fetch(probeUrl, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${session.token}` },
      signal: AbortSignal.timeout(SSO_SESSION_VALIDATION_TIMEOUT_MS),
    });
    if (response.ok) {
      const payload = await response.json().catch(() => null);
      const user = payload?.data?.user;
      if (payload?.success !== true || !isMainAppUser(user)) {
        logServerError("sso.invalid_claims");
        return { status: "invalid", session: null };
      }
      const refreshedSession: MainAppSession = {
        ...session,
        user,
        validatedAt: Date.now(),
      };
      return { status: "valid", session: refreshedSession };
    }
    if (response.status === 401 || response.status === 403) {
      logServerError("sso.session_rejected", { status: response.status });
      return { status: "invalid", session: null };
    }

    logServerError("sso.session_unavailable", { status: response.status });
    return { status: "unavailable", session: null };
  } catch (err: any) {
    // 出网失败 / DNS / 超时不等于凭证失效，调用方必须避免清 Cookie 重登。
    logServerError("sso.session_request_failed", err);
    return { status: "unavailable", session: null };
  }
}

export async function validateMainAppSession(
  session: MainAppSession,
): Promise<MainAppSessionValidationResult> {
  return (await validateMainAppSessionDetails(session)).status;
}

export function createRestrictedGraceSession(
  session: MainAppSession,
): MainAppSession {
  return {
    ...session,
    user: {
      id: session.user.id,
      account: "",
      nickname: session.user.nickname,
      role: "member",
      billingAudience: "external",
    },
  };
}

export async function fetchMainAppUserProfile(
  token: string,
): Promise<Partial<MainAppUser> | null> {
  try {
    const response = await fetch(`${getMainAppUrl()}/api/sso/session`, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(SSO_SESSION_VALIDATION_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    return isMainAppUser(payload?.data?.user) ? payload.data.user : null;
  } catch {
    return null;
  }
}
