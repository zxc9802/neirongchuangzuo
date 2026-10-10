import { createVideoPreview } from "./video-preview";
import fs from "fs";
import path from "path";
import { CosService } from "../cos";
import { resolveLipsyncProvider } from "../lipsync-provider";
import { TaskItem, TaskStore } from "../store/task-store";
import { concatVideos, probeMedia, sha256File } from "./ffmpeg";
import { restoreFaceLipsync, finalizeFaceLipsync } from "./face-lipsync";
import { deliverNarrationFallback } from "./narration-fallback";
import { logServerError } from "../server/safe-log";
import { planLipsyncChunks } from "./lipsync-chunks";
import { withTaskExecution } from "./task-execution";
import { downloadFileToDisk } from "./download-file";
import { FalVeedLipsyncAdapter } from "./fal-veed-lipsync";
import { downloadPixverseResult } from "./pixverse-ingest";
import { OpenLuxLipsyncAdapter } from "./openlux-lipsync";
import {
  calculateRequiredPoints,
  calculateCostCny,
  settleMainAppCredits,
  releaseMainAppCredits,
} from "../main-app-billing";
import { getAppConfig } from "../config";
import { providerUrlPolicy } from "../server/outbound-url-policy";
import { downloadTrustedMediaToFile } from "../server/media-response";
import { isTaskOutputExpired } from "../task-output-retention";

const LIPSYNC_JOB_RE = /任务已建立 \(ID:\s*([^，)\s]+)\)/;

type SavedChunk = NonNullable<TaskItem["results"]["lipsyncChunks"]>[number];

function savedChunks(task: TaskItem): SavedChunk[] {
  if (task.results.lipsyncChunks?.length) return task.results.lipsyncChunks;
  const savedIds = (task.results.heygenLipsyncId || "").split(",").map(id => id.trim()).filter(Boolean);
  const loggedIds = [...new Set((task.logs || []).flatMap(entry => {
    const match = entry.message.match(LIPSYNC_JOB_RE);
    return match ? [match[1]] : [];
  }))];
  const ids = savedIds.length > 1 ? savedIds : loggedIds.length > 1 ? loggedIds : savedIds.length ? savedIds : loggedIds;
  if (!ids.length && savedResultUrl(task)) ids.push("");
  return ids.map((lipsyncId, index) => ({
    index, lipsyncId: lipsyncId || undefined, status: "created",
    resultUrl: ids.length === 1 ? savedResultUrl(task) : undefined,
  }));
}

async function verifyVideoDuration(file: string, expectedSeconds: number) {
  const probe = await probeMedia(file);
  const seconds = probe.videoDurationSeconds ?? (!probe.hasAudio ? probe.durationSeconds : undefined);
  if (!probe.width || !Number.isFinite(seconds) || Math.abs(seconds! - expectedSeconds) > 0.5) {
    throw new Error("恢复的视频画面不完整，请稍后重试");
  }
  return probe;
}

function taskLipsyncProvider(task: TaskItem) {
  return resolveLipsyncProvider(
    task.inputs.lipsyncProvider || task.results.lipsyncProvider,
    "pixverse"
  );
}

function savedResultUrl(task: TaskItem): string | undefined {
  return task.results?.veedResultUrl || task.results?.pixverseResultUrl || task.results?.heygenResultUrl;
}

export function extractPixverseJobId(task: TaskItem): string | null {
  const saved = task.results?.heygenLipsyncId?.trim();
  if (saved && !saved.includes(",")) return saved;

  for (let i = (task.logs || []).length - 1; i >= 0; i--) {
    const match = task.logs[i].message.match(LIPSYNC_JOB_RE);
    if (match?.[1]) return match[1];
  }
  return saved || null;
}

