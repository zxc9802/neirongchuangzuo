import { NextRequest, NextResponse } from "next/server";
import { supportsStandaloneAuth } from "@/lib/auth-mode";
import {
  AUTH_COOKIE, AuthError, changePassword, consumeAuthAttempt, loginAccount, normalizeEmail,
  readStandaloneSession, registerAccount, revokeSession, standaloneCookieOptions,
} from "@/lib/server/standalone-auth";
import { logServerError } from "@/lib/server/safe-log";

export const runtime = "nodejs";
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
type Context = { params: Promise<{ action: string }> };

export async function GET(_request: NextRequest, context: Context) {
  const { action } = await context.params;
  if (action !== "info" || !supportsStandaloneAuth()) return json({ error: "Not found" }, 404);
  return json({ authMode: "standalone", app: "digital-human-studio", version: 1 });
}

export async function POST(request: NextRequest, context: Context) {
  if (!supportsStandaloneAuth()) return json({ error: "Not found" }, 404);
  const { action } = await context.params;
  if (!["register", "login", "logout", "password"].includes(action)) return json({ error: "Not found" }, 404);
  try {
    // Require same-origin JSON, including on login and logout (login CSRF).
    const allowedOrigins = [process.env.AUTH_PUBLIC_URL || request.url, process.env.AUTH_DESKTOP_URL]
      .filter((url): url is string => Boolean(url)).map(url => new URL(url).origin);
    if (!allowedOrigins.includes(request.headers.get("origin") || "") || request.headers.get("sec-fetch-site") === "cross-site") {
      throw new AuthError("请求来源无效，请重新打开客户端", 403);
    }
    const cookie = request.cookies.get(AUTH_COOKIE)?.value;
    if (action === "logout") {
      await revokeSession(cookie);
      const response = json({ success: true });
      response.cookies.set(AUTH_COOKIE, "", { ...standaloneCookieOptions(), maxAge: 0 });
      return response;
    }
    if (!request.headers.get("content-type")?.startsWith("application/json")) throw new AuthError("请使用 JSON 请求", 415);
    // Bound the actual stream, not just the caller-controlled Content-Length.
    const reader = request.body?.getReader();
    if (!reader) throw new AuthError("请求内容为空");
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 4096) { await reader.cancel(); throw new AuthError("请求内容过长", 413); }
      chunks.push(value);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new AuthError("请求格式无效"); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new AuthError("请求格式无效");
    let session;
    if (action === "password") {
      const current = await readStandaloneSession(cookie);
      if (!current) throw new AuthError("请重新登录", 401);
      await consumeAuthAttempt(`password:${current.user.id}`, 10);
      session = await changePassword(current.user.id, body.currentPassword, body.password);
    } else {
      const email = normalizeEmail(body.email);
      await consumeAuthAttempt(`account:${email}`, 10);
      // A persistent global bound also covers random account names and forged proxy headers.
      await consumeAuthAttempt(`global:${action}`, action === "register" ? 30 : 300);
      session = action === "register"
        ? await registerAccount(email, body.nickname, body.password)
        : await loginAccount(email, body.password);
    }
    const response = json({ success: true });
    response.cookies.set(AUTH_COOKIE, session.token, standaloneCookieOptions(session.expiresAt));
    return response;
  } catch (error) {
    if (error instanceof AuthError) {
      const response = json({ error: error.message }, error.status);
      if (error.status === 429) response.headers.set("Retry-After", "900");
      return response;
    }
    logServerError("auth.request_failed", error);
    return json({ error: "账号服务暂时不可用，请稍后重试" }, 503);
  }
}
