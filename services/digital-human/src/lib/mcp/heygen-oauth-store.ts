import { logServerError } from "../server/safe-log";
import fs from "fs";
import path from "path";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export const HEYGEN_REMOTE_MCP_URL = "https://mcp.heygen.com/mcp/v1";
export const HEYGEN_MCP_RESOURCE = "https://mcp.heygen.com";

export interface HeyGenOAuthUser {
  email?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  planName?: string;
  remainingCredits?: number;
  quota?: number;
}

export interface HeyGenOAuthStore {
  redirectUrl?: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  oauthState?: string;
  pendingAuthorizationUrl?: string;
  discovery?: OAuthDiscoveryState;
  user?: HeyGenOAuthUser;
  connectedAt?: string;
}

const STORE_PATH = path.join(process.cwd(), ".heygen-mcp-auth.json");

export function loadHeyGenOAuthStore(): HeyGenOAuthStore {
  try {
    if (fs.existsSync(STORE_PATH)) {
      return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
    }
  } catch (err) {
    logServerError("provider.auth_read_failed", err);
  }
  return {};
}

export function saveHeyGenOAuthStore(patch: Partial<HeyGenOAuthStore>): HeyGenOAuthStore {
  const next = { ...loadHeyGenOAuthStore(), ...patch };
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(next, null, 2), "utf-8");
  } catch (err) {
    logServerError("provider.auth_write_failed", err);
  }
  return next;
}

export function clearHeyGenOAuthStore(scope: "all" | "client" | "tokens" | "verifier" | "discovery" = "all"): HeyGenOAuthStore {
  const current = loadHeyGenOAuthStore();
  if (scope === "all") {
    const keepRedirect = current.redirectUrl;
    try {
      if (fs.existsSync(STORE_PATH)) fs.unlinkSync(STORE_PATH);
    } catch {}
    return keepRedirect ? saveHeyGenOAuthStore({ redirectUrl: keepRedirect }) : {};
  }

  const next = { ...current };
  if (scope === "client") delete next.clientInformation;
  if (scope === "tokens") {
    delete next.tokens;
    delete next.user;
    delete next.connectedAt;
  }
  if (scope === "verifier") delete next.codeVerifier;
  if (scope === "discovery") delete next.discovery;
  return saveHeyGenOAuthStore(next);
}

export function hasHeyGenOAuthTokens(): boolean {
  return Boolean(loadHeyGenOAuthStore().tokens?.access_token);
}

export function resolveRequestOrigin(req: { headers: Headers; nextUrl?: URL }): string {
  const proto =
    req.headers.get("x-forwarded-proto") ||
    req.nextUrl?.protocol.replace(":", "") ||
    "http";
  const host =
    req.headers.get("x-forwarded-host") ||
    req.headers.get("host") ||
    req.nextUrl?.host ||
    "localhost:3000";
  return `${proto}://${host}`;
}

export function buildHeyGenCallbackUrl(origin: string): string {
  return `${origin.replace(/\/$/, "")}/api/mcp/heygen/oauth/callback`;
}
