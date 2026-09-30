import fs from "fs";
import path from "path";
import { getAppConfig } from "../config";
import { CosService } from "../cos";
import { concatVideos, probeMedia, sliceMedia } from "./ffmpeg";
import { downloadFileToDisk } from "./download-file";
import {
  assertSameOrigin,
  fetchWithOutboundUrlPolicy,
  providerUrlPolicy,
  validateOutboundUrl,
} from "../server/outbound-url-policy";
import { LIPSYNC_CHUNK_SECONDS, planLipsyncChunks, pollTimeoutMs } from "./lipsync-chunks";
import type { TaskItem } from "../store/task-store";

export interface FalVeedJobProgress {
  lipsyncId: string;
  downloadUrl?: string;
}

export interface FalVeedLipsyncOptions {
  videoPath: string;
  audioPath: string;
  videoUrl?: string;
  audioUrl?: string;
  objectKeyPrefix?: string;
  onLog?: (msg: string) => void;
  onProviderAccepted?: () => void;
  onJobCreated?: (info: FalVeedJobProgress) => void;
  onResultReady?: (info: FalVeedJobProgress) => void;
  onChunkProgress?: (chunk: NonNullable<TaskItem["results"]["lipsyncChunks"]>[number]) => void;
}

export interface FalVeedLipsyncResult {
  lipsyncId: string;
  status: "completed" | "failed";
  downloadUrl?: string;
  chunkCount?: number;
}

type FalQueueSubmit = {
  request_id?: string;
  status?: string;
  response_url?: string;
  status_url?: string;
  detail?: unknown;
  error?: unknown;
};

type FalQueueStatus = {
  status?: string;
  request_id?: string;
  response_url?: string;
  error?: unknown;
  detail?: unknown;
};

type FalQueueResult = {
  video?: { url?: string };
  video_url?: string;
  error?: unknown;
  detail?: unknown;
  status?: string;
};

function isPublicHttpUrl(url?: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      parsed.hostname !== "localhost" &&
      parsed.hostname !== "127.0.0.1"
    );
  } catch {
    return false;
  }
}

function mimeForFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".webm") return "video/webm";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".m4a") return "audio/x-m4a";
  if (ext === ".aac") return "audio/aac";
  return "application/octet-stream";
}

