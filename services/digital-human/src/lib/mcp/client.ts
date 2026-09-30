import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { HeyGenDirectMcpProvider } from "./heygen-provider";
import { createHeyGenOAuthProvider } from "./heygen-oauth-provider";
import { HEYGEN_REMOTE_MCP_URL, hasHeyGenOAuthTokens } from "./heygen-oauth-store";

export type McpTransportType = "sse" | "stdio" | "direct" | "remote";

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: any;
}

export interface McpConnectionStatus {
  connected: boolean;
  transportType: McpTransportType;
  serverName?: string;
  serverVersion?: string;
  tools: McpToolInfo[];
  needsAuth?: boolean;
  error?: string;
}

function normalizeRemoteToolArgs(name: string, args: Record<string, any>): Record<string, any> {
  const next = { ...args };

  if (name === "create_lipsync" || name === "heygen_create_lipsync") {
    if (typeof next.video_url === "string" && !next.video) {
      next.video = { type: "url", url: next.video_url };
      delete next.video_url;
    }
    if (typeof next.audio_url === "string" && !next.audio) {
      next.audio = { type: "url", url: next.audio_url };
      delete next.audio_url;
    }
  }

  if (name === "get_lipsync" || name === "heygen_get_lipsync") {
    const id = next.lipsyncId || next.lipsync_id || next.id;
    if (id) {
      next.lipsyncId = id;
      next.lipsync_id = id;
    }
  }

  return next;
}

export class McpClientManager {
  private static instance: McpClientManager;
  private client: Client | null = null;
  private transport: SSEClientTransport | StdioClientTransport | StreamableHTTPClientTransport | null = null;
  private status: McpConnectionStatus = {
    connected: false,
    transportType: "direct",
    tools: [],
  };

  private constructor() {}

  public static getInstance(): McpClientManager {
    if (!McpClientManager.instance) {
      McpClientManager.instance = new McpClientManager();
    }
    return McpClientManager.instance;
  }

  public getStatus(): McpConnectionStatus {
    return { ...this.status };
  }

