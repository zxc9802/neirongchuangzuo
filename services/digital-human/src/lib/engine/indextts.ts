import { logServerError } from "../server/safe-log";
import fs from "fs";
import { downloadFileToDisk } from "./download-file";
import { providerUrlPolicy } from "../server/outbound-url-policy";
import path from "path";
import crypto from "crypto";
import { applyToneProfile, execMediaCommand } from "./ffmpeg";
import { splitSpeechText, stitchSpeechSegments } from "./speech-stitch";

const TTS_CONCURRENCY = 3;
const FAL_ENDPOINT = "https://queue.fal.run/fal-ai/index-tts-2/text-to-speech";
const CHATTERBOX_ENDPOINT = "https://queue.fal.run/fal-ai/chatterbox/text-to-speech/multilingual";

function falQueueUrl(value: string, chatterbox = false): string {
  const url = new URL(value);
  if (url.origin !== "https://queue.fal.run" || url.username || url.password ||
    !(chatterbox ? /^\/fal-ai\/chatterbox(?:\/|$)/ : /^\/fal-ai\/index-tts-2(?:\/|$)/).test(url.pathname)) {
    throw new Error("fal 配音返回的任务地址无效");
  }
  return url.href;
}

// Only reads of an accepted job may be retried; never repeat a paid POST.
async function readFalJob(url: string, apiKey: string): Promise<any | null> {
  let response: Response;
  try {
    response = await fetch(url, { redirect: "error", headers: { Authorization: `Key ${apiKey}` },
      signal: AbortSignal.timeout(60_000) });
  } catch { return null; }
  if (response.status >= 500 || [408, 429].includes(response.status)) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.ok) throw new Error(`fal 配音任务查询失败 (${response.status})`);
  try { return await response.json(); } catch { return null; }
}
let activeRequests = 0;
const waitingRequests: (() => void)[] = [];

async function acquireRequestSlot(): Promise<() => void> {
  await new Promise<void>(resolve => {
    const enter = () => { activeRequests++; resolve(); };
    if (activeRequests < TTS_CONCURRENCY) enter();
    else waitingRequests.push(enter);
  });
  return () => { activeRequests--; waitingRequests.shift()?.(); };
}

function referenceCacheIdentity(value: string): string {
  try {
    const url = new URL(value);
    if (/\.cos\.[a-z0-9-]+\.myqcloud\.com$/i.test(url.hostname)) {
      for (const name of [...url.searchParams.keys()]) {
        if (/^q-(sign-|signature$|key-time$|ak$|header-list$|url-param-list$)/.test(name) || name === "response-content-disposition") {
          url.searchParams.delete(name);
        }
      }
      url.searchParams.sort();
      return url.toString();
    }
  } catch {}
  return value;
}