export function isRecoverableLipsyncTask(task: TaskItem): boolean {
  if (isTaskOutputExpired(task)) return false;
  if (task.billing?.isExternalUser && task.billing.status === "released") return false;
  if (
    task.status === "completed" &&
    (task.results?.finalVideoUrl || task.inputs.outputType === "audio" && task.results?.exactAudioUrl) &&
    (!task.billing?.isExternalUser || task.billing.status === "settled")
  ) return false;
  return Boolean(
    task.results?.finalVideoUrl ||
      (task.inputs.outputType === "audio" && task.results?.exactAudioUrl && task.results.audioFormat === "mp3") ||
      extractPixverseJobId(task) ||
      savedResultUrl(task) ||
      task.results.lipsyncChunks?.length ||
      (task.logs || []).some((entry) => entry.message.includes("正在下载成片"))
  );
}

async function markCompleted(
  taskId: string,
  results: TaskItem["results"],
  message: string,
  sessionToken?: string,
): Promise<TaskItem> {
  const task = TaskStore.get(taskId);
  if (!task) throw new Error("任务不存在，无法写入恢复结果");
  const duration = task.inputs.outputType === "audio" ? results.audioDuration : results.videoDuration;
  if (!Number.isFinite(duration) || !duration || duration <= 0) {
    throw new Error("成片时长无效，不能结算交付");
  }
  let chargedPoints =
    (task.billing?.source === "workspace" ? undefined : results.chargedPoints) ??
    (task.billing?.isExternalUser
      ? calculateRequiredPoints(duration, task.billing.source)
      : undefined);
  const costCny =
    results.costCny ??
    (task.billing?.isExternalUser ? calculateCostCny(duration, task.billing.source) : undefined);

  let pointsBalanceAfter = task.billing?.pointsBalanceAfter;
  if (task.billing?.isExternalUser) {
    if (task.billing.status === "released") {
      throw new Error("该任务的积分预留已释放，不能直接恢复交付");
    }
    if (!task.userId || !task.billing.requestId) {
      throw new Error("任务缺少结算标识，不能恢复交付");
    }
    TaskStore.update(taskId, {
      billing: { ...task.billing, status: "settle_pending" },
    });
    const settlement = await settleMainAppCredits({
      userId: task.userId,
      requestId: task.billing.requestId,
      actualDuration: duration,
      chargedPoints,
      sessionToken,
      source: task.billing.source,
    });
    pointsBalanceAfter = settlement.pointsBalance;
    chargedPoints = settlement.chargedPoints;
  }

  TaskStore.addLog(taskId, message, "success", "成片已恢复，任务已完成");

  const updated = TaskStore.update(taskId, {
    status: "completed",
    step: "done",
    progress: 100,
    error: undefined,
    errorCode: undefined,
    billing: task.billing
      ? {
          ...task.billing,
          actualDuration: duration,
          chargedPoints,
          costCny,
          pointsBalanceAfter,
          status: task.billing.isExternalUser ? "settled" : "not_applicable",
        }
      : undefined,
    results: {
      ...results,
      chargedPoints,
      costCny,
      billingDuration: duration,
    },
  });
  if (!updated) {
    throw new Error("任务不存在，无法写入恢复结果");
  }
  return updated;
}

async function ensureLocalFile(params: {
  localPath: string;
  cosKey: string;
  fallbackUrl?: string;
  label: string;
  onLog: (msg: string) => void;
}): Promise<string> {
  const { localPath, cosKey, fallbackUrl, label, onLog } = params;
  if (fs.existsSync(localPath) && fs.statSync(localPath).size > 1024) {
    return localPath;
  }

  fs.mkdirSync(path.dirname(localPath), { recursive: true });

  if (CosService.isConfigured() && (await CosService.objectExists(cosKey))) {
    onLog(`正在从 COS 取回${label}...`);
    const url = await CosService.getDownloadUrl(cosKey, path.basename(cosKey));
    await downloadTrustedMediaToFile({ source: url, outputPath: localPath });
    return localPath;
  }

  if (fallbackUrl) {
    onLog(`正在下载${label}...`);
    await downloadTrustedMediaToFile({ source: fallbackUrl, outputPath: localPath });
    return localPath;
  }

  throw new Error(`找不到${label}，无法恢复混流`);
}

