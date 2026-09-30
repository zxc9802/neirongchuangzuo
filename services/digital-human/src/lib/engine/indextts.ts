import { logServerError } from "../server/safe-log";
import fs from "fs";
import { downloadFileToDisk } from "./download-file";
import { providerUrlPolicy } from "../server/outbound-url-policy";
import path from "path";
import crypto from "crypto";
import { applyToneProfile } from "./ffmpeg";

export interface IndexTTSOptions {
  apiKey: string;
  baseUrl?: string;
  speakerAudioUrl: string;
  emotionAudioUrl?: string;
  emotionIntensity?: number;
  toneProfile?: "low" | "high";
  outDir: string;
  onLog?: (msg: string) => void;
  cacheScope?: string;
}

export interface IndexTTSResult {
  rawWavPath: string;
  finalWavPath: string;
  rawDuration: number;
  selectedDuration: number;
  toneProfile: "low" | "high";
  rate: number;
  audioUrl?: string;
  fromCache?: boolean;
}

function getCacheKey(
  text: string,
  speakerUrl: string,
  emotionUrl: string = "",
  intensity: number = 0.8,
  toneProfile: string = "low",
  cacheScope: string = "local"
): string {
  const payload = `${cacheScope}|${text.trim()}|${speakerUrl}|${emotionUrl}|${intensity}|${toneProfile}`;
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export async function generateIndexTTS(
  text: string,
  options: IndexTTSOptions
): Promise<IndexTTSResult> {
  const {
    apiKey,
    baseUrl = "https://api.302.ai",
    speakerAudioUrl,
    emotionAudioUrl,
    emotionIntensity = 0.8,
    toneProfile = "low",
    outDir,
    onLog = () => {},
    cacheScope = "local",
  } = options;

  if (!apiKey) {
    throw new Error("INDEXTTS_302_API_KEY is required");
  }
  if (!speakerAudioUrl) {
    throw new Error("INDEXTTS_SPEAKER_AUDIO_URL is required");
  }
  if (!text || !text.trim()) {
    throw new Error("Text must not be empty");
  }

  fs.mkdirSync(outDir, { recursive: true });

  const rawWavPath = path.join(outDir, "voice-raw.wav");
  const finalWavPath = path.join(outDir, "voice-track.wav");
  const cacheKey = getCacheKey(
    text,
    speakerAudioUrl,
    emotionAudioUrl,
    emotionIntensity,
    toneProfile,
    cacheScope
  );

  const globalCacheDir = path.join(process.cwd(), ".runtime", "tts-cache", cacheKey);

  // 1. Check Global TTS Cache
  if (
    fs.existsSync(globalCacheDir) &&
    fs.existsSync(path.join(globalCacheDir, "voice-track.wav")) &&
    fs.existsSync(path.join(globalCacheDir, "meta.json"))
  ) {
    try {
      const meta = JSON.parse(
        fs.readFileSync(path.join(globalCacheDir, "meta.json"), "utf-8")
      );
      fs.copyFileSync(path.join(globalCacheDir, "voice-raw.wav"), rawWavPath);
      fs.copyFileSync(
        path.join(globalCacheDir, "voice-track.wav"),
        finalWavPath
      );
      onLog(
        `⚡ 命中配音缓存：检测到文案与音色参数与历史记录完全一致，跳过云端合成，直接复用已生成音频 (时长 ${meta.selectedDuration.toFixed(
          2
        )}s)！`
      );
      return {
        rawWavPath,
        finalWavPath,
        rawDuration: meta.rawDuration,
        selectedDuration: meta.selectedDuration,
        toneProfile: meta.toneProfile,
        rate: meta.rate,
        audioUrl: meta.audioUrl,
        fromCache: true,
      };
    } catch {
      // ignore corrupt cache
    }
  }

  // 2. Cache Miss: Execute cloud synthesis
  onLog(`正在向 302.AI 提交 IndexTTS-2 语音合成请求...`);

  const payload: Record<string, any> = {
    text: text.trim(),
    speaker_audio_url: speakerAudioUrl,
    emotion_alpha: Math.min(Math.max(emotionIntensity, 0), 0.85),
  };

  if (emotionAudioUrl && emotionAudioUrl.startsWith("http")) {
    payload.emotion_audio_url = emotionAudioUrl;
  } else {
    payload.emotion_vector = [0, 0, 0, 0, 0, 0, 0, 1.0];
  }

  onLog(`[TTS] 👤 发音人音色克隆: ${speakerAudioUrl}`);
  onLog(`[TTS] 🎭 语气与情绪参考音频: ${payload.emotion_audio_url || "基准"} (情绪强度: ${payload.emotion_alpha})`);

  const endpoint = `${baseUrl.replace(/\/$/, "")}/302/index_tts2/task`;
  const createResp = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!createResp.ok) {
    const errText = await createResp.text();
    throw new Error(`IndexTTS-2 任务创建失败 (${createResp.status}): ${errText}`);
  }

  const createJson = await createResp.json();
  const taskId = createJson.task_id;
  if (!taskId) {
    throw new Error(`IndexTTS-2 未返回 task_id: ${JSON.stringify(createJson)}`);
  }

  // Poll for completion. Long scripts need more than the old 5-minute cap.
  const ttsTimeoutMs = Math.min(
    Math.max(12 * 60 * 1000, Math.ceil(text.trim().length * 1200)),
    45 * 60 * 1000
  );
  onLog(
    `TTS 任务已创建 (TaskID: ${taskId})，正在轮询合成进度（最长等待 ${Math.round(
      ttsTimeoutMs / 60000
    )} 分钟）...`
  );
  const deadline = Date.now() + ttsTimeoutMs;
  let audioUrl: string | null = null;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500));
    const pollResp = await fetch(`${endpoint}?task_id=${encodeURIComponent(taskId)}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!pollResp.ok) {
      continue;
    }

    const pollJson = await pollResp.json();
    if (pollJson.state === "SUCCESS") {
      audioUrl = pollJson.audio_url;
      break;
    } else if (pollJson.state === "FAILURE") {
      throw new Error(`IndexTTS-2 合成失败: ${JSON.stringify(pollJson)}`);
    }
  }

  if (!audioUrl) {
    throw new Error(`IndexTTS-2 超时或未获取到音频下载地址`);
  }

  onLog(`TTS 合成成功，正在下载音频文件...`);

  await downloadFileToDisk({
    url: audioUrl,
    outputPath: rawWavPath,
    maxBytes: 100 * 1024 * 1024,
    urlPolicy: providerUrlPolicy("indextts"),
  });

  onLog(`音频下载完成，正在应用音调/语速配置文件 (${toneProfile})...`);

  const rate = toneProfile === "high" ? 1.2 : 1.0;
  const toneResult = await applyToneProfile(rawWavPath, finalWavPath, rate);

  // Save to global cache
  try {
    fs.mkdirSync(globalCacheDir, { recursive: true });
    fs.copyFileSync(rawWavPath, path.join(globalCacheDir, "voice-raw.wav"));
    fs.copyFileSync(
      finalWavPath,
      path.join(globalCacheDir, "voice-track.wav")
    );
    fs.writeFileSync(
      path.join(globalCacheDir, "meta.json"),
      JSON.stringify({
        rawDuration: toneResult.rawDuration,
        selectedDuration: toneResult.selectedDuration,
        toneProfile,
        rate,
        audioUrl,
        createdAt: Date.now(),
      }),
      "utf-8"
    );
  } catch (e: any) {
    logServerError("speech.cache_write_failed", e, "warn");
  }

  onLog(
    `音频处理完成: 原始时长 ${toneResult.rawDuration.toFixed(
      2
    )}s -> 最终时长 ${toneResult.selectedDuration.toFixed(2)}s`
  );

  return {
    rawWavPath,
    finalWavPath,
    rawDuration: toneResult.rawDuration,
    selectedDuration: toneResult.selectedDuration,
    toneProfile,
    rate,
    audioUrl,
    fromCache: false,
  };
}
