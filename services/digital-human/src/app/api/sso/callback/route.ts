import { NextRequest, NextResponse } from "next/server";
import {
  createMainAppSessionCookie,
  createMainAppSsoIntent,
  exchangeMainAppSsoTicket,
  getMainAppSsoIntentCookieName,
  getMainAppSsoIntentCookieOptions,
  getMainAppSsoLaunchUrl,
  getMainAppSessionCookieName,
  getMainAppSessionCookieOptions,
  getPublicShuzirenAppUrl,
  validateMainAppSsoIntent,
} from "@/lib/main-app-sso";

export async function GET(request: NextRequest) {
  const ticket = request.nextUrl.searchParams.get("ticket")?.trim();
  const state = request.nextUrl.searchParams.get("state")?.trim();
  const intentCookie = request.cookies.get(getMainAppSsoIntentCookieName())?.value;

  try {
    if (!ticket || !(await validateMainAppSsoIntent(intentCookie, state))) {
      throw new Error("SSO login intent is missing, expired, or invalid.");
    }
    const { redirectPath, session } = await exchangeMainAppSsoTicket(ticket);
    const redirectUrl = new URL(redirectPath, getPublicShuzirenAppUrl());
    const response = NextResponse.redirect(redirectUrl);

    response.cookies.set(
      getMainAppSessionCookieName(),
      await createMainAppSessionCookie(session),
      getMainAppSessionCookieOptions(session.expiresAt),
    );
    response.headers.set("Cache-Control", "private, no-store");
    response.cookies.set(getMainAppSsoIntentCookieName(), "", {
      ...getMainAppSsoIntentCookieOptions(),
      maxAge: 0,
    });
    return response;
  } catch (error: any) {
    // 友好错误页：说明原因并允许重试，避免用户看到裸 JSON 或误判为登录循环
    const reason = "登录请求已失效，请从主站重新进入。";
    const isTimeout = error?.name === "TimeoutError";
    const retryIntent = await createMainAppSsoIntent();
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>登录遇到问题</title>
<style>
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0a0b0e; color: #e4e4e7; }
  .card { max-width: 520px; padding: 40px; border-radius: 16px; background: #131418; border: 1px solid #26272b; text-align: center; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { font-size: 14px; color: #a1a1aa; line-height: 1.7; margin: 0 0 8px; }
  code { display: block; margin: 16px 0; padding: 12px; font-size: 12px; color: #fbbf24; background: #1c1d22; border-radius: 8px; word-break: break-all; text-align: left; }
  a.btn { display: inline-block; margin-top: 16px; padding: 10px 24px; border-radius: 10px; background: #2563eb; color: #fff; text-decoration: none; font-size: 14px; }
</style>
</head>
<body>
  <div class="card">
    <h1>数字人智能体登录失败</h1>
    <p>${isTimeout ? "连接主站超时：数字人服务器访问主站网络异常，请稍后重试或联系管理员检查服务器出网。" : "单点登录票据校验未通过，票据是一次性的，返回主站重新进入即可。"}</p>
    <code>${reason.replace(/[<>&]/g, "")}</code>
    <a class="btn" href="${getMainAppSsoLaunchUrl(retryIntent.state)}">返回主站重新进入</a>
  </div>
</body>
</html>`;
    const response = new NextResponse(html, {
      status: 401,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-store",
      },
    });
    response.cookies.set(
      getMainAppSsoIntentCookieName(),
      retryIntent.cookieValue,
      getMainAppSsoIntentCookieOptions(retryIntent.expiresAt),
    );
    return response;
  }
}
