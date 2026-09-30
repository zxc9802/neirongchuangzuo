import { NextResponse, type NextRequest } from "next/server";
import { isStandaloneAuth, supportsStandaloneAuth, usesStandaloneAuth } from "@/lib/auth-mode";
import { AUTH_COOKIE, readStandaloneSession } from "@/lib/server/standalone-auth";
import {
  getMainAppSessionCookieName,
  getMainAppSessionCookieOptions,
  getMainAppSsoLaunchUrl,
  createMainAppSessionCookie,
  createMainAppSsoIntent,
  getMainAppSsoIntentCookieName,
  getMainAppSsoIntentCookieOptions,
  isMainAppSessionWithinValidationGrace,
  readMainAppSessionCookie,
  validateMainAppSessionDetails,
  isSsoConfigured,
} from "@/lib/main-app-sso";

export const runtime = "nodejs";

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  if (
    pathname === "/settings" ||
    pathname.startsWith("/settings/") ||
    pathname === "/mcp" ||
    pathname.startsWith("/mcp/") ||
    pathname === "/api/settings" ||
    pathname.startsWith("/api/mcp/") ||
    pathname === "/api/cos/test"
  ) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const isPublicProcessingInput = /^\/jobs\/input\/[a-f0-9]{48}\/(?:source-video\.mp4|voice-track\.wav|speaker-reference\.(?:mp3|wav|m4a)|emotion-reference\.wav)$/.test(pathname);

  if (pathname.startsWith("/jobs/") || pathname.startsWith("/uploads/")) {
    return isPublicProcessingInput
      ? NextResponse.next()
      : NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (supportsStandaloneAuth() && (pathname === "/login" || pathname === "/register" || pathname.startsWith("/api/auth/"))) {
    return NextResponse.next();
  }

  if (usesStandaloneAuth(Boolean(request.cookies.get(AUTH_COOKIE)))) {
    if (isStandaloneAuth() && pathname.startsWith("/api/sso/")) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (pathname === "/login" || pathname === "/register" || pathname.startsWith("/api/auth/") ||
      pathname.startsWith("/_next/") || pathname === "/favicon.ico") return NextResponse.next();
    try {
      if (await readStandaloneSession(request.cookies.get(AUTH_COOKIE)?.value)) return NextResponse.next();
    } catch {
      return NextResponse.json({ error: "账号服务暂时不可用" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "请先登录", code: "UNAUTHENTICATED" }, {
      status: 401, headers: { "Cache-Control": "no-store" },
    });
    const login = new URL("/login", request.url);
    login.searchParams.set("next", pathname + request.nextUrl.search);
    return NextResponse.redirect(login);
  }

  // 1. Whitelist static files, SSO callback, and public endpoints
  if (
    pathname === "/api/sso/callback" ||
    pathname === "/api/sso/diagnose" ||
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico" ||
    pathname.endsWith(".svg") ||
    pathname.endsWith(".png") ||
    pathname.endsWith(".jpg") ||
    pathname.endsWith(".ico")
  ) {
    return NextResponse.next();
  }

  // 2. If SSO is not enabled/configured (e.g. local dev mode without secrets), allow through
  if (!isSsoConfigured()) {
    if (process.env.NODE_ENV === "production") {
      return request.nextUrl.pathname.startsWith("/api/")
        ? NextResponse.json(
            { error: "Authentication service is not configured." },
            { status: 503, headers: { "Cache-Control": "no-store" } }
          )
        : new NextResponse("Authentication service is not configured.", {
            status: 503,
            headers: { "Cache-Control": "no-store" },
          });
    }
    return NextResponse.next();
  }

  // 3. Check SSO session
  const cookieValue = request.cookies.get(getMainAppSessionCookieName())?.value;
  const session = await readMainAppSessionCookie(cookieValue);
  if (cookieValue && !session) {
    console.error("[SSO] Local session cookie could not be decrypted or was expired.");
  }
  const validation = session
    ? await validateMainAppSessionDetails(session)
    : { status: "invalid" as const, session: null };
  const sessionValidation = validation.status;

  if (session && validation.status === "valid") {
    const response = NextResponse.next();
    response.cookies.set(
      getMainAppSessionCookieName(),
      await createMainAppSessionCookie(validation.session),
      getMainAppSessionCookieOptions(validation.session.expiresAt),
    );
    return response;
  }

  // 4. Main site temporarily unavailable
  if (sessionValidation === "unavailable") {
    if (session && isMainAppSessionWithinValidationGrace(session)) {
      const response = NextResponse.next();
      response.headers.set("x-sso-validation", "grace");
      return response;
    }

    if (request.nextUrl.pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Main site is temporarily unavailable. Please retry shortly." },
        {
          status: 503,
          headers: { "Retry-After": "3", "Cache-Control": "no-store" },
        },
      );
    }

    return new NextResponse(
      `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>主站暂时不可用</title><body><h1>主站暂时不可用</h1><p>登录状态已保留，请稍后刷新页面。</p></body></html>`,
      {
        status: 503,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Retry-After": "3",
          "Cache-Control": "no-store",
        },
      },
    );
  }

  // 5. Session invalid or missing
  if (request.nextUrl.pathname.startsWith("/api/")) {
    const response = NextResponse.json(
      { error: "Main-site session is invalid or expired." },
      { status: 401 },
    );
    response.cookies.set(getMainAppSessionCookieName(), "", {
      ...getMainAppSessionCookieOptions(),
      maxAge: 0,
    });
    return response;
  }

  // 6. Page route: redirect to main app launch URL
  const intent = await createMainAppSsoIntent();
  const response = NextResponse.redirect(getMainAppSsoLaunchUrl(intent.state));
  response.cookies.set(getMainAppSessionCookieName(), "", {
    ...getMainAppSessionCookieOptions(),
    maxAge: 0,
  });
  response.cookies.set(
    getMainAppSsoIntentCookieName(),
    intent.cookieValue,
    getMainAppSsoIntentCookieOptions(intent.expiresAt),
  );
  return response;
}

export const config = {
  // Raw uploads authenticate inside the route and must stream without Next's 10 MB body clone.
  // Keep /api/upload/direct and /api/upload/complete behind middleware as well as their own checks.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/upload/?$).*)"],
};
