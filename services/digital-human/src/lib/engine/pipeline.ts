import { logServerError } from "../server/safe-log";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { withTaskExecution } from "./task-execution";
import { TaskStore, TaskItem, TaskStep } from "../store/task-store";
import { getAppConfig } from "../config";
import { generateIndexTTS } from "./indextts";
import {
  probeMedia,
  prepareSourceVideo,
  finalizeVideo,
  sha256File,
  encodeMp3,
  type MediaProbeInfo,
} from "./ffmpeg";
import { HeyGenMcpAdapter } from "../mcp/heygen-adapter";
import { OpenLuxLipsyncAdapter } from "./openlux-lipsync";
import { FalVeedLipsyncAdapter } from "./fal-veed-lipsync";
import { CosService } from "../cos";
import { resolveLipsyncProvider } from "../lipsync-provider";
import { resolveAllowedLocalMediaPath } from "../media-path-policy";
import {
  downloadTrustedMediaToFile,
  getTrustedExternalMediaUrl,
} from "../server/media-response";
import {
  calculateRequiredPoints,
  assertTaskCreditCoverage,
  calculateCostCny,
  settleMainAppCredits,
  releaseMainAppCredits,
  POINTS_PER_SECOND,
} from "../main-app-billing";

export async function runDigitalHumanPipeline(
  taskId: string,
  sessionToken?: string,
): Promise<void> {
  return withTaskExecution(taskId, () => runPipeline(taskId, sessionToken));
}

