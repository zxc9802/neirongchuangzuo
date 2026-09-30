import { logServerError } from "../server/safe-log";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { saveAppConfig } from "../config";
import { createHeyGenOAuthProvider } from "./heygen-oauth-provider";
import {
  HEYGEN_REMOTE_MCP_URL,
  hasHeyGenOAuthTokens,
  loadHeyGenOAuthStore,
  saveHeyGenOAuthStore,
  type HeyGenOAuthUser,
} from "./heygen-oauth-store";

export interface HeyGenRemoteAuthStatus {
  connected: boolean;
  needsAuth: boolean;
  authorizationUrl?: string;
  user?: HeyGenOAuthUser;
  toolCount?: number;
  error?: string;
}

function parseToolText(result: any): any {
  if (!result) return null;
  if (typeof result === "string") {
    try {
      return JSON.parse(result);
    } catch {
      return result;
    }
  }
  if (Array.isArray(result.content)) {
    const text = result.content.find((c: any) => c?.text)?.text;
    if (typeof text === "string") {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
  }
  return result;
}

function extractUserProfile(raw: any): HeyGenOAuthUser {
  const data = raw?.data || raw?.user || raw || {};
  const firstName = data.first_name || data.firstName || data.username;
  const lastName = data.last_name || data.lastName;
  return {
    email: data.email || data.username,
    username: data.username || data.email,
    firstName,
    lastName,
    planName:
      data.subscription?.plan ||
      data.plan_name ||
      data.plan ||
      data.billing?.plan ||
      "HeyGen 套餐",
    remainingCredits:
      data.remaining_quota ??
      data.remainingQuota ??
      data.credits ??
      data.quota?.remaining ??
      data.billing?.remaining_credits ??
      data.premium_credits,
    quota: data.quota ?? data.total_quota ?? data.billing?.quota,
  };
}

const FETCH_TIMEOUT_MS = 15000;

async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function startHeyGenOAuth(redirectUrl: string): Promise<HeyGenRemoteAuthStatus> {
  const provider = createHeyGenOAuthProvider(redirectUrl);

  if (hasHeyGenOAuthTokens()) {
    return { connected: true, needsAuth: false, user: loadHeyGenOAuthStore().user };
  }

  const result = await auth(provider, {
    serverUrl: HEYGEN_REMOTE_MCP_URL,
    fetchFn: fetchWithTimeout,
  });
  if (result === "AUTHORIZED") {
    return { connected: true, needsAuth: false, user: loadHeyGenOAuthStore().user };
  }

  const authorizationUrl =
    provider.lastAuthorizationUrl?.toString() || loadHeyGenOAuthStore().pendingAuthorizationUrl;

  if (!authorizationUrl) {
    throw new Error("HeyGen 未返回授权地址，请稍后重试");
  }

  return {
    connected: false,
    needsAuth: true,
    authorizationUrl,
  };
}

export async function finishHeyGenOAuth(code: string, redirectUrl?: string): Promise<HeyGenRemoteAuthStatus> {
  const provider = createHeyGenOAuthProvider(redirectUrl);
  const transport = new StreamableHTTPClientTransport(new URL(HEYGEN_REMOTE_MCP_URL), {
    authProvider: provider,
  });

  await transport.finishAuth(code);
  const verified = await verifyHeyGenRemoteSession(redirectUrl);
  saveAppConfig({
    heygenMcpTransport: "remote",
    heygenMcpServerUrl: HEYGEN_REMOTE_MCP_URL,
  });
  return verified;
}

export async function verifyHeyGenRemoteSession(redirectUrl?: string): Promise<HeyGenRemoteAuthStatus> {
  if (!hasHeyGenOAuthTokens()) {
    return { connected: false, needsAuth: true };
  }

  const provider = createHeyGenOAuthProvider(redirectUrl);
  const client = new Client(
    { name: "digital-human-lipsync-web-client", version: "2.0.0" },
    { capabilities: {} }
  );
  const transport = new StreamableHTTPClientTransport(new URL(HEYGEN_REMOTE_MCP_URL), {
    authProvider: provider,
  });

  try {
    await client.connect(transport);
    const toolsResult = await client.listTools();
    const tools = toolsResult.tools || [];

    let user = loadHeyGenOAuthStore().user;
    const userTool = tools.find((t) => t.name === "get_current_user");
    if (userTool) {
      try {
        const raw = await client.callTool({ name: "get_current_user", arguments: {} });
        user = extractUserProfile(parseToolText(raw));
      } catch (err) {
        logServerError("provider.profile_failed", err, "warn");
      }
    }

    saveHeyGenOAuthStore({
      user,
      connectedAt: new Date().toISOString(),
    });

    return {
      connected: true,
      needsAuth: false,
      user,
      toolCount: tools.length,
    };
  } finally {
    try {
      await client.close();
    } catch {}
  }
}

export async function disconnectHeyGenOAuth(): Promise<void> {
  const store = loadHeyGenOAuthStore();
  const token = store.tokens?.access_token;
  if (token) {
    try {
      await fetch("https://api2.heygen.com/v1/oauth/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token,
          client_id: store.clientInformation?.client_id || "",
        }),
      });
    } catch {}
  }
  const provider = createHeyGenOAuthProvider();
  provider.invalidateCredentials("all");
}

export function getHeyGenOAuthStatus(): HeyGenRemoteAuthStatus {
  const store = loadHeyGenOAuthStore();
  if (store.tokens?.access_token) {
    return {
      connected: true,
      needsAuth: false,
      user: store.user,
    };
  }
  return {
    connected: false,
    needsAuth: true,
    authorizationUrl: store.pendingAuthorizationUrl,
  };
}