function formatFalError(payload: unknown, fallback: string): string {
  if (!payload) return fallback;
  if (typeof payload === "string") return payload;
  if (typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    if (typeof record.msg === "string") return record.msg;
    if (typeof record.detail === "string") return record.detail;
    try {
      return JSON.stringify(payload).slice(0, 240);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export class FalVeedLipsyncAdapter {
  private static headers(apiKey: string, extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Key ${apiKey}`,
      ...extra,
    };
  }

  private static queueBase(model: string): string {
    return `https://queue.fal.run/${model.replace(/^\/+|\/+$/g, "")}`;
  }

  private static async parseJson<T>(resp: Response): Promise<T> {
    const text = await resp.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`VEED / fal 返回了无法解析的响应 (${resp.status}): ${text.slice(0, 240)}`);
    }
  }

  private static async fetchWithRetry(
    url: string,
    init: RequestInit,
    attempts = 4
  ): Promise<Response> {
    let lastError: Error | null = null;
    for (let i = 0; i < attempts; i++) {
      try {
        const resp = await fetchWithOutboundUrlPolicy(
          url,
          init,
          { ...providerUrlPolicy("fal"), sensitiveHeaders: Boolean(new Headers(init.headers).get("Authorization")) },
        );
        if (resp.status >= 500 || resp.status === 429) {
          lastError = new Error(`HTTP ${resp.status}`);
          await new Promise((r) => setTimeout(r, 2500 * (i + 1)));
          continue;
        }
        return resp;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        await new Promise((r) => setTimeout(r, 2500 * (i + 1)));
      }
    }
    throw lastError || new Error("VEED / fal 请求失败");
  }

  private static async uploadToFalStorage(params: {
    apiKey: string;
    filePath: string;
    label: string;
    onLog: (msg: string) => void;
  }): Promise<string> {
    const { apiKey, filePath, label, onLog } = params;
    if (!fs.existsSync(filePath)) {
      throw new Error(`找不到本地${label}文件: ${filePath}`);
    }

    const contentType = mimeForFile(filePath);
    const fileName = path.basename(filePath);
    const endpoints = [
      "https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3",
      "https://rest.alpha.fal.ai/storage/upload/initiate",
    ];

    onLog(`[VEED] 正在上传本地${label}到 fal 存储...`);
    let lastError: Error | null = null;

    for (const endpoint of endpoints) {
      try {
        const initiateResp = await this.fetchWithRetry(endpoint, {
          method: "POST",
          headers: this.headers(apiKey, { "Content-Type": "application/json" }),
          body: JSON.stringify({
            file_name: fileName,
            content_type: contentType,
          }),
        });
        if (!initiateResp.ok) {
          const text = await initiateResp.text();
          lastError = new Error(`发起上传失败 (${initiateResp.status}): ${text.slice(0, 180)}`);
          continue;
        }
        const initiated = await this.parseJson<{ upload_url?: string; file_url?: string }>(
          initiateResp
        );
        if (!initiated.upload_url || !initiated.file_url) {
          lastError = new Error("fal 存储未返回 upload_url / file_url");
          continue;
        }

        await validateOutboundUrl(initiated.upload_url, providerUrlPolicy("fal"));
        await validateOutboundUrl(initiated.file_url, providerUrlPolicy("fal"));

        const buf = fs.readFileSync(filePath);
        const putResp = await this.fetchWithRetry(initiated.upload_url, {
          method: "PUT",
          headers: { "Content-Type": contentType },
          body: buf,
        });
        if (!putResp.ok) {
          lastError = new Error(`上传${label}失败 (${putResp.status})`);
          continue;
        }
        onLog(`[VEED] ${label}已上传 (${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
        return initiated.file_url;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    throw lastError || new Error(`上传${label}到 fal 存储失败`);
  }

  private static async resolveMediaUrl(params: {
    apiKey: string;
    filePath: string;
    fileUrl?: string;
    objectKey?: string;
    label: string;
    onLog: (msg: string) => void;
  }): Promise<string> {
    const { apiKey, filePath, fileUrl, objectKey, label, onLog } = params;
    if (isPublicHttpUrl(fileUrl)) {
      onLog(`[VEED] 使用公网直链作为${label}`);
      return fileUrl as string;
    }
    if (objectKey && CosService.isConfigured()) {
      onLog(`[VEED] 正在将${label}同步到 COS 公网直链...`);
      await CosService.uploadFile(filePath, objectKey);
      return CosService.getDownloadUrl(objectKey, undefined, 6 * 60 * 60);
    }
    return this.uploadToFalStorage({ apiKey, filePath, label, onLog });
  }

  private static async executeOnce(
    options: FalVeedLipsyncOptions & { outputPath: string; durationSeconds?: number },
    ctx: { apiKey: string; model: string }
  ): Promise<FalVeedLipsyncResult> {
    const { onLog = () => {}, outputPath } = options;
    const { apiKey, model } = ctx;
    const queueBase = this.queueBase(model);

    const videoUrl = await this.resolveMediaUrl({
      apiKey,
      filePath: options.videoPath,
      fileUrl: options.videoUrl,
      objectKey: options.objectKeyPrefix
        ? `${options.objectKeyPrefix}/source-video.mp4`
        : undefined,
      label: "视频",
      onLog,
    });
    const audioUrl = await this.resolveMediaUrl({
      apiKey,
      filePath: options.audioPath,
      fileUrl: options.audioUrl,
      objectKey: options.objectKeyPrefix
        ? `${options.objectKeyPrefix}/voice-track.wav`
        : undefined,
      label: "音频",
      onLog,
    });

    onLog(`[VEED] 正在提交 ${model} 对口型任务...`);
    const submitResp = await this.fetchWithRetry(queueBase, {
      method: "POST",
      headers: this.headers(apiKey, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        video_url: videoUrl,
        audio_url: audioUrl,
      }),
    });
    const submitted = await this.parseJson<FalQueueSubmit>(submitResp);
    if (!submitResp.ok || !submitted.request_id) {
      throw new Error(
        `创建 VEED 对口型任务失败: ${formatFalError(
          submitted.detail || submitted.error || submitted,
          `HTTP ${submitResp.status}`
        )}`
      );
    }

    const lipsyncId = submitted.request_id;
    options.onProviderAccepted?.();
    options.onJobCreated?.({ lipsyncId });
    const statusUrl =
      submitted.status_url || `${queueBase}/requests/${lipsyncId}/status`;
    const responseUrl = submitted.response_url || `${queueBase}/requests/${lipsyncId}`;
    assertSameOrigin(statusUrl, queueBase);
    assertSameOrigin(responseUrl, queueBase);
    onLog(`[VEED] 任务已建立 (ID: ${lipsyncId})，开始轮询进度...`);

    const timeoutMs = pollTimeoutMs(options.durationSeconds || 90);
    const pollDeadline = Date.now() + timeoutMs;
    let completedUrl: string | null = null;
    let pollCount = 0;

    while (Date.now() < pollDeadline) {
      await new Promise((r) => setTimeout(r, 6000));
      pollCount++;

      try {
        const pollResp = await this.fetchWithRetry(statusUrl, {
          headers: this.headers(apiKey),
        });
        const polled = await this.parseJson<FalQueueStatus>(pollResp);
        const status = String(polled.status || "").toUpperCase();

        if (status === "COMPLETED") {
          const fetched = await this.fetchCompletedVideo({
            apiKey,
            responseUrl,
          });
          completedUrl = fetched.url;
          options.onResultReady?.({
            lipsyncId,
            downloadUrl: completedUrl,
          });
          onLog("[VEED] 对口型渲染完成，成片地址已保存，开始下载（失败可免费恢复，不会再扣费）...");
          break;
        }
        if (status === "FAILED" || status === "ERROR" || status === "CANCELLED") {
          throw new Error(
            `[VEED] 对口型生成失败: ${formatFalError(polled.error || polled.detail, status)}`
          );
        }
        if (pollCount % 3 === 0) {
          const remainMin = Math.max(1, Math.round((pollDeadline - Date.now()) / 60000));
          onLog(`[VEED] 正在渲染中 (轮询第 ${pollCount} 次，最长还等 ${remainMin} 分钟)...`);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("对口型生成失败")) {
          throw err;
        }
        onLog(`[VEED] 轮询暂时失败，将重试: ${message}`);
      }
    }

    if (!completedUrl) {
      throw new Error("[VEED] 对口型任务超时");
    }

    const downloaded = await downloadFileToDisk({
      url: completedUrl,
      outputPath,
      onProgress: (msg) => onLog(`[VEED] ${msg}`),
      urlPolicy: providerUrlPolicy("fal"),
    });
    onLog(`[VEED] 成片已下载 (${(downloaded.bytes / 1024 / 1024).toFixed(2)} MB)`);

    return {
      lipsyncId,
      status: "completed",
      downloadUrl: completedUrl,
      chunkCount: 1,
    };
  }

  private static async fetchCompletedVideo(params: {
    apiKey: string;
    responseUrl: string;
  }): Promise<{ url: string }> {
    const resp = await this.fetchWithRetry(params.responseUrl, {
      headers: this.headers(params.apiKey),
    });
    const payload = await this.parseJson<FalQueueResult>(resp);
    if (!resp.ok) {
      throw new Error(
        `读取 VEED 成片失败: ${formatFalError(payload.detail || payload.error || payload, `HTTP ${resp.status}`)}`
      );
    }
    const url = payload.video?.url || payload.video_url;
    if (!url) {
      throw new Error("VEED 任务已完成但未返回成片地址");
    }
    return { url };
  }

  public static async fetchResult(requestId: string): Promise<{
    status: string;
    url?: string;
  }> {
    const config = getAppConfig();
    const apiKey = config.falApiKey?.trim();
    const model = config.falVeedModel || "veed/lipsync";
    if (!apiKey) {
      throw new Error("未配置 fal API Key，请先在系统设置中填写");
    }

    const queueBase = this.queueBase(model);
    const statusResp = await this.fetchWithRetry(
      `${queueBase}/requests/${requestId}/status`,
      { headers: this.headers(apiKey) }
    );
    const polled = await this.parseJson<FalQueueStatus>(statusResp);
    const status = String(polled.status || "").toUpperCase();
    if (status !== "COMPLETED") {
      return { status: status || "UNKNOWN" };
    }

    const completedResponseUrl = polled.response_url || `${queueBase}/requests/${requestId}`;
    assertSameOrigin(completedResponseUrl, queueBase);
    const fetched = await this.fetchCompletedVideo({
      apiKey,
      responseUrl: completedResponseUrl,
    });
    return { status, url: fetched.url };
  }

  public static async execute(
    options: FalVeedLipsyncOptions,
    outDir: string
  ): Promise<FalVeedLipsyncResult> {
    const config = getAppConfig();
    const { onLog = () => {} } = options;
    const apiKey = config.falApiKey?.trim();
    const model = config.falVeedModel || "veed/lipsync";

    if (!apiKey) {
      throw new Error("未配置 fal API Key，请先在系统设置中填写");
    }

    const audioProbe = await probeMedia(options.audioPath);
    const chunks = planLipsyncChunks(audioProbe.durationSeconds);
    const rawVideoPath = path.join(outDir, "rendered-source.mp4");
    const ctx = { apiKey, model };

    onLog(
      `[VEED] 口播时长 ${audioProbe.durationSeconds.toFixed(1)}s，将按每段不超过 ${LIPSYNC_CHUNK_SECONDS}s 提交 ${chunks.length} 个对口型任务`
    );

    if (chunks.length === 1) {
      return this.executeOnce(
        {
          ...options,
          durationSeconds: audioProbe.durationSeconds,
          outputPath: rawVideoPath,
        },
        ctx
      );
    }

    const chunkDir = path.join(outDir, "lipsync-chunks");
    fs.mkdirSync(chunkDir, { recursive: true });
    const rendered: string[] = [];
    const jobIds: string[] = [];

    for (const chunk of chunks) {
      const label = `${chunk.index + 1}/${chunks.length}`;
      onLog(
        `[VEED] 正在处理第 ${label} 段 (${chunk.startSeconds.toFixed(1)}s–${(
          chunk.startSeconds + chunk.durationSeconds
        ).toFixed(1)}s)...`
      );

      const chunkVideo = path.join(chunkDir, `video-${chunk.index}.mp4`);
      const chunkAudio = path.join(chunkDir, `audio-${chunk.index}.wav`);
      const chunkOut = path.join(chunkDir, `result-${chunk.index}.mp4`);

      await sliceMedia({
        inputPath: options.videoPath,
        outputPath: chunkVideo,
        startSeconds: chunk.startSeconds,
        durationSeconds: chunk.durationSeconds,
        kind: "video",
      });
      await sliceMedia({
        inputPath: options.audioPath,
        outputPath: chunkAudio,
        startSeconds: chunk.startSeconds,
        durationSeconds: chunk.durationSeconds,
        kind: "audio",
      });

      const result = await this.executeOnce(
        {
          videoPath: chunkVideo,
          audioPath: chunkAudio,
          objectKeyPrefix: options.objectKeyPrefix
            ? `${options.objectKeyPrefix}/chunk-${chunk.index}`
            : undefined,
          durationSeconds: chunk.durationSeconds,
          outputPath: chunkOut,
          onLog,
          onProviderAccepted: options.onProviderAccepted,
          onJobCreated: info => {
            options.onJobCreated?.(info);
            options.onChunkProgress?.({ index: chunk.index, lipsyncId: info.lipsyncId, status: "created" });
          },
          onResultReady: info => {
            options.onResultReady?.(info);
            options.onChunkProgress?.({ index: chunk.index, lipsyncId: info.lipsyncId, resultUrl: info.downloadUrl, status: "ready" });
          },
        },
        ctx
      );
      rendered.push(chunkOut);
      jobIds.push(result.lipsyncId);
      options.onChunkProgress?.({ index: chunk.index, lipsyncId: result.lipsyncId,
        outputName: `lipsync-chunks/result-${chunk.index}.mp4`, status: "downloaded" });
    }

    onLog(`[VEED] ${chunks.length} 段已完成，正在拼接成完整画面...`);
    await concatVideos(rendered, rawVideoPath);

    return {
      lipsyncId: jobIds.join(","),
      status: "completed",
      chunkCount: chunks.length,
    };
  }
}
