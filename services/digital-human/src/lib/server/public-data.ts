import "server-only";

import { createHash } from "crypto";
import type { LipsyncProvider } from "@/lib/lipsync-provider";
import type { AvatarItem } from "@/lib/store/avatar-store";
import type { TaskItem, TaskStep } from "@/lib/store/task-store";
import type { VoiceItem } from "@/lib/store/voice-store";
import type {
  PublicAvatarItem,
  PublicEngine,
  PublicTaskItem,
  PublicTaskStep,
  PublicVoiceItem,
} from "@/lib/public-contract";
import { sanitizePublicText } from "@/lib/server/public-sanitizer";
import { isTaskOutputExpired, taskCompletedAt, taskOutputExpiresAt } from "@/lib/task-output-retention";

export { sanitizePublicText } from "@/lib/server/public-sanitizer";

const PUBLIC_ERRORS: Record<string, string> = {
  BILLING_RESERVATION_TOO_SMALL: "实际配音超出预留额度，请缩短文案后重试",
  BILLING_SETTLEMENT_FAILED: "结果已生成，积分结算暂未完成，请稍后恢复任务",
  MEDIA_FIT_MISMATCH: "素材视频长于配音，请选择智能适配后重试",
};

const PUBLIC_LOG_FALLBACK = {
  info: "任务状态已更新",
  warn: "处理遇到问题，正在尝试恢复",
  error: "处理失败，请稍后重试",
  success: "处理步骤已完成",
};

export function isTaskOutputDeliverable(task: TaskItem): boolean {
  if (task.status !== "completed" || isTaskOutputExpired(task)) return false;
  return !task.billing?.isExternalUser || task.billing.status === "settled";
}

export function resolvePrivateEngine(engine: unknown): LipsyncProvider {
  if (engine === "a") return "pixverse";
  if (engine === "c") return "heygen";
  return "veed";
}

function toPublicEngine(provider?: LipsyncProvider): PublicEngine {
  if (provider === "pixverse") return "a";
  if (provider === "heygen") return "c";
  return "b";
}

function toPublicStep(step?: TaskStep): PublicTaskStep {
  if (step === "tts") return "voice";
  if (step === "media_prep") return "prepare";
  if (step === "mcp_preflight") return "check";
  if (step === "mcp_lipsync_submit" || step === "mcp_lipsync_polling") return "render";
  if (step === "finalize") return "finalize";
  if (step === "done") return "done";
  if (step === "error") return "error";
  return "idle";
}

