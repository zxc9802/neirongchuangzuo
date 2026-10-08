import { NextRequest, NextResponse } from "next/server";
import { usesStandaloneAuth } from "@/lib/auth-mode";
import { AUTH_COOKIE, readStandaloneSession } from "@/lib/server/standalone-auth";
import { GET as getSsoSession } from "../sso/session/route";
import { workspaceCreditsSnapshot } from "@/lib/server/workspace-credits";

export async function GET(request: NextRequest) {
  if (!usesStandaloneAuth(Boolean(request.cookies.get(AUTH_COOKIE)))) return getSsoSession(request);
  const session = await readStandaloneSession(request.cookies.get(AUTH_COOKIE)?.value);
  let credits;
  if (session) {
    try { credits = await workspaceCreditsSnapshot(session.user.id); }
    catch { return NextResponse.json({ error: "积分服务暂时不可用，请稍后重试", code: "CREDITS_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
  }
  return NextResponse.json(session ? {
    success: true,
    data: { user: session.user, authMode: "standalone", credits, billing: { source: "workspace", isExternal: true, ratePerSecond: 333 / 30, cnyPerSecond: 0, videoPoints: 333, videoSeconds: 30 } },
  } : { error: "请先登录", code: "UNAUTHENTICATED" }, {
    status: session ? 200 : 401, headers: { "Cache-Control": "no-store" },
  });
}
