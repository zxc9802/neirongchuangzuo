import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { getAppConfig } from "../config";
import { CosService } from "../cos";
import { concatVideos, probeMedia, sliceMedia } from "./ffmpeg";
import { downloadFileToDisk } from "./download-file";
import { exactHostUrlPolicy } from "../server/outbound-url-policy";
import { downloadPixverseResult } from "./pixverse-ingest";
import { LIPSYNC_CHUNK_SECONDS, planLipsyncChunks, pollTimeoutMs } from "./lipsync-chunks";

export interface OpenLuxJobProgress {
  lipsyncId: string;
  downloadUrl?: string;
  creditsUsed?: number;
}

export interface OpenLuxChunkProgress {
  index: number;
  lipsyncId?: string;
  resultUrl?: string;
  outputName?: string;
  status: "created" | "ready" | "downloaded";
}

export interface OpenLuxLipsyncOptions {
  videoPath: string;
  audioPath: string;
  videoUrl?: string;
  audioUrl?: string;
  existingChunks?: OpenLuxChunkProgress[];
  onLog?: (msg: string) => void;
  onProviderAccepted?: () => void;
  onJobCreated?: (info: OpenLuxJobProgress) => void;
  onResultReady?: (info: OpenLuxJobProgress) => void;
  onChunkProgress?: (chunk: OpenLuxChunkProgress) => void;
}

export interface OpenLuxLipsyncResult {
  lipsyncId: string;
  status: "completed" | "failed";
  downloadUrl?: string;
  creditsUsed?: number;
  chunkCount?: number;
}

