import path from "path";
import { resolveLipsyncProvider } from "./lipsync-provider";
import type { LipsyncProvider } from "./lipsync-provider";

export interface AppConfig {
  indexttsApiKey: string;
  indexttsBaseUrl: string;
  indexttsSpeakerAudioUrl: string;
  indexttsEmotionAudioPath: string;
  indexttsEmotionAudioUrl: string;
  heygenApiKey: string;
  heygenApiBaseUrl: string;
  heygenMcpServerUrl: string;
  heygenMcpAuthToken: string;
  heygenMcpServerCommand: string;
  heygenMcpServerArgs: string[];
  heygenMcpTransport: "sse" | "stdio" | "direct" | "remote";
  lipsyncProvider: LipsyncProvider;
  openluxApiKey: string;
  openluxBaseUrl: string;
  openluxLipsyncModel: string;
  pixverseIngestUrl: string;
  pixverseIngestToken: string;
  falApiKey: string;
  falVeedModel: string;
  storageDir: string;
  publicBaseUrl: string;

  // cloud object storage Configuration
  cosSecretId: string;
  cosSecretKey: string;
  cosBucket: string;
  cosRegion: string;
  cosCustomDomain: string;
  cosEnabled: boolean;
}

const defaultMcpScriptPath = path.join(process.cwd(), "scripts", "heygen_mcp_server.mjs");

const DEFAULT_CONFIG: AppConfig = {
  indexttsApiKey:
    process.env.INDEXTTS_302_API_KEY || "",
  indexttsBaseUrl:
    process.env.INDEXTTS_BASE_URL || "https://api.302.ai",
  indexttsSpeakerAudioUrl:
    process.env.INDEXTTS_SPEAKER_AUDIO_URL || "",
  indexttsEmotionAudioPath:
    process.env.INDEXTTS_EMOTION_AUDIO_PATH || "",
  indexttsEmotionAudioUrl:
    process.env.INDEXTTS_EMOTION_AUDIO_URL || "",
  heygenApiKey:
    process.env.HEYGEN_API_KEY || "",
  heygenApiBaseUrl:
    process.env.HEYGEN_API_BASE_URL || "https://api.heygen.com",
  heygenMcpServerUrl:
    process.env.HEYGEN_MCP_SERVER_URL || "https://mcp.heygen.com/mcp/v1",
  heygenMcpAuthToken: process.env.MCP_SSE_AUTH_TOKEN || "",
  heygenMcpServerCommand:
    process.env.HEYGEN_MCP_SERVER_COMMAND || "node",
  heygenMcpServerArgs: process.env.HEYGEN_MCP_SERVER_ARGS
    ? JSON.parse(process.env.HEYGEN_MCP_SERVER_ARGS)
    : [defaultMcpScriptPath],
  heygenMcpTransport:
    (process.env.HEYGEN_MCP_TRANSPORT as AppConfig["heygenMcpTransport"]) || "direct",
  lipsyncProvider: resolveLipsyncProvider(process.env.LIPSYNC_PROVIDER, "heygen"),
  openluxApiKey: process.env.OPENLUX_API_KEY || "",
  openluxBaseUrl: process.env.OPENLUX_API_BASE_URL || "https://api.openlux.ai",
  openluxLipsyncModel: process.env.OPENLUX_LIPSYNC_MODEL || "pixverse-lipsync",
  pixverseIngestUrl: process.env.PIXVERSE_INGEST_URL || "",
  pixverseIngestToken: process.env.PIXVERSE_INGEST_TOKEN || "",
  falApiKey: process.env.FAL_KEY || process.env.FAL_API_KEY || "",
  falVeedModel: process.env.FAL_VEED_MODEL || "veed/lipsync",
  storageDir: path.join(process.cwd(), ".runtime", "jobs"),
  publicBaseUrl:
    process.env.PUBLIC_BASE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    "http://localhost:3000",

  // cloud object storage
  cosSecretId:
    process.env.COS_SECRET_ID || "",
  cosSecretKey:
    process.env.COS_SECRET_KEY || "",
  cosBucket:
    process.env.COS_BUCKET || "",
  cosRegion:
    process.env.COS_REGION || "",
  cosCustomDomain:
    process.env.COS_CUSTOM_DOMAIN || "",
  cosEnabled: true,
};

export function getAppConfig(): AppConfig {
  return { ...DEFAULT_CONFIG };
}

export function saveAppConfig(_newConfig: Partial<AppConfig>): AppConfig {
  throw new Error("运行时配置只能通过服务端环境变量修改");
}