async function runPipeline(taskId: string, sessionToken?: string): Promise<void> {
  const task = TaskStore.get(taskId);
  if (!task) return;

  const config = getAppConfig();
  const audioOnly = task.inputs.outputType === "audio";
  const providerRoot = path.join(process.cwd(), ".runtime", "provider-input");
  const jobDir = path.join(config.storageDir, taskId);
  const providerToken = crypto.randomBytes(24).toString("hex");
  const providerInputDir = path.join(providerRoot, providerToken);
  const providerCosKeys: string[] = [];
  const baseUrl = config.publicBaseUrl.replace(/\/$/, "");

  const externalizeReference = async (
    source: string,
    fileName: string,
    allowConfiguredReference = false
  ): Promise<string> => {
    try {
      return await getTrustedExternalMediaUrl(source, allowConfiguredReference);
    } catch {
      const localPath = resolveAllowedLocalMediaPath(source);
      if (!localPath || !fs.existsSync(localPath) || !fs.statSync(localPath).isFile()) {
        throw new Error("媒体引用不在允许范围内");
      }
      const targetPath = path.join(providerInputDir, fileName);
      fs.copyFileSync(localPath, targetPath);
      return `${baseUrl}/jobs/input/${providerToken}/${fileName}`;
    }
  };

  const log = (msg: string, level: "info" | "warn" | "error" | "success" = "info", publicMessage = msg) => {
    TaskStore.addLog(taskId, msg, level, publicMessage);
  };
  const logProvider = (msg: string) => log(msg, "info", "处理服务运行中，请稍候");
  const ensureTaskActive = () => {
    if (TaskStore.isDeleted(taskId)) throw new Error("任务已删除");
  };
  const markProviderCommitted = () => {
    const current = TaskStore.get(taskId);
    if (current?.billing?.isExternalUser && current.billing.status === "reserved") {
      TaskStore.update(taskId, {
        billing: { ...current.billing, status: "provider_committed" },
      });
    }
  };
  const recordChunk = (chunk: NonNullable<TaskItem["results"]["lipsyncChunks"]>[number]) => {
    const chunks = [...(TaskStore.get(taskId)?.results.lipsyncChunks || [])];
    const index = chunks.findIndex(item => item.index === chunk.index);
    if (index >= 0) chunks[index] = { ...chunks[index], ...chunk };
    else chunks.push(chunk);
    chunks.sort((a, b) => a.index - b.index);
    TaskStore.update(taskId, { results: { lipsyncChunks: chunks } });
  };

  let currentStep: TaskStep = "tts";

  try {
    fs.mkdirSync(providerRoot, { recursive: true });
    for (const entry of fs.readdirSync(providerRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{48}$/.test(entry.name)) continue;
      const candidate = path.join(providerRoot, entry.name);
      try {
        if (Date.now() - fs.statSync(candidate).mtimeMs > 6 * 60 * 60 * 1000) {
          fs.rmSync(candidate, { recursive: true, force: true });
        }
      } catch {}
    }
    if (CosService.isConfigured()) {
      await CosService.cleanupExpiredObjects("provider-input/", 24 * 60 * 60 * 1000).catch(() => 0);
    }
    fs.mkdirSync(jobDir, { recursive: true });
    fs.mkdirSync(providerInputDir, { recursive: true });
    ensureTaskActive();
    currentStep = "tts";
    TaskStore.update(taskId, {
      status: "processing",
      step: "tts",
      progress: 10,
    });
    log(audioOnly ? "🗣️ 开始生成 MP3 配音..." : "🚀 启动数字人对口型流水线...");

    if (task.billing?.isExternalUser) {
      log(
        `💳 外部用户计费：费率 ${POINTS_PER_SECOND}积分/秒 (0.20元/秒)，已预留 ${task.billing.estimatedPoints} 积分 (预估 ${task.billing.estimatedDuration}s)`,
        "info"
      );
    } else {
      log("🎟️ 内部/管理员账号，免除积分消耗", "info");
    }

    // 0. Ensure source video exists locally (auto-download from videoUrl / COS if missing from local disk)
    let localVideoPath = task.inputs.videoPath;
    let originalProbe: MediaProbeInfo;
    if (!audioOnly) {
      if (localVideoPath) {
        localVideoPath = resolveAllowedLocalMediaPath(localVideoPath) || "";
      }
      const needDownload = !localVideoPath || !fs.existsSync(localVideoPath);

      if (needDownload) {
        const sourceUrl = task.inputs.videoUrl;
        if (!sourceUrl) {
          throw new Error(`未找到可用视频文件，本地路径不存在且无云端直链: ${localVideoPath || "空"}`);
        }
        log(`⬇️ 正在从云端存储同步视频素材至当前实例...`);
        localVideoPath = path.join(jobDir, "input-video.mp4");
        const bytes = await downloadTrustedMediaToFile({
          source: sourceUrl,
          outputPath: localVideoPath,
        });
        log(`✅ 视频素材已成功同步至本地 (${(bytes / 1024 / 1024).toFixed(2)} MB)`, "success");
      }

      // 1. Probe source video
      log("📹 正在探测原始口播视频参数...");
      originalProbe = await probeMedia(localVideoPath);
      ensureTaskActive();
      if (!originalProbe.width || !originalProbe.height) {
        throw new Error("素材没有有效的视频画面");
      }
      log(
        `原始视频信息: 分辨率 ${originalProbe.width}x${originalProbe.height} | 时长 ${originalProbe.durationSeconds.toFixed(
          2
        )}s | 帧率 ${originalProbe.fps}fps | 含音频轨: ${originalProbe.hasAudio ? "是" : "否"}`
      );
    }
    assertTaskCreditCoverage(task.billing, task.billing?.estimatedDuration || 0);

    // 2. Step: Speech Synthesis
    log("🗣️ 第一步: 正在合成定制原声配音 (根据字数可能需要 1~3 分钟)...");
    const storedSpeakerSource =
      task.inputs.speakerAudioUrl ||
      config.indexttsSpeakerAudioUrl;
    const storedEmotionSource =
      task.inputs.emotionAudioUrl ||
      config.indexttsEmotionAudioUrl;
    const speakerExt = path.extname(new URL(storedSpeakerSource, "file:///").pathname).toLowerCase();
    const speakerUrl = await externalizeReference(
      storedSpeakerSource,
      `speaker-reference${[".mp3", ".wav", ".m4a"].includes(speakerExt) ? speakerExt : ".mp3"}`,
      storedSpeakerSource === config.indexttsSpeakerAudioUrl
    );
    const emotionAudioUrl = storedEmotionSource
      ? await externalizeReference(
          storedEmotionSource,
          "emotion-reference.wav",
          storedEmotionSource === config.indexttsEmotionAudioUrl
        )
      : "";

    const ttsResult = await generateIndexTTS(task.inputs.scriptText, {
      apiKey: config.indexttsApiKey,
      baseUrl: config.indexttsBaseUrl,
      speakerAudioUrl: speakerUrl,
      emotionAudioUrl: emotionAudioUrl,
      emotionIntensity: task.inputs.emotionIntensity,
      toneProfile: task.inputs.toneProfile,
      outDir: jobDir,
      onLog: (m) => logProvider(`[TTS] ${m}`),
      cacheScope: `${task.userId || "local"}:${task.inputs.speakerVoiceId || "default"}`,
    });
    ensureTaskActive();

    const sha256Audio = await sha256File(ttsResult.finalWavPath);
    log(
      `专属原声音轨已就绪，时长 ${ttsResult.selectedDuration.toFixed(1)}s，音频指纹: ${sha256Audio.slice(0, 16)}...`,
      "success"
    );

    if (audioOnly) {
      currentStep = "finalize";
      TaskStore.update(taskId, { step: "finalize", progress: 85 });
      log("🎧 正在导出 MP3 配音...");
      const mp3Path = path.join(jobDir, "voice-track.mp3");
      await encodeMp3(ttsResult.finalWavPath, mp3Path);
      const audioProbe = await probeMedia(mp3Path);
      const mp3Hash = await sha256File(mp3Path);
      ensureTaskActive();

      const currentTaskData = TaskStore.get(taskId) || task;
      const actualDuration = audioProbe.durationSeconds;
      assertTaskCreditCoverage(currentTaskData.billing, actualDuration);
      let chargedPoints: number | undefined;
      let costCny: number | undefined;
      let pointsBalanceAfter: number | undefined;
      if (currentTaskData.billing?.isExternalUser) {
        if (!currentTaskData.billing.requestId || !currentTaskData.userId) {
          throw new Error("外部用户任务缺少主站积分结算标识");
        }
        chargedPoints = calculateRequiredPoints(actualDuration);
        costCny = calculateCostCny(actualDuration);
        TaskStore.update(taskId, { billing: { ...currentTaskData.billing, status: "settle_pending" } });
        const settlement = await settleMainAppCredits({
          userId: currentTaskData.userId, requestId: currentTaskData.billing.requestId,
          actualDuration, chargedPoints, sessionToken,
        });
        pointsBalanceAfter = settlement.pointsBalance;
      }

      let exactAudioUrl = mp3Path;
      if (CosService.isConfigured()) {
        try {
          ensureTaskActive();
          exactAudioUrl = await CosService.uploadFile(mp3Path, `jobs/${taskId}/voice-track.mp3`);
        } catch (cosErr) {
          logServerError("pipeline.audio_upload_failed", cosErr, "warn");
          log("云端存储暂不可用，已保留本地结果", "warn");
        }
      }
      ensureTaskActive();
      currentStep = "done";
      TaskStore.update(taskId, {
        status: "completed", step: "done", progress: 100,
        billing: currentTaskData.billing ? {
          ...currentTaskData.billing, actualDuration, chargedPoints, costCny, pointsBalanceAfter,
          status: currentTaskData.billing.isExternalUser ? "settled" : "not_applicable",
        } : undefined,
        results: {
          exactAudioUrl, audioFormat: "mp3", audioDuration: actualDuration, sha256Audio: mp3Hash,
          chargedPoints, costCny, billingDuration: actualDuration,
        },
      });
      log("🎉 MP3 配音已生成，可以试听和下载。", "success");
      return;
    }

    // 3. Step: Media Preparation & Normalization
    currentStep = "media_prep";
    TaskStore.update(taskId, {
      step: "media_prep",
      progress: 35,
    });
    log("🎞️ 第二步: 正在进行 FFmpeg 画面归一化与音画对齐...");

    const preparedVideoPath = path.join(jobDir, "source-video.mp4");
    const prepResult = await prepareSourceVideo(
      localVideoPath,
      ttsResult.selectedDuration,
      preparedVideoPath,
      task.inputs.videoFit
    );
    ensureTaskActive();

    const sha256Video = await sha256File(preparedVideoPath);
    log(
      `画面适配完成: 分辨率 ${prepResult.width}x${prepResult.height}, 时长 ${prepResult.duration.toFixed(
        2
      )}s, 视频指纹: ${sha256Video.slice(0, 16)}...`,
      "success"
    );

    // Check the confirmed hold before any lip-sync engine can spend credits.
    // One second covers frame/container rounding in the final mux.
    ensureTaskActive();
    assertTaskCreditCoverage(
      TaskStore.get(taskId)?.billing || task.billing,
      Math.ceil(Math.max(ttsResult.selectedDuration, prepResult.duration)) + 1,
    );

    // 4. Step: Lip-sync submission (HeyGen / PixVerse / VEED)
    const lipsyncProvider = resolveLipsyncProvider(
      task.inputs.lipsyncProvider || config.lipsyncProvider,
      "heygen"
    );

    currentStep = "mcp_preflight";
    TaskStore.update(taskId, {
      step: "mcp_preflight",
      progress: 50,
    });

    // Submission title based on hashes for idempotency
    const submissionTitle = `lipsync_${sha256Video.slice(0, 8)}_${sha256Audio.slice(
      0,
      8
    )}`;

    // Create short-lived, unguessable provider inputs. They are removed in finally.
    fs.copyFileSync(preparedVideoPath, path.join(providerInputDir, "source-video.mp4"));
    fs.copyFileSync(ttsResult.finalWavPath, path.join(providerInputDir, "voice-track.wav"));
    let publicVideoUrl = `${baseUrl}/jobs/input/${providerToken}/source-video.mp4`;
    let publicAudioUrl = `${baseUrl}/jobs/input/${providerToken}/voice-track.wav`;

    // If cloud object storage is configured, upload prepared video & audio to COS for 100% reachable public access
    if (CosService.isConfigured()) {
      try {
        ensureTaskActive();
        log("☁️ 正在将预处理音画直链同步至云端高速分发...", "info");
        const providerVideoKey = `provider-input/${providerToken}/source-video.mp4`;
        const providerAudioKey = `provider-input/${providerToken}/voice-track.wav`;
        await CosService.uploadFile(preparedVideoPath, providerVideoKey);
        providerCosKeys.push(providerVideoKey);
        await CosService.uploadFile(ttsResult.finalWavPath, providerAudioKey);
        providerCosKeys.push(providerAudioKey);
        publicVideoUrl = await CosService.getDownloadUrl(providerVideoKey, undefined, 6 * 60 * 60);
        publicAudioUrl = await CosService.getDownloadUrl(providerAudioKey, undefined, 6 * 60 * 60);
        ensureTaskActive();
        log("✅ 预处理音视频直链已就绪 (云端存储)", "success");
      } catch (cosErr: any) {
        logServerError("pipeline.input_sync_failed", cosErr, "warn");
      }
    }

    let heygenResult: {
      lipsyncId: string;
      status: "completed" | "failed";
      downloadUrl?: string;
      creditsUsed?: number;
    };

    if (lipsyncProvider === "pixverse") {
      log("🛡️ 第三步: 校验 PixVerse 对口型素材...");
      if (!fs.existsSync(preparedVideoPath) || !fs.existsSync(ttsResult.finalWavPath)) {
        throw new Error("预处理视频或原声音轨不存在，无法提交 PixVerse 对口型");
      }
      log("素材校验通过，准备上传至 OpenLux / PixVerse", "success");

      currentStep = "mcp_lipsync_submit";
      TaskStore.update(taskId, {
        step: "mcp_lipsync_submit",
        progress: 65,
      });
      log("🔌 第四步: 正在调度 PixVerse (pixverse-lipsync) 对口型...");

      heygenResult = await OpenLuxLipsyncAdapter.execute(
        {
          videoPath: preparedVideoPath,
          audioPath: ttsResult.finalWavPath,
          videoUrl: publicVideoUrl,
          audioUrl: publicAudioUrl,
          existingChunks: TaskStore.get(taskId)?.results.lipsyncChunks,
          onLog: logProvider,
          onProviderAccepted: markProviderCommitted,
          onJobCreated: ({ lipsyncId, creditsUsed }) => {
            markProviderCommitted();
            TaskStore.update(taskId, {
              results: {
                heygenLipsyncId: lipsyncId,
                lipsyncProvider: "pixverse",
                lipsyncCredits: creditsUsed,
              },
            });
          },
          onResultReady: ({ lipsyncId, downloadUrl, creditsUsed }) => {
            TaskStore.update(taskId, {
              results: {
                heygenLipsyncId: lipsyncId,
                lipsyncProvider: "pixverse",
                lipsyncCredits: creditsUsed,
                heygenResultUrl: downloadUrl,
              },
            });
          },
          onChunkProgress: recordChunk,
        },
        jobDir
      );
    } else if (lipsyncProvider === "veed") {
      log("🛡️ 第三步: 校验 VEED 对口型素材...");
      if (!fs.existsSync(preparedVideoPath) || !fs.existsSync(ttsResult.finalWavPath)) {
        throw new Error("预处理视频或原声音轨不存在，无法提交 VEED 对口型");
      }
      log("素材校验通过，准备提交至 fal.ai / VEED Lipsync", "success");

      currentStep = "mcp_lipsync_submit";
      TaskStore.update(taskId, {
        step: "mcp_lipsync_submit",
        progress: 65,
      });
      log("🔌 第四步: 正在调度 VEED Lipsync (fal.ai) 对口型...");

      heygenResult = await FalVeedLipsyncAdapter.execute(
        {
          videoPath: preparedVideoPath,
          audioPath: ttsResult.finalWavPath,
          videoUrl: publicVideoUrl,
          audioUrl: publicAudioUrl,
          objectKeyPrefix: `jobs/${taskId}`,
          onLog: logProvider,
          onChunkProgress: recordChunk,
          onProviderAccepted: markProviderCommitted,
          onJobCreated: ({ lipsyncId }) => {
            markProviderCommitted();
            TaskStore.update(taskId, {
              results: {
                heygenLipsyncId: lipsyncId,
                lipsyncProvider: "veed",
              },
            });
          },
          onResultReady: ({ lipsyncId, downloadUrl }) => {
            TaskStore.update(taskId, {
              results: {
                heygenLipsyncId: lipsyncId,
                lipsyncProvider: "veed",
                veedResultUrl: downloadUrl,
              },
            });
          },
        },
        jobDir
      );
    } else {
      log("🛡️ 第三步: 零计费门禁校验媒体直链...");

      currentStep = "mcp_lipsync_submit";
      TaskStore.update(taskId, {
        step: "mcp_lipsync_submit",
        progress: 65,
      });
      log("🔌 第四步: 正在调度 AI 高精度唇形驱动引擎...");

      heygenResult = await HeyGenMcpAdapter.executeLipsync(
        {
          videoUrl: publicVideoUrl,
          audioUrl: publicAudioUrl,
          submissionTitle,
          onLog: logProvider,
          onProviderAccepted: markProviderCommitted,
          onJobCreated: ({ lipsyncId }) => {
            markProviderCommitted();
            TaskStore.update(taskId, {
              results: {
                heygenLipsyncId: lipsyncId,
                lipsyncProvider: "heygen",
              },
            });
          },
          onResultReady: ({ lipsyncId, downloadUrl }) => {
            TaskStore.update(taskId, {
              results: {
                heygenLipsyncId: lipsyncId,
                lipsyncProvider: "heygen",
                pixverseResultUrl: downloadUrl,
              },
            });
          },
        },
        jobDir
      );
      markProviderCommitted();
    }

    // 5. Step: Finalize and Remux with exact audio
    currentStep = "finalize";
    TaskStore.update(taskId, {
      step: "finalize",
      progress: 85,
    });
    log("🎧 第五步: 正在将生成的对口型视频与原声 WAV 音轨无损混流封装...");

    const heygenDownloadedPath = path.join(jobDir, "rendered-source.mp4");
    const finalVideoPath = path.join(jobDir, "final.mp4");

    const finalProbe = await finalizeVideo(
      heygenDownloadedPath,
      ttsResult.finalWavPath,
      finalVideoPath
    );
    ensureTaskActive();

    // 6. Generate an implementation-neutral production report
    const evidencePayload = {
      task_id: taskId,
      created_at: new Date().toISOString(),
      script_text: task.inputs.scriptText,
      inputs: {
        tone_profile: task.inputs.toneProfile,
        video_fit: task.inputs.videoFit,
        emotion_intensity: task.inputs.emotionIntensity,
      },
      media: {
        video: {
          original_duration_seconds: originalProbe!.durationSeconds,
          final_duration_seconds: finalProbe.durationSeconds,
          resolution: `${finalProbe.width}x${finalProbe.height}`,
          fps: finalProbe.fps,
          sha256: sha256Video,
        },
        audio: {
          raw_duration_seconds: ttsResult.rawDuration,
          final_duration_seconds: ttsResult.selectedDuration,
          sample_rate: finalProbe.sampleRate,
          sha256: sha256Audio,
        },
      },
      processing: { status: "completed" },
    };

    const evidencePath = path.join(jobDir, "production-report.json");
    fs.writeFileSync(
      evidencePath,
      JSON.stringify(evidencePayload, null, 2),
      "utf-8"
    );

    // Upload final video, audio, evidence to cloud object storage if configured
    let finalVideoUrl = finalVideoPath;
    let exactAudioUrl = ttsResult.finalWavPath;
    let evidenceJsonUrl = evidencePath;

    // 7. Settle main-site billing credits for external users (200 points/sec = 0.20 CNY/sec)
    let chargedPoints: number | undefined;
    let costCny: number | undefined;
    let pointsBalanceAfter: number | undefined;

    const currentTaskData = TaskStore.get(taskId) || task;
    if (currentTaskData.billing?.isExternalUser) {
      if (!currentTaskData.billing.requestId || !currentTaskData.userId) {
        throw new Error("外部用户任务缺少主站积分结算标识");
      }
      const actualDuration = finalProbe.durationSeconds;
      chargedPoints = calculateRequiredPoints(actualDuration);
      costCny = calculateCostCny(actualDuration);
      log(
        `💳 正在结算主站积分消耗: 实际时长 ${actualDuration.toFixed(1)}s × ${POINTS_PER_SECOND}积分/秒 = ${chargedPoints} 积分 (¥${costCny})...`,
        "info"
      );
      TaskStore.update(taskId, {
        billing: { ...currentTaskData.billing, status: "settle_pending" },
      });
      const settleResult = await settleMainAppCredits({
        userId: currentTaskData.userId,
        requestId: currentTaskData.billing.requestId,
        actualDuration,
        chargedPoints,
        sessionToken,
      });
      pointsBalanceAfter = settleResult.pointsBalance;
      log(
        `✅ 主站积分结算成功：扣除 ${chargedPoints} 积分 (¥${costCny})，当前账户剩余: ${
          pointsBalanceAfter !== undefined ? `${pointsBalanceAfter} 积分` : "正常"
        }`,
        "success"
      );
    }

    // Persist deliverables only after the authoritative ledger acknowledges settlement.
    if (CosService.isConfigured()) {
      try {
        ensureTaskActive();
        log("☁️ 正在将合成的数字人成片上传至云端永久存储...", "info");
        const cosVideoKey = `jobs/${taskId}/final.mp4`;
        finalVideoUrl = await CosService.uploadFile(finalVideoPath, cosVideoKey);
        log(`✅ 成片已成功存储至云端存储: ${finalVideoUrl}`, "success");

        const cosAudioKey = `jobs/${taskId}/voice-track.wav`;
        exactAudioUrl = await CosService.uploadFile(ttsResult.finalWavPath, cosAudioKey);

        const cosEvidenceKey = `jobs/${taskId}/production-report.json`;
        evidenceJsonUrl = await CosService.uploadFile(evidencePath, cosEvidenceKey);
        ensureTaskActive();
      } catch (cosErr: any) {
        log(`⚠️ 云端存储上传警告: ${cosErr.message}，降级使用本地直链`, "warn", "云端存储暂不可用，已保留本地结果");
      }
    }

    // Done!
    currentStep = "done";
    ensureTaskActive();
    TaskStore.update(taskId, {
      status: "completed",
      step: "done",
      progress: 100,
      billing: currentTaskData.billing
        ? {
            ...currentTaskData.billing,
            actualDuration: finalProbe.durationSeconds,
            chargedPoints,
            costCny,
            pointsBalanceAfter,
            status: currentTaskData.billing.isExternalUser
              ? "settled"
              : "not_applicable",
          }
        : undefined,
      results: {
        originalVideoUrl:
          task.inputs.videoUrl ||
          task.inputs.videoPath,
        finalVideoUrl,
        exactAudioUrl,
        evidenceJsonUrl,
        heygenLipsyncId: heygenResult.lipsyncId,
        lipsyncProvider,
        lipsyncCredits: heygenResult.creditsUsed,
        chargedPoints,
        costCny,
        billingDuration: finalProbe.durationSeconds,
        videoDuration: finalProbe.durationSeconds,
        audioDuration: ttsResult.selectedDuration,
        resolution: `${finalProbe.width}x${finalProbe.height}`,
        fps: finalProbe.fps,
        sha256Video,
        sha256Audio,
      },
    });

    log("🎉 全部流程执行成功！数字人对口型成片已就绪。", "success");
  } catch (err: any) {
    const errorMsg = err.message || "未知流水线异常";
    logServerError("pipeline.failed", err);
    log(`❌ 流程发生错误: ${errorMsg}`, "error", "处理失败，请稍后重试");

    // Release reserved billing credits on failure
    const currentTaskData = TaskStore.get(taskId) || task;
    if (
      currentTaskData.billing?.isExternalUser &&
      currentTaskData.billing.requestId &&
      currentTaskData.billing.status === "reserved"
    ) {
      try {
        await releaseMainAppCredits({
          userId: currentTaskData.userId || "",
          requestId: currentTaskData.billing.requestId,
          sessionToken,
        });
        TaskStore.update(taskId, {
          billing: {
            ...currentTaskData.billing,
            status: "released",
          },
        });
        log("↩️ 流水线异常中断，预留积分已全额解冻返还", "info");
      } catch (releaseErr: any) {
        logServerError("billing.release_failed", releaseErr, "warn");
      }
    }

    TaskStore.update(taskId, {
      status: "failed",
      step: "error",
      failedStep: currentStep,
      error: errorMsg,
      errorCode: typeof err.code === "string" ? err.code : undefined,
    });
  } finally {
    try {
      fs.rmSync(providerInputDir, { recursive: true, force: true });
    } catch {}
    await Promise.all(
      providerCosKeys.map((key) => CosService.deleteObject(key).catch(() => undefined))
    );
    if (TaskStore.isDeleted(taskId)) {
      try {
        fs.rmSync(jobDir, { recursive: true, force: true });
      } catch {}
      if (CosService.isConfigured()) {
        const files = await CosService.listFiles(`jobs/${taskId}/`).catch(() => []);
        await Promise.all(
          files.map((file) => CosService.deleteObject(file.key).catch(() => undefined))
        );
      }
    }
  }
}
