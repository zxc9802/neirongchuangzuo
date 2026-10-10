import { createVideoPreview } from "./video-preview";
import fs from "fs";
import path from "path";
import { getAppConfig } from "../config";
import { CosService } from "../cos";
import { releaseMainAppCredits } from "../main-app-billing";
import { resolveAllowedLocalMediaPath } from "../media-path-policy";
import { downloadTrustedMediaToFile } from "../server/media-response";
import { withTaskBillingGuard } from "../server/task-worker";
import { TaskStore } from "../store/task-store";
import { isTaskOutputExpired } from "../task-output-retention";
import { execMediaCommand, probeMedia, sha256File } from "./ffmpeg";

// This is an explicitly labelled, free narration video, never an AI lip-sync result.
// Only call after narration exists; authentication and paid-submission guards stay
// in the caller. A failed settlement must not be converted into a free delivery.
export async function deliverNarrationFallback(taskId: string, sessionToken?: string) {
  const task = TaskStore.get(taskId);
  if (!task || TaskStore.isDeleted(taskId) || isTaskOutputExpired(task) ||
    task.inputs.outputType === "audio" || task.status === "completed" ||
    task.billing?.isExternalUser && !["reserved", "provider_committed", "released"].includes(task.billing.status)) return null;
  const log = (message: string, level: "warn" | "success") => TaskStore.addLog(taskId, message, level, message);
  const jobDir = path.join(getAppConfig().storageDir, taskId);
  fs.mkdirSync(jobDir, { recursive: true });
  const audioPath = path.join(jobDir, "voice-track.wav");
  const restore = async (file: string, name: string) => {
    if (fs.existsSync(file)) return;
    const key = `jobs/${taskId}/${name}`;
    try {
      if (CosService.isConfigured() && await CosService.objectExists(key)) {
        await downloadTrustedMediaToFile({ source: await CosService.getDownloadUrl(key), outputPath: file });
      }
    } catch { /* Try the local original when cloud restoration is unavailable. */ }
  };
  await restore(audioPath, "voice-track.wav");
  if (!fs.existsSync(audioPath)) return null;
  const audio = await probeMedia(audioPath);
  if (!audio.hasAudio || !Number.isFinite(audio.durationSeconds) || audio.durationSeconds <= 0) return null;

  const sourcePath = path.join(jobDir, "source-video.mp4");
  await restore(sourcePath, "source-video.mp4");
  let videoPath = sourcePath;
  try {
    if (!(await probeMedia(videoPath)).width) throw new Error("No video");
  } catch {
    videoPath = resolveAllowedLocalMediaPath(task.inputs.videoPath) || path.join(jobDir, "input-video.mp4");
    if (!fs.existsSync(videoPath) && task.inputs.videoUrl) {
      videoPath = path.join(jobDir, "input-video.mp4");
      await downloadTrustedMediaToFile({ source: task.inputs.videoUrl, outputPath: videoPath });
    }
  }
  if (TaskStore.isDeleted(taskId)) return null;
  log("口型处理未完成，正在用原画面和本次配音导出基础配音视频", "warn");
  const candidate = path.join(jobDir, "narration-fallback.mp4");
  try {
    // Loop/trim pictures only. Keep the entire exact narration at its original speed.
    await execMediaCommand("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
      "-stream_loop", "-1", "-i", videoPath, "-i", audioPath,
      "-map", "0:v:0", "-map", "1:a:0", "-t", String(audio.durationSeconds),
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,fps=30,format=yuv420p",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", candidate]);
    const probe = await probeMedia(candidate);
    if (!probe.width || !probe.hasAudio) throw new Error("基础配音视频未能导出");
    if (TaskStore.isDeleted(taskId)) return null;
    const finalPath = path.join(jobDir, "final.mp4");
    fs.renameSync(candidate, finalPath);
    const sha256Video = await sha256File(finalPath);
    const sha256Audio = await sha256File(audioPath);
    const evidencePath = path.join(jobDir, "production-report.json");
    fs.writeFileSync(evidencePath, JSON.stringify({ task_id: taskId,
      created_at: new Date().toISOString(), script_text: task.inputs.scriptText,
      processing: { status: "completed", delivery_mode: "narration_fallback", lipsync_completed: false },
      media: { video: { duration_seconds: probe.durationSeconds, sha256: sha256Video },
        audio: { duration_seconds: audio.durationSeconds, sha256: sha256Audio } },
    }, null, 2));

    // Do not charge the lip-sync price for a video whose mouth was not adjusted.
    await withTaskBillingGuard(taskId, async () => {
      const current = TaskStore.get(taskId);
      if (!current || TaskStore.isDeleted(taskId)) throw new Error("任务已删除");
      if (!current.billing?.isExternalUser) return;
      if (!["reserved", "provider_committed", "released"].includes(current.billing.status)) throw new Error("任务结算状态已变化");
      if (current.billing.status !== "released") {
        if (!current.userId || !current.billing.requestId) throw new Error("任务缺少积分预留标识");
        await releaseMainAppCredits({ userId: current.userId, requestId: current.billing.requestId,
          source: current.billing.source, sessionToken });
        TaskStore.update(taskId, { billing: { ...current.billing, status: "released", chargedPoints: 0, costCny: 0 } });
      }
    });

    let finalVideoUrl = finalPath, exactAudioUrl = audioPath, evidenceJsonUrl = evidencePath;
    if (CosService.isConfigured()) {
      try {
        finalVideoUrl = await CosService.uploadFile(finalPath, `jobs/${taskId}/final.mp4`);
        exactAudioUrl = await CosService.uploadFile(audioPath, `jobs/${taskId}/voice-track.wav`);
        evidenceJsonUrl = await CosService.uploadFile(evidencePath, `jobs/${taskId}/production-report.json`);
      } catch {
        log("云端存储暂不可用，已保留本地视频", "warn");
      }
    }
    if (TaskStore.isDeleted(taskId)) return null;
    const previewVideoUrl = await createVideoPreview(finalPath);
    if (TaskStore.isDeleted(taskId)) return null;
    const updated = TaskStore.update(taskId, { status: "completed", step: "done", progress: 100,
      error: undefined, errorCode: undefined, failedStep: undefined,
      results: { deliveryMode: "narration_fallback", finalVideoUrl, previewVideoUrl, exactAudioUrl, evidenceJsonUrl,
        chargedPoints: 0, costCny: 0, videoDuration: probe.durationSeconds, audioDuration: audio.durationSeconds,
        resolution: `${probe.width}x${probe.height}`, fps: probe.fps, sha256Video, sha256Audio },
    });
    log("基础配音视频已生成：保留原画面，已配上本次声音，未调整口型，本次免扣积分", "success");
    return updated;
  } finally {
    fs.rmSync(candidate, { force: true });
  }
}
