import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  HEYGEN_MCP_RESOURCE,
  buildHeyGenCallbackUrl,
  clearHeyGenOAuthStore,
  loadHeyGenOAuthStore,
  saveHeyGenOAuthStore,
} from "./heygen-oauth-store";

export class HeyGenOAuthProvider implements OAuthClientProvider {
  lastAuthorizationUrl?: URL;
  private redirectUri: string;

  constructor(redirectUrl?: string) {
    const stored = loadHeyGenOAuthStore();
    this.redirectUri = redirectUrl || stored.redirectUrl || buildHeyGenCallbackUrl("http://localhost:3000");
    if (redirectUrl && stored.redirectUrl !== redirectUrl) {
      saveHeyGenOAuthStore({ redirectUrl });
    }
  }

  get redirectUrl(): string {
    return this.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    const origin = this.redirectUri.replace(/\/api\/mcp\/heygen\/oauth\/callback$/, "");
    return {
      client_name: "数字人制作",
      client_uri: origin,
      redirect_uris: [this.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "openid profile email",
    };
  }

  state(): string {
    const state = crypto.randomUUID();
    saveHeyGenOAuthStore({ oauthState: state });
    return state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return loadHeyGenOAuthStore().clientInformation;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    saveHeyGenOAuthStore({ clientInformation: info });
  }

  tokens(): OAuthTokens | undefined {
    return loadHeyGenOAuthStore().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    saveHeyGenOAuthStore({
      tokens,
      pendingAuthorizationUrl: undefined,
      codeVerifier: undefined,
      oauthState: undefined,
    });
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.lastAuthorizationUrl = authorizationUrl;
    saveHeyGenOAuthStore({ pendingAuthorizationUrl: authorizationUrl.toString() });
  }

  saveCodeVerifier(codeVerifier: string): void {
    saveHeyGenOAuthStore({ codeVerifier });
  }

  codeVerifier(): string {
    const verifier = loadHeyGenOAuthStore().codeVerifier;
    if (!verifier) throw new Error("缺少 PKCE code_verifier，请重新点击授权连接");
    return verifier;
  }

  async validateResourceURL(_serverUrl: string | URL, resource?: string): Promise<URL | undefined> {
    if (resource) {
      const parsed = new URL(resource);
      if (parsed.origin === new URL(HEYGEN_MCP_RESOURCE).origin) {
        return parsed;
      }
    }
    return new URL(HEYGEN_MCP_RESOURCE);
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    saveHeyGenOAuthStore({ discovery: state });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return loadHeyGenOAuthStore().discovery;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    clearHeyGenOAuthStore(scope);
  }
}

export function createHeyGenOAuthProvider(redirectUrl?: string): HeyGenOAuthProvider {
  return new HeyGenOAuthProvider(redirectUrl);
}