export interface IndexTTSOptions {
  apiKey: string;
  speakerAudioUrl: string;
  emotionAudioUrl?: string;
  emotionIntensity?: number;
  toneProfile?: "low" | "high";
  outDir: string;
  onLog?: (msg: string) => void;
  cacheScope?: string;
  fallback?: { apiKey: string; speakerId: string };
  checkActive?: () => void;
  onFallback?: () => void;
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
  const payload = `fal-sentence-stitch-v1|${cacheScope}|${text.trim()}|${referenceCacheIdentity(speakerUrl)}|${referenceCacheIdentity(emotionUrl)}|${intensity}|${toneProfile}`;
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export async function generateIndexTTS(
  text: string,
  options: IndexTTSOptions
): Promise<IndexTTSResult> {
  try {
    return await generatePrimarySpeech(text, options);
  } catch (primaryError) {
    if (!options.fallback?.apiKey || !options.fallback.speakerId) throw primaryError;
    options.checkActive?.();
    options.onFallback?.();
    options.onLog?.("主配音失败，使用豆包声音复刻 2.0 重新合成完整文案...");
    const { generateDoubaoTTS } = await import("./doubao-tts");
    try {
      const result = await generateDoubaoTTS(text, {
        ...options.fallback,
        toneProfile: options.toneProfile,
        outDir: path.join(options.outDir, "tts-doubao"),
        onLog: options.onLog,
        checkActive: options.checkActive,
      });
      options.checkActive?.();
      const rawWavPath = path.join(options.outDir, "voice-raw.wav");
      const finalWavPath = path.join(options.outDir, "voice-track.wav");
      fs.copyFileSync(result.rawWavPath, rawWavPath);
      fs.copyFileSync(result.finalWavPath, finalWavPath);
      return { ...result, rawWavPath, finalWavPath };
    } catch (fallbackError) {
      throw new Error(`主配音失败: ${primaryError instanceof Error ? primaryError.message : "未知错误"}；豆包备用配音失败: ${fallbackError instanceof Error ? fallbackError.message : "未知错误"}`);
    }
  }
}

export async function generateChatterboxTTS(
  text: string,
  language: "en" | "ms",
  options: IndexTTSOptions,
): Promise<IndexTTSResult> {
  // English/Malay must never fall back to the Chinese-only voice route.
  return generatePrimarySpeech(text, options, language);
}

async function generatePrimarySpeech(
  text: string,
  options: IndexTTSOptions,
  language?: "en" | "ms",
): Promise<IndexTTSResult> {
  const {
    apiKey,
    speakerAudioUrl,
    emotionAudioUrl,
    emotionIntensity = 0.8,
    toneProfile = "low",
    outDir,
    onLog = () => {},
    cacheScope = "local",
  } = options;
  const modelName = language ? "Chatterbox" : "IndexTTS-2";

  if (!apiKey) {
    throw new Error(`fal ${modelName} 配音密钥未配置（FAL_KEY / FAL_API_KEY / VIDEO_FAL_KEY）`);
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
  const primaryCacheKey = getCacheKey(
    text,
    speakerAudioUrl,
    emotionAudioUrl,
    emotionIntensity,
    toneProfile,
    cacheScope
  );
  const cacheKey = language ? crypto.createHash("sha256").update(`chatterbox-v1|${language}|${primaryCacheKey}`).digest("hex") : primaryCacheKey;

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

  // 2. Cache Miss: Synthesize short sentences and join them before applying the final speech rate.
  const segments = splitSpeechText(text, language);
  let audioUrl: string | null = null;
  if (segments.length > 1) {
    onLog(`文案已分为 ${segments.length} 段，最多 ${TTS_CONCURRENCY} 段同时合成，完成后按原顺序拼接...`);
    const parts: { text: string; audioPath: string }[] = new Array(segments.length);
    let next = 0;
    let failure: unknown;
    await Promise.all(Array.from({ length: Math.min(TTS_CONCURRENCY, segments.length) }, async () => {
      while (next < segments.length && !failure) {
        const index = next++;
        try {
          onLog(`正在合成第 ${index + 1}/${segments.length} 段...`);
          const part = await generatePrimarySpeech(segments[index], {
            ...options,
            toneProfile: "low",
            outDir: path.join(outDir, "tts-segments", String(index + 1)),
            onLog: message => {
              if (failure) throw failure;
              onLog(`[第 ${index + 1}/${segments.length} 段] ${message}`);
            },
          }, language);
          parts[index] = { text: segments[index], audioPath: part.rawWavPath };
        } catch (error) {
          failure ||= error;
        }
      }
    }));
    if (failure) throw failure;
    onLog("各段合成完成，正在整理首尾静音并拼接音轨...");
    await stitchSpeechSegments(parts, rawWavPath);
  } else {
    const release = await acquireRequestSlot();
    try {
      options.checkActive?.();
      onLog(`正在向 fal.ai 提交 ${modelName} 语音合成请求...`);

      const payload: Record<string, any> = language ? {
        text: text.trim(), voice: speakerAudioUrl,
        custom_audio_language: language === "ms" ? "malay" : "english",
        cfg_scale: 0, exaggeration: 0.5, temperature: 0.7,
      } : {
        prompt: text.trim(),
        audio_url: speakerAudioUrl,
        strength: Math.min(Math.max(emotionIntensity, 0), 0.85),
        should_use_prompt_for_emotion: false,
      };

      if (!language && emotionAudioUrl && emotionAudioUrl.startsWith("http")) {
        payload.emotional_audio_url = emotionAudioUrl;
      } else if (!language) {
        payload.emotional_strengths = { calm: 1.0 };
      }

      onLog(`[TTS] 👤 发音人音色克隆: ${speakerAudioUrl}`);
      if (!language) onLog(`[TTS] 🎭 语气与情绪参考音频: ${payload.emotional_audio_url || "基准"} (情绪强度: ${payload.strength})`);

      const createResp = await fetch(language ? CHATTERBOX_ENDPOINT : FAL_ENDPOINT, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Key ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60_000),
      });

      if (!createResp.ok) {
        const errText = await createResp.text();
        throw new Error(`fal ${modelName} 任务创建失败 (${createResp.status}): ${errText}`);
      }

      const createJson = await createResp.json();
      const taskId = createJson.request_id;
      if (!taskId || !createJson.status_url || !createJson.response_url) {
        throw new Error(`fal ${modelName} 未返回完整任务编号，未自动重新提交`);
      }
      const statusUrl = falQueueUrl(createJson.status_url, Boolean(language));
      const resultUrl = falQueueUrl(createJson.response_url, Boolean(language));

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

      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2500));
        options.checkActive?.();
        const pollJson = await readFalJob(statusUrl, apiKey);
        if (!pollJson) { onLog("配音查询暂时不可用，正在重试原任务，不会重复提交。"); continue; }
        if (pollJson.error || ["FAILED", "ERROR", "CANCELLED"].includes(pollJson.status)) {
          throw new Error(`fal ${modelName} 合成失败: ${JSON.stringify(pollJson)}`);
        }
        if (pollJson.status === "COMPLETED") {
          const result = await readFalJob(resultUrl, apiKey);
          if (!result) { onLog("配音结果暂时无法读取，正在取回原任务结果。"); continue; }
          if (result.error) throw new Error(`fal ${modelName} 合成失败: ${JSON.stringify(result.error)}`);
          audioUrl = typeof result.audio === "string" ? result.audio : result.audio?.url;
          break;
        }
      }

      if (!audioUrl) {
        throw new Error(`${modelName} 超时或未获取到音频下载地址`);
      }

      onLog(`TTS 合成成功，正在下载音频文件...`);

      const providerAudioPath = path.join(outDir, "voice-provider.audio");
      const downloadPolicy = providerUrlPolicy("fal");
      try {
        await downloadFileToDisk({
          url: audioUrl,
          outputPath: providerAudioPath,
          maxBytes: 100 * 1024 * 1024,
          urlPolicy: { ...downloadPolicy, allowedHosts: [...downloadPolicy.allowedHosts, "storage.googleapis.com"] },
        });
        await execMediaCommand("ffmpeg", ["-v", "error", "-y", "-protocol_whitelist", "file,pipe",
          "-i", providerAudioPath, "-vn", "-c:a", "pcm_s16le", rawWavPath]);
      } finally {
        fs.rmSync(providerAudioPath, { force: true });
      }
    } finally {
      release();
    }
  }

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
        audioUrl: audioUrl || undefined,
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
    audioUrl: audioUrl || undefined,
    fromCache: false,
  };
}
