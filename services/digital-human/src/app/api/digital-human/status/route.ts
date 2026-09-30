import { NextRequest, NextResponse } from "next/server";
import { getAppConfig } from "@/lib/config";
import { resolveAccessContext, unauthorizedResponse } from "@/lib/access-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A configuration check only: it does not contact providers or expose credentials.
export async function GET(request: NextRequest) {
  const access = await resolveAccessContext(request);
  if (access.isolated && !access.userId) return unauthorizedResponse();
  const config = getAppConfig();
  let publicAddress = false;
  try {
    const url = new URL(config.publicBaseUrl);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const localHost = /^(localhost|.*\.localhost|.*\.local|127\..*|10\..*|192\.168\..*|172\.(1[6-9]|2\d|3[01])\..*|0\.0\.0\.0|169\.254\..*)$/.test(host) ||
      (host.includes(":") && /^(::1|fc[0-9a-f].*|fd[0-9a-f].*|fe80:.*)$/.test(host));
    publicAddress = ["http:", "https:"].includes(url.protocol) &&
      !url.username && !url.password &&
      !localHost;
  } catch { /* No usable media base URL. */ }
  const mediaReady = Boolean(publicAddress ||
    (config.cosSecretId && config.cosSecretKey && config.cosBucket && config.cosRegion));
  const ttsReady = Boolean(config.indexttsApiKey);
  const engines = [
    { id: "a", label: "口型方案 A", available: Boolean(config.openluxApiKey) },
    { id: "b", label: "口型方案 B", available: Boolean(config.falApiKey) },
    { id: "c", label: "口型方案 C", available: Boolean(config.heygenApiKey) },
  ];
  return NextResponse.json({
    service: "digital-human", ttsReady, mediaReady, engines,
    ready: ttsReady && mediaReady && engines.some(engine => engine.available),
  }, { headers: { "Cache-Control": "no-store" } });
}
