import fs from "fs";
import path from "path";
import { CosService } from "../cos";
import { resolveLipsyncProvider } from "../lipsync-provider";
import { TaskItem, TaskStore } from "../store/task-store";
import { concatVideos, finalizeVideo, probeMedia, sha256File } from "./ffmpeg";
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
    task.results?.finalVideoUrl &&
    (!task.billing?.isExternalUser || task.billing.status === "settled")
  ) return false;
  return Boolean(
    task.results?.finalVideoUrl ||
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
  const duration = results.videoDuration;
  if (!Number.isFinite(duration) || !duration || duration <= 0) {
    throw new Error("成片时长无效，不能结算交付");
  }
  const chargedPoints =
    results.chargedPoints ??
    (task.billing?.isExternalUser
      ? calculateRequiredPoints(duration)
      : undefined);
  const costCny =
    results.costCny ??
    (task.billing?.isExternalUser ? calculateCostCny(duration) : undefined);

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
    });
    pointsBalanceAfter = settlement.pointsBalance;
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
      TaskStore.update(taskId, { status: "failed", step: "error", failedStep: "finalize",
        error: "成片恢复未完成，请稍后重试" });
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
    task.results?.finalVideoUrl &&
    (!task.billing?.isExternalUser || task.billing.status === "settled")
  ) {
    return task;
  }

  if (task.billing?.isExternalUser && task.billing.status === "released") {
    throw new Error("该任务的积分预留已释放，不能直接恢复交付");
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
  const plan = provider === "heygen"
    ? [{ index: 0, durationSeconds: audioProbe.durationSeconds }]
    : planLipsyncChunks(audioProbe.durationSeconds);
  const chunks = savedChunks(task);
  // Even a cloud final must be probed; container metadata or a missing report
  // must never stand in for the duration of the actual picture and narration.
  let rawReady = false;
  if (fs.existsSync(rawPath)) {
    try { await verifyVideoDuration(rawPath, audioProbe.durationSeconds); rawReady = true; } catch {}
  }
  if (!rawReady && CosService.isConfigured() && await CosService.objectExists(`jobs/${taskId}/final.mp4`)) {
    const url = await CosService.getDownloadUrl(`jobs/${taskId}/final.mp4`, "final.mp4");
    await downloadTrustedMediaToFile({ source: url, outputPath: rawPath });
    try { await verifyVideoDuration(rawPath, audioProbe.durationSeconds); rawReady = true; } catch {}
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
    if (!ready && CosService.isConfigured() && await CosService.objectExists(`jobs/${taskId}/${outputName}`)) {
      const url = await CosService.getDownloadUrl(`jobs/${taskId}/${outputName}`, path.basename(outputPath));
      await downloadTrustedMediaToFile({ source: url, outputPath });
      await verifyVideoDuration(outputPath, part.durationSeconds);
      ready = true;
    }
    let resultUrl = saved?.resultUrl;
    if (!ready) {
      if (saved?.lipsyncId && provider === "veed") {
        const remote = await FalVeedLipsyncAdapter.fetchResult(saved.lipsyncId);
        if (remote.status !== "COMPLETED" || !remote.url) throw new Error("分段结果尚未完成，请稍后恢复");
        resultUrl = remote.url;
      } else if (saved?.lipsyncId && provider === "pixverse") {
        const remote = await OpenLuxLipsyncAdapter.fetchResult(saved.lipsyncId);
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
  if (!rawReady && plan.length > 1) await concatVideos(rendered, rawPath);
  await verifyVideoDuration(rawPath, audioProbe.durationSeconds);
  const jobId = chunks.map(chunk => chunk.lipsyncId).filter(Boolean).join(",");

  log("正在将成片与原声音轨混流封装...");
  const finalProbe = await finalizeVideo(rawPath, audioPath, finalPath);
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
    processing: { status: "completed", recovered: true },
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

  return markCompleted(
    taskId,
    {
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
