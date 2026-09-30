#!/usr/bin/env node

/**
 * Built-in Standard MCP Server for HeyGen Precision Lip-sync
 * Implements Model Context Protocol (MCP) Stdio JSON-RPC 2.0 Specification
 * Bridges directly to HeyGen Official Lip-Sync Cloud API
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import path from "path";

const server = new Server(
  {
    name: "heygen-precision-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Read settings from .settings.json or process.env
function getApiKey() {
  try {
    const settingsPath = path.join(process.cwd(), ".settings.json");
    if (fs.existsSync(settingsPath)) {
      const data = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      if (data.heygenApiKey) return data.heygenApiKey.trim();
    }
  } catch {}
  return (process.env.HEYGEN_API_KEY || "").trim();
}

function getApiBaseUrl() {
  try {
    const settingsPath = path.join(process.cwd(), ".settings.json");
    if (fs.existsSync(settingsPath)) {
      const data = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      if (data.heygenApiBaseUrl) return data.heygenApiBaseUrl.trim().replace(/\/$/, "");
    }
  } catch {}
  return (process.env.HEYGEN_API_BASE_URL || "https://api.heygen.com").trim().replace(/\/$/, "");
}

// Local in-memory task registry for tracking & status
const tasks = new Map();

// Tool Definitions
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "create_lipsync",
        description: "Create a precision digital human lip-sync job (HeyGen Precision Mode)",
        inputSchema: {
          type: "object",
          properties: {
            video_url: {
              type: "string",
              description: "Source video public HTTP(S) URL or asset ID",
            },
            audio_url: {
              type: "string",
              description: "IndexTTS-2 generated WAV audio HTTP(S) URL",
            },
            title: {
              type: "string",
              description: "Submission title for idempotency checking",
            },
            mode: {
              type: "string",
              enum: ["precision"],
              default: "precision",
              description: "Must be precision mode",
            },
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
            lipsync_id: {
              type: "string",
              description: "HeyGen Lip-sync Task ID",
            },
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
            limit: {
              type: "number",
              default: 20,
              description: "Max number of items to return",
            },
          },
        },
      },
    ],
  };
});

// Tool Handlers
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const apiKey = getApiKey();
  const baseUrl = getApiBaseUrl();

  if (name === "create_lipsync" || name === "heygen_create_lipsync") {
    const videoUrl = args?.video_url;
    const audioUrl = args?.audio_url;
    const title = args?.title || `lipsync_${Date.now()}`;

    if (!videoUrl || !audioUrl) {
      throw new Error("缺少必要参数: video_url 和 audio_url");
    }

    if (!apiKey) {
      throw new Error(
        "未配置 HeyGen API Key！请进入【系统配置】页面填入您的 HeyGen API Key (或在环境变量中设置 HEYGEN_API_KEY)，以调用官方云端对口型 AI 引擎生成唇形。"
      );
    }

    // Call Real HeyGen API
    // Try V1 Lip-sync endpoint: POST https://api.heygen.com/v1/video/lipsync
    const heygenPayload = {
      video_url: videoUrl,
      audio_url: audioUrl,
      title,
      mode: "precision",
    };

    let lipsyncId = "";
    let status = "processing";

    try {
      const resp = await fetch(`${baseUrl}/v1/video/lipsync`, {
        method: "POST",
        headers: {
          "X-Api-Key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(heygenPayload),
      });

      const data = await resp.json();

      if (!resp.ok || (data.code && data.code !== 100)) {
        throw new Error(
          `HeyGen API 提交错误 (${resp.status}): ${data.message || data.error || JSON.stringify(data)}`
        );
      }

      lipsyncId =
        data.data?.video_id ||
        data.data?.lipsync_id ||
        data.data?.id ||
        data.video_id ||
        data.lipsync_id ||
        data.id;

      if (!lipsyncId) {
        throw new Error(`HeyGen API 响应中未找到任务 ID: ${JSON.stringify(data)}`);
      }
    } catch (apiErr) {
      throw new Error(`调用 HeyGen 对口型接口失败: ${apiErr.message}`);
    }

    tasks.set(lipsyncId, {
      id: lipsyncId,
      title,
      video_url: videoUrl,
      audio_url: audioUrl,
      status: "processing",
      created_at: Date.now(),
    });

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
    if (!lipsyncId) {
      throw new Error("lipsync_id 必填");
    }

    if (!apiKey) {
      throw new Error("缺少 HEYGEN_API_KEY，无法查询 HeyGen 任务状态");
    }

    try {
      const resp = await fetch(`${baseUrl}/v1/video_status.get?video_id=${lipsyncId}`, {
        method: "GET",
        headers: {
          "X-Api-Key": apiKey,
        },
      });

      const data = await resp.json();

      if (!resp.ok) {
        throw new Error(`查询 HeyGen 任务失败 (${resp.status}): ${data.message || JSON.stringify(data)}`);
      }

      const remoteStatus = (data.data?.status || data.status || "processing").toLowerCase();
      const videoResultUrl = data.data?.video_url || data.data?.url || data.video_url;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              lipsync_id: lipsyncId,
              status: remoteStatus,
              video_url: videoResultUrl || null,
              error_detail: data.data?.error || data.error || null,
            }),
          },
        ],
      };
    } catch (getErr) {
      throw new Error(`获取 HeyGen 任务状态异常: ${getErr.message}`);
    }
  }

  if (name === "list_lipsyncs" || name === "heygen_list_lipsyncs") {
    const limit = args?.limit || 20;
    const list = Array.from(tasks.values()).slice(0, limit);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            list,
          }),
        },
      ],
    };
  }

  throw new Error(`未知 MCP 工具: ${name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(() => {
  console.error("Media processing server failed to start.");
  process.exit(1);
});