type OpenLuxEnvelope = {
  ErrCode?: number;
  ErrMsg?: string;
  Resp?: Record<string, any>;
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

export class OpenLuxLipsyncAdapter {
  private static headers(apiKey: string, extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${apiKey}`,
      "API-KEY": apiKey,
      "Ai-Trace-Id": randomUUID(),
      ...extra,
    };
  }

  private static async parseJson(resp: Response): Promise<OpenLuxEnvelope> {
    const text = await resp.text();
    try {
      return JSON.parse(text) as OpenLuxEnvelope;
    } catch {
      throw new Error(`OpenLux 返回了无法解析的响应 (${resp.status}): ${text.slice(0, 240)}`);
    }
  }

  private static assertOk(data: OpenLuxEnvelope, action: string): Record<string, any> {
    if ((data.ErrCode ?? 1) !== 0) {
      throw new Error(`${action}失败: ${data.ErrMsg || `ErrCode ${data.ErrCode}`}`);
    }
    return data.Resp || {};
  }

  private static async uploadMedia(params: {
    baseUrl: string;
    apiKey: string;
    filePath: string;
    fileUrl?: string;
    label: string;
    onLog: (msg: string) => void;
  }): Promise<number> {
    const { baseUrl, apiKey, filePath, fileUrl, label, onLog } = params;
    const form = new FormData();

    if (isPublicHttpUrl(fileUrl)) {
      form.append("file_url", fileUrl as string);
      onLog(`[PixVerse] 正在通过公网直链上传${label}...`);
    } else {
      if (!fs.existsSync(filePath)) {
        throw new Error(`找不到本地${label}文件: ${filePath}`);
      }
      const buf = fs.readFileSync(filePath);
      const blob = new Blob([new Uint8Array(buf)], { type: mimeForFile(filePath) });
      form.append("file", blob, path.basename(filePath));
      onLog(`[PixVerse] 正在上传本地${label} (${(buf.length / 1024 / 1024).toFixed(2)} MB)...`);
    }

    const resp = await this.fetchWithRetry(`${baseUrl}/openapi/v2/media/upload`, {
      method: "POST",
      headers: this.headers(apiKey),
      body: form,
    });
    const payload = this.assertOk(await this.parseJson(resp), `上传${label}`);
    const mediaId = Number(payload.media_id);
    if (!mediaId) {
      throw new Error(`上传${label}成功但未返回 media_id`);
    }
    onLog(`[PixVerse] ${label}已就绪 (media_id: ${mediaId})`);
    return mediaId;
  }

  private static async fetchWithRetry(
    url: string,
    init: RequestInit,
    attempts = 4
  ): Promise<Response> {
    let lastError: Error | null = null;
    for (let i = 0; i < attempts; i++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      try {
        const resp = await fetch(url, {
          ...init,
          signal: controller.signal,
          redirect: "error",
        });
        if (resp.status >= 500 || resp.status === 429) {
          lastError = new Error(`HTTP ${resp.status}`);
          await new Promise((r) => setTimeout(r, 2500 * (i + 1)));
          continue;
        }
        return resp;
      } catch (err: any) {
        const name = err?.name || "";
        const message = err instanceof Error ? err.message : String(err);
        lastError = name === "AbortError" ? new Error("查询超时") : new Error(message);
        await new Promise((r) => setTimeout(r, 2500 * (i + 1)));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new Error("OpenLux 请求失败");
  }

  private static async executeOnce(
    options: OpenLuxLipsyncOptions & {
      outputPath: string;
      durationSeconds?: number;
      resumeJobId?: string;
    },
    ctx: { apiKey: string; baseUrl: string; model: string }
  ): Promise<OpenLuxLipsyncResult> {
    const { onLog = () => {}, outputPath } = options;
    const { apiKey, baseUrl, model } = ctx;

    let lipsyncId = String(options.resumeJobId || "").trim();
    let creditsUsed: number | undefined;

    if (lipsyncId) {
      onLog(`[PixVerse] 发现已扣费任务 (ID: ${lipsyncId})，跳过重新提交，继续轮询...`);
      options.onJobCreated?.({ lipsyncId });
    } else {
      const videoMediaId = await this.uploadMedia({
        baseUrl,
        apiKey,
        filePath: options.videoPath,
        fileUrl: options.videoUrl,
        label: "视频",
        onLog,
      });
      const audioMediaId = await this.uploadMedia({
        baseUrl,
        apiKey,
        filePath: options.audioPath,
        fileUrl: options.audioUrl,
        label: "音频",
        onLog,
      });

      onLog(`[PixVerse] 正在提交 pixverse-lipsync 对口型任务...`);
      const createResp = await this.fetchWithRetry(`${baseUrl}/openapi/v2/video/lip_sync/generate`, {
        method: "POST",
        headers: this.headers(apiKey, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          model,
          video_media_id: videoMediaId,
          audio_media_id: audioMediaId,
        }),
      });
      const created = this.assertOk(await this.parseJson(createResp), "创建对口型任务");
      options.onProviderAccepted?.();
      lipsyncId = String(created.video_id || "");
      if (!lipsyncId) {
        throw new Error("OpenLux 未返回 video_id");
      }
      creditsUsed = Number(created.credits || 0) || undefined;
      onLog(
        `[PixVerse] 任务已建立 (ID: ${lipsyncId})${creditsUsed ? `，预计扣除 ${creditsUsed} credits` : ""}，开始轮询进度...`
      );
      options.onJobCreated?.({ lipsyncId, creditsUsed });
    }

    const timeoutMs = pollTimeoutMs(options.durationSeconds || 90);
    const pollDeadline = Date.now() + timeoutMs;
    let completedUrl: string | null = null;
    let pollCount = 0;

    while (Date.now() < pollDeadline) {
      await new Promise((r) => setTimeout(r, 6000));
      pollCount++;

      try {
        const pollResp = await this.fetchWithRetry(
          `${baseUrl}/openapi/v2/video/result/${lipsyncId}`,
          { headers: this.headers(apiKey) }
        );
        const polled = this.assertOk(await this.parseJson(pollResp), "查询对口型进度");
        const status = Number(polled.status);

        if (status === 1) {
          completedUrl = polled.url || null;
          if (completedUrl) {
            options.onResultReady?.({
              lipsyncId,
              downloadUrl: completedUrl,
              creditsUsed,
            });
            onLog(`[PixVerse] 对口型渲染完成，成片地址已保存，开始下载（失败可免费恢复，不会再扣费）...`);
          } else {
            onLog("[PixVerse] 对口型渲染完成，正在下载成片...");
          }
          break;
        }
        if (status === 7) {
          throw new Error("[PixVerse] 内容审核未通过");
        }
        if (status === 8) {
          throw new Error(`[PixVerse] 对口型生成失败${polled.ErrMsg ? `: ${polled.ErrMsg}` : ""}`);
        }
        const remainMin = Math.max(1, Math.round((pollDeadline - Date.now()) / 60000));
        onLog(`[PixVerse] 正在渲染中 (轮询第 ${pollCount} 次，最长还等 ${remainMin} 分钟)...`);
      } catch (err: any) {
        if (String(err.message || "").includes("内容审核") || String(err.message || "").includes("生成失败")) {
          throw err;
        }
        onLog(`[PixVerse] 轮询暂时失败，将重试: ${err.message}`);
      }
    }

    if (!completedUrl) {
      throw new Error("[PixVerse] 对口型任务超时");
    }

    const downloaded = await downloadPixverseResult({
      url: completedUrl,
      outputPath,
      onLog,
    });
    onLog(
      `[PixVerse] 成片已下载 (${(downloaded.bytes / 1024 / 1024).toFixed(2)} MB${
        downloaded.viaRelay ? "，经广州中转" : ""
      })`
    );

    return {
      lipsyncId,
      status: "completed",
      downloadUrl: completedUrl,
      creditsUsed,
      chunkCount: 1,
    };
  }

  public static async fetchResult(videoId: string): Promise<{
    status: number;
    url?: string;
    creditsUsed?: number;
  }> {
    const config = getAppConfig();
    const apiKey = config.openluxApiKey?.trim();
    const baseUrl = (config.openluxBaseUrl || "https://api.openlux.ai").replace(/\/$/, "");
    if (!apiKey) {
      throw new Error("未配置 OpenLux API Key，请先在系统设置中填写");
    }

    const pollResp = await this.fetchWithRetry(`${baseUrl}/openapi/v2/video/result/${videoId}`, {
      headers: this.headers(apiKey),
    });
    const polled = this.assertOk(await this.parseJson(pollResp), "查询对口型结果");
    return {
      status: Number(polled.status),
      url: polled.url || undefined,
      creditsUsed: Number(polled.credits || 0) || undefined,
    };
  }

  public static async execute(
    options: OpenLuxLipsyncOptions,
    outDir: string
  ): Promise<OpenLuxLipsyncResult> {
    const config = getAppConfig();
    const { onLog = () => {} } = options;
    const apiKey = config.openluxApiKey?.trim();
    const baseUrl = (config.openluxBaseUrl || "https://api.openlux.ai").replace(/\/$/, "");
    const model = config.openluxLipsyncModel || "pixverse-lipsync";

    if (!apiKey) {
      throw new Error("未配置 OpenLux API Key，请先在系统设置中填写");
    }

    const audioProbe = await probeMedia(options.audioPath);
    const chunks = planLipsyncChunks(audioProbe.durationSeconds);
    const rawVideoPath = path.join(outDir, "rendered-source.mp4");
    const ctx = { apiKey, baseUrl, model };

    onLog(
      `[PixVerse] 口播时长 ${audioProbe.durationSeconds.toFixed(1)}s，将按每段不超过 ${LIPSYNC_CHUNK_SECONDS}s 提交 ${chunks.length} 个对口型任务`
    );

    if (chunks.length === 1) {
      return this.executeOnce(
        {
          ...options,
          durationSeconds: audioProbe.durationSeconds,
          outputPath: rawVideoPath,
          resumeJobId: options.existingChunks?.find((item) => item.index === 0)?.lipsyncId,
        },
        ctx
      );
    }

    const chunkDir = path.join(outDir, "lipsync-chunks");
    fs.mkdirSync(chunkDir, { recursive: true });
    const rendered: string[] = [];
    const jobIds: string[] = [];
    let creditsUsed = 0;
    const taskId = path.basename(outDir);
    const saved = options.existingChunks || [];

    for (const chunk of chunks) {
      const label = `${chunk.index + 1}/${chunks.length}`;
      const chunkVideo = path.join(chunkDir, `video-${chunk.index}.mp4`);
      const chunkAudio = path.join(chunkDir, `audio-${chunk.index}.wav`);
      const chunkOut = path.join(chunkDir, `result-${chunk.index}.mp4`);
      const outputName = `lipsync-chunks/result-${chunk.index}.mp4`;
      const savedChunk = saved.find((item) => item.index === chunk.index);

      const hasLocal =
        fs.existsSync(chunkOut) && fs.statSync(chunkOut).size > 1024 * 1024;
      if (!hasLocal && CosService.isConfigured()) {
        const cosKey = `jobs/${taskId}/${outputName}`;
        if (await CosService.objectExists(cosKey)) {
          onLog(`[PixVerse] 第 ${label} 段已在 COS，正在取回，不重复扣费...`);
          const pullUrl = await CosService.getDownloadUrl(cosKey, path.basename(chunkOut));
          await downloadFileToDisk({
            url: pullUrl,
            outputPath: chunkOut,
            urlPolicy: exactHostUrlPolicy(pullUrl, "cos"),
          });
        }
      }

      if (fs.existsSync(chunkOut) && fs.statSync(chunkOut).size > 1024 * 1024) {
        onLog(`[PixVerse] 第 ${label} 段已完成，跳过重新提交`);
        rendered.push(chunkOut);
        if (savedChunk?.lipsyncId) jobIds.push(savedChunk.lipsyncId);
        options.onChunkProgress?.({
          index: chunk.index,
          lipsyncId: savedChunk?.lipsyncId,
          outputName,
          status: "downloaded",
        });
        continue;
      }

      onLog(
        `[PixVerse] 正在处理第 ${label} 段 (${chunk.startSeconds.toFixed(1)}s–${(
          chunk.startSeconds + chunk.durationSeconds
        ).toFixed(1)}s)...`
      );

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
          durationSeconds: chunk.durationSeconds,
          outputPath: chunkOut,
          resumeJobId: savedChunk?.lipsyncId,
          onLog,
          onProviderAccepted: options.onProviderAccepted,
          onJobCreated: (info) => {
            options.onJobCreated?.(info);
            options.onChunkProgress?.({
              index: chunk.index,
              lipsyncId: info.lipsyncId,
              outputName,
              status: "created",
            });
          },
          onResultReady: (info) => {
            options.onResultReady?.(info);
            options.onChunkProgress?.({
              index: chunk.index,
              lipsyncId: info.lipsyncId,
              resultUrl: info.downloadUrl,
              outputName,
              status: "ready",
            });
          },
        },
        ctx
      );
      rendered.push(chunkOut);
      jobIds.push(result.lipsyncId);
      creditsUsed += result.creditsUsed || 0;
      options.onChunkProgress?.({
        index: chunk.index,
        lipsyncId: result.lipsyncId,
        resultUrl: result.downloadUrl,
        outputName,
        status: "downloaded",
      });
    }

    onLog(`[PixVerse] ${chunks.length} 段已完成，正在拼接成完整画面...`);
    await concatVideos(rendered, rawVideoPath);

    return {
      lipsyncId: jobIds.join(","),
      status: "completed",
      creditsUsed: creditsUsed || undefined,
      chunkCount: chunks.length,
    };
  }
}