  public async connect(
    config: {
      transport: McpTransportType;
      serverUrl?: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      authToken?: string;
    }
  ): Promise<McpConnectionStatus> {
    await this.disconnect();

    if (config.transport === "remote") {
      return this.connectRemote(config.serverUrl);
    }

    if (config.transport === "direct") {
      this.status = {
        connected: true,
        transportType: "direct",
        serverName: "HeyGen Native MCP Engine",
        serverVersion: "2.0.0",
        tools: [
          {
            name: "create_lipsync",
            description: "Create precision lip-sync job calling HeyGen Cloud Engine directly using Subscription Credits",
            inputSchema: {
              type: "object",
              properties: {
                video_url: { type: "string", description: "Source talking head video URL" },
                audio_url: { type: "string", description: "IndexTTS WAV audio URL" },
                title: { type: "string", description: "Submission title for idempotency" },
                mode: { type: "string", enum: ["precision"], default: "precision" },
              },
              required: ["video_url", "audio_url"],
            },
          },
          {
            name: "get_lipsync",
            description: "Get status and output video URL of a HeyGen lip-sync job",
            inputSchema: {
              type: "object",
              properties: {
                lipsync_id: { type: "string", description: "HeyGen Lip-sync Task ID" },
              },
              required: ["lipsync_id"],
            },
          },
          {
            name: "list_lipsyncs",
            description: "List recent HeyGen lip-sync jobs to prevent duplicate billing",
            inputSchema: {
              type: "object",
              properties: {
                limit: { type: "number", default: 20 },
              },
            },
          },
          {
            name: "get_remaining_quota",
            description: "Query HeyGen subscription plan details and remaining Premium Credits",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      };
      return this.status;
    }

    try {
      this.client = new Client(
        {
          name: "digital-human-lipsync-web-client",
          version: "2.0.0",
        },
        {
          capabilities: {},
        }
      );

      if (config.transport === "sse") {
        if (!config.serverUrl) throw new Error("SSE Server URL is required");
        if (!config.authToken) throw new Error("MCP SSE auth token is required");
        const authorization = `Bearer ${config.authToken}`;
        const authenticatedFetch = (input: string | URL | Request, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          headers.set("Authorization", authorization);
          return fetch(input, { ...init, headers });
        };
        this.transport = new SSEClientTransport(new URL(config.serverUrl), {
          eventSourceInit: { fetch: authenticatedFetch },
          requestInit: { headers: { Authorization: authorization } },
        });
      } else if (config.transport === "stdio") {
        if (!config.command) throw new Error("Stdio command is required");
        this.transport = new StdioClientTransport({
          command: config.command,
          args: config.args || [],
          env: config.env || (process.env as Record<string, string>),
        });
      } else {
        throw new Error(`Unsupported transport: ${config.transport}`);
      }

      await this.client.connect(this.transport);

      // List tools
      const toolsResult = await this.client.listTools();
      const tools: McpToolInfo[] = (toolsResult.tools || []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));

      this.status = {
        connected: true,
        transportType: config.transport,
        serverName: "Remote MCP Server",
        serverVersion: "1.0.0",
        tools,
      };

      return this.status;
    } catch (err: any) {
      this.status = {
        connected: false,
        transportType: config.transport,
        tools: [],
        error: err.message || "Failed to connect to MCP server",
      };
      return this.status;
    }
  }

  private async connectRemote(serverUrl?: string): Promise<McpConnectionStatus> {
    if (!hasHeyGenOAuthTokens()) {
      this.status = {
        connected: false,
        transportType: "remote",
        tools: [],
        needsAuth: true,
        error: "尚未授权 HeyGen 官方 MCP，请先点击「授权连接 HeyGen MCP」",
      };
      return this.status;
    }

    try {
      this.client = new Client(
        {
          name: "digital-human-lipsync-web-client",
          version: "2.0.0",
        },
        {
          capabilities: {},
        }
      );

      const provider = createHeyGenOAuthProvider();
      this.transport = new StreamableHTTPClientTransport(
        new URL(serverUrl || HEYGEN_REMOTE_MCP_URL),
        { authProvider: provider }
      );

      await this.client.connect(this.transport);
      const toolsResult = await this.client.listTools();
      const tools: McpToolInfo[] = (toolsResult.tools || []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));

      this.status = {
        connected: true,
        transportType: "remote",
        serverName: "HeyGen Official Remote MCP",
        serverVersion: "v1",
        tools,
      };
      return this.status;
    } catch (err: any) {
      const needsAuth = err instanceof UnauthorizedError || /unauthor/i.test(err?.message || "");
      this.status = {
        connected: false,
        transportType: "remote",
        tools: [],
        needsAuth,
        error: needsAuth
          ? "HeyGen MCP 授权已失效，请重新点击连接"
          : err.message || "连接 HeyGen 官方 MCP 失败",
      };
      return this.status;
    }
  }

  public async callTool(name: string, args: Record<string, any>): Promise<any> {
    if (!this.status.connected) {
      throw new Error(this.status.error || "MCP Client is not connected");
    }

    if (this.status.transportType === "remote" && this.client) {
      const response = await this.client.callTool({
        name,
        arguments: normalizeRemoteToolArgs(name, args),
      });
      return response;
    }

    if (this.status.transportType === "direct" || !this.client) {
      if (name === "create_lipsync" || name === "heygen_create_lipsync") {
        const res = await HeyGenDirectMcpProvider.createLipsync({
          videoUrl: args.video_url,
          audioUrl: args.audio_url,
          title: args.title,
          mode: args.mode || "precision",
        });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      }
      if (name === "get_lipsync" || name === "heygen_get_lipsync") {
        const res = await HeyGenDirectMcpProvider.getLipsyncStatus(args.lipsync_id);
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      }
      if (name === "list_lipsyncs" || name === "heygen_list_lipsyncs") {
        return { content: [{ type: "text", text: JSON.stringify({ list: [] }) }] };
      }
      if (name === "get_remaining_quota" || name === "get_quota") {
        const res = await HeyGenDirectMcpProvider.getQuota();
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      }
      throw new Error(`Direct MCP provider unknown tool: ${name}`);
    }

    const response = await this.client.callTool({
      name,
      arguments: args,
    });

    return response;
  }

  public async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch (e) {
        // ignore close error
      }
      this.client = null;
    }
    this.transport = null;
    this.status = {
      connected: false,
      transportType: "direct",
      tools: [],
    };
  }
}