export async function recoverStuckLipsyncTask(
  taskId: string,
  sessionToken?: string,
): Promise<TaskItem> {
  return withTaskExecution(taskId, async () => {
    try {
      return await recoverTask(taskId, sessionToken);
    } catch (error) {
      const task = TaskStore.get(taskId);
      const errorCode = (error as { code?: string })?.code;
      if (!/^(BILLING_|INSUFFICIENT_|NETWORK_ERROR)/.test(errorCode || "")) {
        try {
          const fallback = await deliverNarrationFallback(taskId, sessionToken);
          if (fallback) return fallback;
        } catch (fallbackError) {
          logServerError("recovery.narration_fallback_failed", fallbackError);
        }
      }
      if (task?.billing?.isExternalUser && task.billing.status === "provider_committed" &&
        task.billing.source === "workspace" && errorCode === "LIPSYNC_GENERATION_FAILED" && task.userId && task.billing.requestId) {
        await releaseMainAppCredits({ userId: task.userId, requestId: task.billing.requestId, source: task.billing.source, sessionToken });
        TaskStore.update(taskId, { billing: { ...task.billing, status: "released" } });
      }
      TaskStore.update(taskId, { status: "failed", step: "error", failedStep: "finalize",
        error: "成片恢复未完成，请稍后重试", errorCode });
      throw error;
    }
  });
}

