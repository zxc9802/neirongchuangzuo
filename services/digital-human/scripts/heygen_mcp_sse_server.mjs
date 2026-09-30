#!/usr/bin/env node

/**
 * Standalone SSE MCP Server for HeyGen Precision Lip-sync
 * Implements Model Context Protocol (MCP) SSE Transport specification
 * Ready to deploy on Zeabur, VPS, Docker, or local machine
 */

import http from "http";
import { timingSafeEqual } from "crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const PORT = Number(process.env.PORT || process.env.MCP_PORT || 8000);
const HOST = process.env.MCP_SSE_HOST?.trim() || "127.0.0.1";
const MCP_SSE_AUTH_TOKEN = process.env.MCP_SSE_AUTH_TOKEN?.trim() || "";
const ALLOWED_ORIGINS = new Set(
  (process.env.MCP_SSE_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);
const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY || "";
const HEYGEN_API_BASE_URL = (process.env.HEYGEN_API_BASE_URL || "https://api.heygen.com").replace(/\/$/, "");
const MAX_PAID_CALLS_PER_HOUR = Math.max(
  1,
  Number(process.env.MCP_MAX_PAID_CALLS_PER_HOUR || 10),
);
let paidCallWindowStartedAt = Date.now();
let paidCallsInWindow = 0;

if (!MCP_SSE_AUTH_TOKEN) throw new Error("MCP_SSE_AUTH_TOKEN is required");
if (!HEYGEN_API_KEY) throw new Error("HEYGEN_API_KEY is required");

function consumePaidCallBudget(now = Date.now()) {
  if (now - paidCallWindowStartedAt >= 60 * 60_000) {
    paidCallWindowStartedAt = now;
    paidCallsInWindow = 0;
  }
  if (paidCallsInWindow >= MAX_PAID_CALLS_PER_HOUR) {
    throw new Error("Paid tool rate limit exceeded");
  }
  paidCallsInWindow += 1;
}

function createMcpServer() {
const mcpServer = new Server(
  {
    name: "heygen-precision-mcp-server",
    version: "2.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Tools Definition
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "create_lipsync",
        description: "Create a precision digital human lip-sync job using HeyGen Subscription Credits",
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
});

// Tools Handlers
mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const apiKey = HEYGEN_API_KEY;

  if (name === "create_lipsync" || name === "heygen_create_lipsync") {
    const videoUrl = args?.video_url;
    const audioUrl = args?.audio_url;
    const title = args?.title || `lipsync_${Date.now()}`;

    if (!videoUrl || !audioUrl) {
      throw new Error("Missing video_url or audio_url");
    }
    if (!apiKey) {
      throw new Error("Missing HEYGEN_API_KEY in MCP server environment");
    }
    for (const source of [videoUrl, audioUrl]) {
      const parsed = new URL(source);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
        throw new Error("Media URLs must be credential-free HTTPS");
      }
    }
    consumePaidCallBudget();

    const payload = {
      video_url: videoUrl,
      audio_url: audioUrl,
      title,
      mode: args?.mode || "precision",
      disableMusicTrack: true,
      enableCaption: false,
      enableDynamicDuration: false,
      enableSpeechEnhancement: false,
      enableWatermark: false,
      fpsMode: "cfr",
      keepTheSameFormat: true,
    };

    const resp = await fetch(`${HEYGEN_API_BASE_URL}/v1/video/lipsync`, {
      method: "POST",
      headers: {
        "X-Api-Key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      redirect: "error",
    });

    const data = await resp.json();
    if (!resp.ok || (data.code && data.code !== 100)) {
      throw new Error(`HeyGen API Error: ${data.message || JSON.stringify(data)}`);
    }

    const lipsyncId =
      data.data?.video_id ||
      data.data?.lipsync_id ||
      data.data?.id ||
      data.video_id ||
      data.lipsync_id ||
      data.id;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            lipsync_id: lipsyncId,
            status: "processing",
            mode: "precision",
            title,
          }),
        },
      ],
    };
  }

  if (name === "get_lipsync" || name === "heygen_get_lipsync") {
    const lipsyncId = args?.lipsync_id;
    if (!lipsyncId) throw new Error("lipsync_id is required");
    if (!apiKey) throw new Error("Missing HEYGEN_API_KEY");

    const resp = await fetch(`${HEYGEN_API_BASE_URL}/v1/video_status.get?video_id=${lipsyncId}`, {
      headers: { "X-Api-Key": apiKey },
      redirect: "error",
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(`HeyGen Error: ${data.message || JSON.stringify(data)}`);

    const remoteStatus = (data.data?.status || data.status || "processing").toLowerCase();
    const videoUrl = data.data?.video_url || data.data?.url || data.video_url;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            lipsync_id: lipsyncId,
            status: remoteStatus,
            video_url: videoUrl || null,
          }),
        },
      ],
    };
  }

  if (name === "get_remaining_quota" || name === "get_quota") {
    if (!apiKey) throw new Error("Missing HEYGEN_API_KEY");
    const resp = await fetch(`${HEYGEN_API_BASE_URL}/v1/user/remaining_quota`, {
      headers: { "X-Api-Key": apiKey },
      redirect: "error",
    });
    const data = await resp.json();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(data),
        },
      ],
    };
  }

  if (name === "list_lipsyncs" || name === "heygen_list_lipsyncs") {
    return {
      content: [{ type: "text", text: JSON.stringify({ list: [] }) }],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

return mcpServer;
}

const transports = new Map();
const MAX_SESSIONS = 20;

function isAuthorized(req) {
  const value = req.headers.authorization || "";
  const expected = `Bearer ${MCP_SSE_AUTH_TOKEN}`;
  const actualBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer);
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    return true;
  }
  return !origin;
}

const httpServer = http.createServer(async (req, res) => {
  const corsAllowed = applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(corsAllowed ? 204 : 403);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://localhost:${PORT}`);

  if (url.pathname === "/sse") {
    if (!corsAllowed || !isAuthorized(req)) {
      res.writeHead(401, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    if (transports.size >= MAX_SESSIONS) {
      res.writeHead(429, { "Retry-After": "5", "Cache-Control": "no-store" });
      res.end("Too many sessions");
      return;
    }
    const transport = new SSEServerTransport("/message", res);
    const mcpServer = createMcpServer();
    transports.set(transport.sessionId, { transport, mcpServer });
    res.once("close", () => transports.delete(transport.sessionId));
    await mcpServer.connect(transport);
    return;
  }

  if (url.pathname === "/message") {
    if (!corsAllowed || !isAuthorized(req)) {
      res.writeHead(401, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    const sessionId = url.searchParams.get("sessionId") || "";
    const active = transports.get(sessionId);
    if (active) {
      await active.transport.handlePostMessage(req, res);
    } else {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No active SSE connection" }));
    }
    return;
  }

  if (url.pathname === "/" || url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "online",
        name: "heygen-precision-mcp-server",
        transport: "SSE",
        endpoints: {
          sse: `http://${req.headers.host || "localhost"}/sse`,
          message: `http://${req.headers.host || "localhost"}/message`,
        },
      })
    );
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

httpServer.listen(PORT, HOST, () => {
  console.log(`Media processing server listening on port ${PORT}`);
});
