import { NextRequest, NextResponse } from "next/server";
import { usesStandaloneAuth } from "@/lib/auth-mode";
import { AUTH_COOKIE, readStandaloneSession } from "@/lib/server/standalone-auth";
import { GET as getSsoSession } from "../sso/session/route";

export async function GET(request: NextRequest) {
  if (!usesStandaloneAuth(Boolean(request.cookies.get(AUTH_COOKIE)))) return getSsoSession(request);
  const session = await readStandaloneSession(request.cookies.get(AUTH_COOKIE)?.value);
  return NextResponse.json(session ? {
    success: true,
    data: { user: session.user, authMode: "standalone", billing: { isExternal: false, ratePerSecond: 0, cnyPerSecond: 0 } },
  } : { error: "请先登录", code: "UNAUTHENTICATED" }, {
    status: session ? 200 : 401, headers: { "Cache-Control": "no-store" },
  });
}