async function recoverTask(taskId: string, sessionToken?: string): Promise<TaskItem> {
  const task = (await TaskStore.getAsync(taskId)) || TaskStore.get(taskId);
  if (!task) {
    throw new Error("任务不存在");
  }
  if (isTaskOutputExpired(task)) throw new Error("成品已超过 3 天保留期");

  if (
    task.status === "completed" &&
    (task.results?.finalVideoUrl || task.inputs.outputType === "audio" && task.results?.exactAudioUrl) &&
    (!task.billing?.isExternalUser || task.billing.status === "settled" ||
      task.results.deliveryMode === "narration_fallback" && task.billing.status === "released")
  ) {
    return task;
  }

  if (task.billing?.isExternalUser && task.billing.status === "released") {
    throw new Error("该任务的积分预留已释放，不能直接恢复交付");
  }

  if (task.inputs.outputType === "audio") {
    if (task.results.audioFormat !== "mp3" || !task.results.exactAudioUrl) throw new Error("没有可恢复的 MP3 配音");
    const mp3Path = path.join(getAppConfig().storageDir, taskId, "voice-track.mp3");
    await ensureLocalFile({ localPath: mp3Path, cosKey: `jobs/${taskId}/voice-track.mp3`,
      fallbackUrl: task.results.exactAudioUrl, label: "MP3 配音", onLog: () => undefined });
    const probe = await probeMedia(mp3Path);
    if (!probe.hasAudio || probe.width || !Number.isFinite(probe.durationSeconds) || probe.durationSeconds <= 0) {
      throw new Error("MP3 配音无有效音轨，不能结算交付");
    }
    return markCompleted(taskId, { ...task.results, exactAudioUrl: mp3Path, audioFormat: "mp3",
      audioDuration: probe.durationSeconds, sha256Audio: await sha256File(mp3Path) }, "MP3 配音已恢复，积分核对完成", sessionToken);
  }

  if (task.billing?.isExternalUser && task.billing.status === "reserved") {
    TaskStore.update(taskId, {
      billing: { ...task.billing, status: "provider_committed" },
    });
  }

  const provider = taskLipsyncProvider(task);
  const jobDir = path.join(getAppConfig().storageDir, taskId);
  fs.mkdirSync(jobDir, { recursive: true });
  const rawPath = path.join(jobDir, "rendered-source.mp4");
  const audioPath = path.join(jobDir, "voice-track.wav");
  const finalPath = path.join(jobDir, "final.mp4");
  const log = (msg: string) => TaskStore.addLog(taskId, msg, "info", "正在恢复成片，请稍候");

  TaskStore.update(taskId, { status: "processing", step: "finalize", progress: 85, error: undefined });
  await ensureLocalFile({
    localPath: audioPath,
    cosKey: `jobs/${taskId}/voice-track.wav`,
    fallbackUrl: task.results.exactAudioUrl,
    label: "原声音轨",
    onLog: log,
  });
  const audioProbe = await probeMedia(audioPath);
  const faceWorkflow = task.results.faceWorkflowVersion === 1;
  const providerDuration = faceWorkflow ? await restoreFaceLipsync(jobDir, taskId) : audioProbe.durationSeconds;
  const providerPrefix = faceWorkflow ? `jobs/${taskId}/face-provider` : `jobs/${taskId}`;
  const plan = provider === "heygen"
    ? [{ index: 0, durationSeconds: providerDuration }]
    : planLipsyncChunks(providerDuration);
  const chunks = savedChunks(task);
  // Even a cloud final must be probed; container metadata or a missing report
  // must never stand in for the duration of the actual picture and narration.
  let rawReady = false;
  if (fs.existsSync(rawPath)) {
    try { await verifyVideoDuration(rawPath, providerDuration); rawReady = true; } catch {}
  }
  if (!faceWorkflow && !rawReady && CosService.isConfigured() && await CosService.objectExists(`jobs/${taskId}/final.mp4`)) {
    const url = await CosService.getDownloadUrl(`jobs/${taskId}/final.mp4`, "final.mp4");
    await downloadTrustedMediaToFile({ source: url, outputPath: rawPath });
    try { await verifyVideoDuration(rawPath, providerDuration); rawReady = true; } catch {}
  }
  const rendered: string[] = [];
  let creditsUsed = task.results.lipsyncCredits;

  for (const part of rawReady ? [] : plan) {
    const saved = chunks.find(chunk => chunk.index === part.index);
    const outputName = plan.length === 1 ? "rendered-source.mp4" : `lipsync-chunks/result-${part.index}.mp4`;
    const outputPath = path.join(jobDir, outputName);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    let ready = false;
    if (fs.existsSync(outputPath)) {
      try { await verifyVideoDuration(outputPath, part.durationSeconds); ready = true; } catch {}
    }
    if (!ready && CosService.isConfigured() && await CosService.objectExists(`${providerPrefix}/${outputName}`)) {
      const url = await CosService.getDownloadUrl(`${providerPrefix}/${outputName}`, path.basename(outputPath));
      await downloadTrustedMediaToFile({ source: url, outputPath });
      await verifyVideoDuration(outputPath, part.durationSeconds);
      ready = true;
    }
    let resultUrl = saved?.resultUrl;
    if (!ready) {
      if (saved?.lipsyncId && provider === "veed") {
        const remote = await FalVeedLipsyncAdapter.fetchResult(saved.lipsyncId);
        if (["FAILED", "ERROR", "CANCELLED"].includes(remote.status)) {
          throw Object.assign(new Error("分段生成失败，无法组成完整成片"), { code: "LIPSYNC_GENERATION_FAILED" });
        }
        if (remote.status !== "COMPLETED" || !remote.url) throw new Error("分段结果尚未完成，请稍后恢复");
        resultUrl = remote.url;
      } else if (saved?.lipsyncId && provider === "pixverse") {
        const remote = await OpenLuxLipsyncAdapter.fetchResult(saved.lipsyncId);
        if ([7, 8].includes(remote.status)) {
          throw Object.assign(new Error("分段生成失败，无法组成完整成片"), { code: "LIPSYNC_GENERATION_FAILED" });
        }
        if (remote.status !== 1 || !remote.url) throw new Error("分段结果尚未完成，请稍后恢复");
        resultUrl = remote.url;
        if (plan.length === 1) creditsUsed = remote.creditsUsed || creditsUsed;
      }
      if (!resultUrl) throw new Error("缺少已提交的分段结果，无法恢复完整成片");
      log(`正在取回第 ${part.index + 1}/${plan.length} 段成片...`);
      if (provider === "pixverse") {
        await downloadPixverseResult({ url: resultUrl, outputPath, onLog: log });
      } else {
        await downloadFileToDisk({ url: resultUrl, outputPath, onProgress: log,
          urlPolicy: providerUrlPolicy(provider === "veed" ? "fal" : "heygen") });
      }
      await verifyVideoDuration(outputPath, part.durationSeconds);
    }
    rendered.push(outputPath);
    const completedChunk: SavedChunk = { ...saved, index: part.index, resultUrl, outputName, status: "downloaded" };
    const currentChunks = [...(TaskStore.get(taskId)?.results.lipsyncChunks || chunks)];
    const existing = currentChunks.findIndex(chunk => chunk.index === part.index);
    if (existing >= 0) currentChunks[existing] = completedChunk;
    else currentChunks.push(completedChunk);
    TaskStore.update(taskId, { results: { lipsyncChunks: currentChunks } });
  }
  if (!rawReady && plan.length > 1) await concatVideos(rendered, rawPath, faceWorkflow ? plan.map(part => part.durationSeconds) : undefined);
  await verifyVideoDuration(rawPath, providerDuration);
  const jobId = chunks.map(chunk => chunk.lipsyncId).filter(Boolean).join(",");

  log("正在校准口型并合成最终成片...");
  const finalProbe = await finalizeFaceLipsync({ jobDir, renderedPath: rawPath, audioPath,
    outputPath: finalPath, faceWorkflow, onLog: log });
  await verifyVideoDuration(finalPath, audioProbe.durationSeconds);
  const sha256Video = await sha256File(finalPath);
  const sha256Audio = await sha256File(audioPath);

  let finalVideoUrl = finalPath;
  let exactAudioUrl = audioPath;
  let evidenceJsonUrl = path.join(jobDir, "production-report.json");

  const evidencePayload = {
    task_id: taskId,
    created_at: new Date().toISOString(),
    recovered: true,
    script_text: task.inputs.scriptText,
    processing: { status: "completed", recovered: true, lipsync_calibration: "best_effort" },
    media: {
      video: {
        final_duration_seconds: finalProbe.durationSeconds,
        resolution: `${finalProbe.width}x${finalProbe.height}`,
        fps: finalProbe.fps,
        sha256: sha256Video,
      },
      audio: {
        sample_rate: finalProbe.sampleRate,
        sha256: sha256Audio,
      },
    },
  };
  const evidencePath = path.join(jobDir, "production-report.json");
  fs.writeFileSync(evidencePath, JSON.stringify(evidencePayload, null, 2), "utf-8");

  if (CosService.isConfigured()) {
    finalVideoUrl = await CosService.uploadFile(finalPath, `jobs/${taskId}/final.mp4`);
    exactAudioUrl = await CosService.uploadFile(audioPath, `jobs/${taskId}/voice-track.wav`);
    evidenceJsonUrl = await CosService.uploadFile(evidencePath, `jobs/${taskId}/production-report.json`);
  }

  const previewVideoUrl = await createVideoPreview(finalPath);
  return markCompleted(
    taskId,
    {
      previewVideoUrl,
      originalVideoUrl: task.inputs.videoUrl || task.results.originalVideoUrl,
      finalVideoUrl,
      exactAudioUrl,
      evidenceJsonUrl,
      heygenLipsyncId: jobId || task.results.heygenLipsyncId,
      lipsyncProvider: provider,
      lipsyncCredits: creditsUsed,
      pixverseResultUrl: task.results.pixverseResultUrl,
      veedResultUrl: task.results.veedResultUrl,
      heygenResultUrl: task.results.heygenResultUrl,
      videoDuration: finalProbe.durationSeconds,
      audioDuration: (await probeMedia(audioPath)).durationSeconds,
      resolution: `${finalProbe.width}x${finalProbe.height}`,
      fps: finalProbe.fps,
      sha256Video,
      sha256Audio,
    },
    "已恢复成片并完成权威结算，任务完成。",
    sessionToken,
  );
}