export function toPublicTask(task: TaskItem): PublicTaskItem {
  const resultBase = `/api/tasks/${encodeURIComponent(task.id)}/media`;
  const provider = task.inputs.lipsyncProvider || task.results.lipsyncProvider;
  const deliverable = isTaskOutputDeliverable(task);
  const recoverable = Boolean(
    !deliverable &&
      !isTaskOutputExpired(task) &&
      task.billing?.status !== "released" &&
      (task.results.finalVideoUrl ||
        task.results.heygenLipsyncId ||
        task.results.pixverseResultUrl ||
        task.results.veedResultUrl ||
        task.results.lipsyncChunks?.length)
  );

  return {
    id: task.id,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: taskCompletedAt(task),
    expiresAt: taskOutputExpiresAt(task),
    outputExpired: isTaskOutputExpired(task),
    status: task.status,
    step: toPublicStep(task.step),
    failedStep: task.failedStep ? toPublicStep(task.failedStep) : undefined,
    progress: task.progress,
    logs: (task.logs || []).map((entry) => ({
      timestamp: entry.timestamp,
      level: entry.level,
      message: sanitizePublicText(entry.publicMessage, PUBLIC_LOG_FALLBACK[entry.level]),
    })),
    billing: task.billing
      ? {
          isExternalUser: task.billing.isExternalUser,
          estimatedDuration: task.billing.estimatedDuration,
          estimatedPoints: task.billing.estimatedPoints,
          actualDuration: task.billing.actualDuration,
          chargedPoints: task.billing.chargedPoints,
          costCny: task.billing.costCny,
          status: task.billing.status,
        }
      : undefined,
    inputs: {
      outputType: task.inputs.outputType || "video",
      avatarId: task.inputs.avatarId,
      videoName: sanitizePublicText(task.inputs.videoName, "口播素材.mp4"),
      scriptText: task.inputs.scriptText,
      toneProfile: task.inputs.toneProfile,
      videoFit: task.inputs.videoFit,
      emotionIntensity: task.inputs.emotionIntensity,
      speakerVoiceId: task.inputs.speakerVoiceId,
      engine: toPublicEngine(provider),
    },
    results: {
      downloadUrl: deliverable
        ? task.results.finalVideoUrl
          ? `/api/tasks/${encodeURIComponent(task.id)}/download/final.mp4`
          : task.results.exactAudioUrl
            ? `/api/tasks/${encodeURIComponent(task.id)}/download/voice-track.${task.results.audioFormat === "mp3" ? "mp3" : "wav"}`
            : undefined
        : undefined,
      originalVideoUrl:
        task.inputs.videoPath || task.inputs.videoUrl || task.results.originalVideoUrl
          ? `${resultBase}/original`
          : undefined,
      finalVideoUrl: deliverable && task.results.finalVideoUrl ? `${resultBase}/final` : undefined,
      exactAudioUrl: deliverable && task.results.exactAudioUrl ? `${resultBase}/voice` : undefined,
      audioFormat: task.results.audioFormat,
      evidenceJsonUrl: deliverable && task.results.evidenceJsonUrl
        ? `/api/tasks/${encodeURIComponent(task.id)}/download/production-report.json`
        : undefined,
      chargedPoints: task.results.chargedPoints,
      costCny: task.results.costCny,
      billingDuration: task.results.billingDuration,
      videoDuration: task.results.videoDuration,
      audioDuration: task.results.audioDuration,
      resolution: task.results.resolution,
      fps: task.results.fps,
      sha256Video: task.results.sha256Video,
      sha256Audio: task.results.sha256Audio,
    },
    recoverable,
    error: task.error
      ? Object.hasOwn(PUBLIC_ERRORS, task.errorCode || "")
        ? PUBLIC_ERRORS[task.errorCode!]
        : "处理失败，请稍后重试"
      : undefined,
  };
}

export function toPublicVoice(voice: VoiceItem, canManage?: boolean): PublicVoiceItem {
  return {
    id: voice.id,
    name: sanitizePublicText(voice.name, "自定义音色"),
    description: voice.description
      ? sanitizePublicText(voice.description, "专属音色")
      : undefined,
    audioUrl: voice.audioUrl || voice.audioPath ? `/api/voices/${encodeURIComponent(voice.id)}/audio` : "",
    createdAt: voice.createdAt,
    isDefault: voice.isDefault,
    canManage,
  };
}

export function avatarCoverVersion(avatar: AvatarItem): string {
  return createHash("sha256")
    .update(JSON.stringify([avatar.id, avatar.userId, avatar.coverUrl]))
    .digest("hex").slice(0, 24);
}

export function toPublicAvatar(avatar: AvatarItem, canManage?: boolean): PublicAvatarItem {
  const base = `/api/avatars/${encodeURIComponent(avatar.id)}/media`;
  return {
    id: avatar.id,
    name: sanitizePublicText(avatar.name, "口播形象"),
    videoUrl: `${base}?kind=video`,
    coverUrl: avatar.coverUrl ? `${base}?kind=cover&v=${avatarCoverVersion(avatar)}` : undefined,
    durationSeconds: avatar.durationSeconds,
    width: avatar.width,
    height: avatar.height,
    fps: avatar.fps,
    fileSize: avatar.fileSize,
    createdAt: avatar.createdAt,
    storedRemotely: avatar.isCos,
    canManage,
  };
}
