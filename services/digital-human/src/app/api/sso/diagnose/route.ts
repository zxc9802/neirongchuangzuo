import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import {
  getMainAppSessionCookieName,
  getMainAppSsoLaunchUrl,
  isSsoConfigured,
} from "@/lib/main-app-sso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SSO 登录循环诊断端点（生产排障专用）。
 *
 * 仅当环境变量 SSO_DIAGNOSE_TOKEN 已配置且请求 token 匹配时才可用，
 * 否则一律 404，不暴露任何信息。响应中绝不包含密钥明文，只给长度/指纹。
 *
 * 探针结论：
 * - mainSiteSessionProbe：数字人容器出网调用主站是否通畅（期望 401 JSON）
 * - exchangeProbe：两侧 client secret 是否匹配 + 主站是否已注册 shuziren
 *   · EXTERNAL_SSO_TICKET_INVALID  → 密钥匹配，主站版本正常 ✓
 *   · EXTERNAL_SSO_CLIENT_UNAUTHORIZED → 密钥不匹配 ✗
 *   · EXTERNAL_SSO_PRODUCT_INVALID → 主站版本过旧，未注册 shuziren ✗
 *   · NETWORK_ERROR → 容器出网失败 ✗
 */
function fingerprint(value: string | undefined): string {
  if (!value) return "(未配置)";
  return `长度${value.trim().length}，尾4位…${value.trim().slice(-4)}`;
}

async function probeJson(
  url: string,
  init: RequestInit
): Promise<{ status: number; ok: boolean; body: string; error?: string }> {
  try {
    const response = await fetch(url, { ...init, cache: "no-store" });
    const text = await response.text();
    return { status: response.status, ok: response.ok, body: text.slice(0, 200) };
  } catch (err: any) {
    return {
      status: 0,
      ok: false,
      body: "",
      error: err?.message || String(err),
    };
  }
}

export async function GET(req: NextRequest) {
  const expected = process.env.SSO_DIAGNOSE_TOKEN?.trim();
  const authorization = req.headers.get("Authorization")?.trim() || "";
  const provided = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : req.headers.get("x-diagnose-token")?.trim() || "";
  const expectedBytes = Buffer.from(expected || "");
  const providedBytes = Buffer.from(provided);
  if (
    !expected ||
    expectedBytes.length !== providedBytes.length ||
    !timingSafeEqual(expectedBytes, providedBytes)
  ) {
    return new NextResponse("Not Found", {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const ssoConfigured = isSsoConfigured();
  const mainAppUrl =
    process.env.MAIN_APP_URL?.trim() || "https://www.qycm.top";
  const mainAppUrlConfigured = Boolean(process.env.MAIN_APP_URL?.trim());
  const exchangeUrl =
    process.env.MAIN_APP_SSO_EXCHANGE_URL?.trim() ||
    `${mainAppUrl}/api/external-sso/shuziren/exchange`;
  const clientSecret = process.env.MAIN_APP_SSO_CLIENT_SECRET?.trim();
  const hasCookie = Boolean(
    req.cookies.get(getMainAppSessionCookieName())?.value
  );

  // 探针 1：主站 session 接口（假 token，期望 401 JSON——证明出网通且未被 CF 拦截）
  const mainSiteSessionProbe = await probeJson(`${mainAppUrl}/api/sso/session`, {
    headers: { Authorization: "Bearer diagnose-probe-invalid-token" },
  });

  // 探针 2：换票接口（假 ticket + 生产真实密钥——通过 code 判断密钥匹配性与主站版本）
  let exchangeProbe: Awaited<ReturnType<typeof probeJson>> | null = null;
  if (clientSecret) {
    exchangeProbe = await probeJson(exchangeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-qycm-sso-client-secret": clientSecret,
      },
      body: JSON.stringify({ ticket: "diagnose-probe-invalid-ticket" }),
    });
  }

  const exchangeCode = (() => {
    if (!exchangeProbe) return "(未探测：MAIN_APP_SSO_CLIENT_SECRET 未配置)";
    if (exchangeProbe.error) return `NETWORK_ERROR: ${exchangeProbe.error}`;
    try {
      return JSON.parse(exchangeProbe.body)?.code || "(无code)";
    } catch {
      return `非JSON响应: ${exchangeProbe.body.slice(0, 80)}`;
    }
  })();

  const verdicts: string[] = [];
  if (!ssoConfigured) verdicts.push("✗ SSO 未正确配置（缺 MAIN_APP_SSO_CLIENT_SECRET 或 APP_SESSION_SECRET）");
  if (mainSiteSessionProbe.error) verdicts.push(`✗ 容器出网失败：${mainSiteSessionProbe.error}`);
  else if (mainSiteSessionProbe.status === 401) verdicts.push("✓ 主站 session 接口可达（出网正常）");
  else verdicts.push(`⚠ 主站 session 接口返回异常状态 ${mainSiteSessionProbe.status}（可能被 WAF/网关拦截）: ${mainSiteSessionProbe.body.slice(0, 60)}`);
  if (exchangeProbe?.error) verdicts.push(`✗ exchange 出网失败：${exchangeProbe.error}`);
  else if (exchangeCode === "EXTERNAL_SSO_TICKET_INVALID") verdicts.push("✓ client secret 与主站匹配，主站已注册 shuziren");
  else if (exchangeCode === "EXTERNAL_SSO_CLIENT_UNAUTHORIZED") verdicts.push("✗ MAIN_APP_SSO_CLIENT_SECRET 与主站 SSO_SHUZIREN_CLIENT_SECRET 不一致");
  else if (exchangeCode === "EXTERNAL_SSO_PRODUCT_INVALID") verdicts.push("✗ 主站版本过旧，未注册 shuziren 产品");
  else if (exchangeProbe) verdicts.push(`⚠ exchange 探测返回: ${exchangeCode}`);

  return NextResponse.json({
    ssoConfigured,
    loginLoopCause:
      "登录循环 = 会话cookie有效但 validateMainAppSession 失败（见下方探针），或 cookie 从未种上（换票失败/密钥不匹配）",
    currentRequest: { hasSessionCookie: hasCookie },
    config: {
      mainAppUrl,
      mainAppUrlConfigured,
      exchangeUrl,
      publicAppUrl: process.env.PUBLIC_APP_URL?.trim() || "(未配置)",
      clientSecretFingerprint: fingerprint(clientSecret),
      appSessionSecretFingerprint: fingerprint(process.env.APP_SESSION_SECRET),
      launchUrl: getMainAppSsoLaunchUrl(),
    },
    mainSiteSessionProbe,
    exchangeProbe: exchangeProbe
      ? { status: exchangeProbe.status, body: exchangeProbe.body, error: exchangeProbe.error }
      : null,
    verdicts,
  });
}
