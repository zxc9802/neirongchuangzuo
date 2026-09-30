import { logServerError } from "@/lib/server/safe-log";
import { NextRequest, NextResponse } from "next/server";
import { TaskStore } from "@/lib/store/task-store";
import { runDigitalHumanPipeline } from "@/lib/engine/pipeline";
import { AvatarStore } from "@/lib/store/avatar-store";
import { VoiceStore } from "@/lib/store/voice-store";
import { resolvePrivateEngine, toPublicTask } from "@/lib/server/public-data";
import type { MainAppUser } from "@/lib/main-app-sso";
import {
  isExternallyBilledUser,
  reserveMainAppCredits,
  MainAppBillingError,
  POINTS_PER_SECOND,
  CNY_PER_SECOND,
} from "@/lib/main-app-billing";
import { estimateReservationDuration } from "@/lib/billing-estimate";
import { acquireGenerationSlot, GenerationLimitError } from "@/lib/server/generation-limit";
import {
  resolveAccessContext,
  unauthorizedResponse,
  canViewAllMedia,
} from "@/lib/access-control";
import { isOwnedUploadSource } from "@/lib/server/upload-policy";
import { isTrustedStoredMediaSource } from "@/lib/server/media-response";

export async function GET(req: NextRequest) {
  const access = await resolveAccessContext(req);
  if (access.isolated && !access.userId) {
    return unauthorizedResponse();
  }

  const tasks = await TaskStore.getAllAsync();
  const visibleTasks = access.isolated && !access.isAdmin
    ? tasks.filter((task) => task.userId === access.userId)
    : tasks;
  const completedOnly = req.nextUrl.searchParams.get("completed") === "true";
  const publicTasks = visibleTasks.map(toPublicTask).filter(task => !task.outputExpired &&
    (!completedOnly || Boolean(task.status === "completed" && task.results.downloadUrl)));
  return NextResponse.json({ tasks: publicTasks }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(req: NextRequest) {
  let releaseSlot: (() => void) | undefined;
  try {
    const body = await req.json();
    const {
      avatarId,
      scriptText,
      toneProfile = "low",
      videoFit = "smart",
      emotionIntensity = 0.8,
      speakerVoiceId,
      engine,
    } = body;

    if ((avatarId != null && typeof avatarId !== "string") ||
      typeof scriptText !== "string" || !scriptText.trim()) {
      return NextResponse.json(
        { error: "请输入文本内容并检查口播形象参数" },
        { status: 400 }
      );
    }

    if (scriptText.length > 5000 || !["low", "high"].includes(toneProfile) ||
      !["smart", "preserve"].includes(videoFit) ||
      !Number.isFinite(emotionIntensity) || emotionIntensity < 0 || emotionIntensity > 1) {
      return NextResponse.json({ error: "文案最多 5000 字，请检查生成参数" }, { status: 400 });
    }

    // 1. Resolve SSO User Session（SSO 已配置时必须持有效会话，防止伪造 x-user-id 扣他人积分）
    const access = await resolveAccessContext(req);
    if (access.isolated && !access.session) {
      return unauthorizedResponse();
    }
    const session = access.session;
    const user: Partial<MainAppUser> = session?.user || {
      id: "local_user",
      account: "local@qycm.top",
      nickname: "本地用户",
      role: "admin",
      billingAudience: "internal",
    };

    const avatar = avatarId ? AvatarStore.get(avatarId) : undefined;
    if (
      avatarId && (!avatar ||
      (!canViewAllMedia(access) && avatar.userId !== access.userId))
    ) {
      return NextResponse.json({ error: "口播形象不存在" }, { status: 404 });
    }

    const selectedVoice = speakerVoiceId
      ? VoiceStore.get(String(speakerVoiceId))
      : VoiceStore.getDefault();
    if (
      !selectedVoice ||
      (!selectedVoice.isDefault &&
        !canViewAllMedia(access) &&
        selectedVoice.userId !== access.userId)
    ) {
      return NextResponse.json({ error: "音色不存在" }, { status: 404 });
    }

    const avatarSource = avatar?.videoPath || avatar?.videoUrl;
    if (avatar && !isOwnedUploadSource({ source: avatarSource, userId: avatar.userId, folder: "videos" })) {
      return NextResponse.json({ error: "口播形象素材无效，请重新上传" }, { status: 400 });
    }
    const voiceSource = selectedVoice.audioPath || selectedVoice.audioUrl;
    const voiceIsTrusted = selectedVoice.isDefault
      ? await isTrustedStoredMediaSource(voiceSource, true)
      : isOwnedUploadSource({ source: voiceSource, userId: selectedVoice.userId, folder: "voices" });
    if (!voiceIsTrusted) {
      return NextResponse.json({ error: "音色素材无效，请重新上传" }, { status: 400 });
    }

    // Bound paid attempts independently of whether the task later refunds or is deleted.
    if (isExternallyBilledUser(user) || user.billingAudience === "standalone") releaseSlot = acquireGenerationSlot(user.id!);
    const estimatedDuration = estimateReservationDuration(scriptText);
    const reservation = await reserveMainAppCredits({
      user,
      sessionToken: session?.token,
      estimatedDuration,
    });

    const task = TaskStore.create({
      userId: user.id,
      userAccount: user.account,
      status: "pending",
      step: "idle",
      progress: 0,
      billing: {
        isExternalUser: reservation.chargeRequired,
        ratePerSecond: POINTS_PER_SECOND,
        costCnyPerSecond: CNY_PER_SECOND,
        requestId: reservation.requestId,
        estimatedDuration,
        estimatedPoints: reservation.requiredPoints,
        reservedPoints: reservation.reservedPoints,
        costCny: reservation.costCny,
        pointsBalanceBefore: reservation.pointsBalance,
        status: reservation.chargeRequired ? "reserved" : "not_applicable",
      },
      inputs: {
        outputType: avatar ? "video" : "audio",
        avatarId: avatar?.id,
        videoName: avatar ? avatar.name || "口播素材.mp4" : "配音.mp3",
        videoPath: avatar?.videoPath || "",
        videoUrl: avatar?.videoUrl || "",
        scriptText,
        toneProfile,
        videoFit,
        emotionIntensity,
        speakerVoiceId: selectedVoice.id,
        speakerAudioUrl: voiceSource,
        lipsyncProvider: resolvePrivateEngine(engine),
      },
      results: {},
    });

    // Run pipeline asynchronously in background
    const releaseRunningSlot = releaseSlot;
    releaseSlot = undefined;
    void runDigitalHumanPipeline(task.id, session?.token).catch((err) => {
      logServerError("pipeline.crashed", err);
    }).finally(() => releaseRunningSlot?.());

    return NextResponse.json({ success: true, task: toPublicTask(task) });
  } catch (err: any) {
    if (err instanceof GenerationLimitError) {
      return NextResponse.json({ error: err.message, code: "GENERATION_LIMIT" }, {
        status: err.status, headers: { "Retry-After": "60" },
      });
    }
    if (err instanceof MainAppBillingError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status }
      );
    }
    return NextResponse.json(
      { error: "创建任务失败，请稍后重试" },
      { status: 500 }
    );
  } finally {
    releaseSlot?.();
  }
}
