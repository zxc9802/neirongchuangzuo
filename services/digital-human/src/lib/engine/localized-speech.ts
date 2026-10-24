import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { IndexTTSOptions, IndexTTSResult } from "./indextts";
import { applyToneProfile, execMediaCommand } from "./ffmpeg";
import { splitSpeechText, stitchSpeechSegments } from "./speech-stitch";
import { downloadFileToDisk } from "./download-file";
import { providerUrlPolicy } from "../server/outbound-url-policy";

const MODELS = { en: "fal-ai/zonos2", ms: "qwen-audio-3.0-tts-plus" };
const CONVERSION = "fal-ai/chatterbox/speech-to-speech";

function qwenBaseUrl(options: IndexTTSOptions): string {
  const url = new URL(options.qwenTtsBaseUrl || "https://dashscope.aliyuncs.com");
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
    url.pathname !== "/" || url.search || url.hash ||
    (!["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com"].includes(url.hostname) &&
      !/^[a-z0-9-]+\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(url.hostname))) {
    throw new Error("QWEN_TTS_BASE_URL 必须是百炼北京或新加坡的 API Host（不含路径）");
  }
  return url.origin;
}

function qwenAudioUrl(result: any): string {
  const url = new URL(result.output?.audio?.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port ||
    !/^dashscope-result-[a-z0-9-]+\.oss-[a-z0-9-]+\.aliyuncs\.com$/.test(url.hostname)) {
    throw new Error("Qwen 配音返回的音频地址无效");
  }
  // DashScope returns HTTP OSS URLs; use HTTPS before fetching any audio.
  url.protocol = "https:";
  return url.href;
}

async function runQwen(text: string, base: string, receipt: string, options: IndexTTSOptions): Promise<any> {
  const payload = { model: MODELS.ms, input: { text, voice: options.qwenMalayVoiceId,
    format: "wav", sample_rate: 24000, rate: 1, language_hints: ["ms"] } };
  const hash = crypto.createHash("sha256").update(JSON.stringify([base, payload])).digest("hex");
  const write = (state: any) => {
    fs.writeFileSync(`${receipt}.tmp`, JSON.stringify(state), "utf8");
    fs.renameSync(`${receipt}.tmp`, receipt);
  };
  let state = fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt, "utf8")) : undefined;
  if (state && (state.model !== MODELS.ms || state.inputHash !== hash)) throw new Error("原配音任务参数已变化，请新建任务");
  if (!state) {
    options.checkActive?.();
    state = { model: MODELS.ms, endpoint: base, inputHash: hash, submitting: true };
    write(state);
    const response = await fetch(`${base}/api/v1/services/audio/tts/SpeechSynthesizer`, {
      method: "POST", redirect: "error",
      headers: { Authorization: `Bearer ${options.qwenTtsApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      state.rejectedStatus = response.status; write(state);
      throw new Error(`Qwen 配音提交失败 (${response.status})，未重复提交`);
    }
    const result = await response.json();
    state = { ...state, id: result.request_id, result, usage: result.usage }; write(state);
  }
  if (state.rejectedStatus) throw new Error(`Qwen 原配音请求被拒绝 (${state.rejectedStatus})，未重复提交`);
  if (!state.result) throw new Error("Qwen 配音提交尚未确认，未重复提交，请核对原任务");
  if (state.result.code || state.result.output?.finish_reason !== "stop") throw new Error("Qwen 原配音请求未成功完成，未重复提交");
  return state.result;
}

function identity(value: string): string {
  try {
    const url = new URL(value);
    if (/\.cos\.[a-z0-9-]+\.myqcloud\.com$/i.test(url.hostname)) {
      for (const key of [...url.searchParams.keys()]) {
        if (/^q-/.test(key) || key === "response-content-disposition") url.searchParams.delete(key);
      }
      url.searchParams.sort();
      return url.href;
    }
  } catch {}
  return value;
}

function audioUrl(result: any): string {
  const url = new URL(typeof result.audio === "string" ? result.audio : result.audio?.url);
  if (url.protocol !== "https:" || url.username || url.password ||
    !["fal.media", "storage.googleapis.com"].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw new Error("fal 配音返回的音频地址无效");
  }
  return url.href;
}

async function runJob(model: string, payload: Record<string, unknown>, receipt: string,
  options: IndexTTSOptions): Promise<any> {
  const write = (state: any) => {
    fs.writeFileSync(`${receipt}.tmp`, JSON.stringify(state), "utf8");
    fs.renameSync(`${receipt}.tmp`, receipt);
  };
  const hash = crypto.createHash("sha256").update(JSON.stringify(payload, (key, value) =>
    typeof value === "string" && key.endsWith("url") ? identity(value) : value)).digest("hex");
  let state = fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt, "utf8")) : undefined;
  if (state && (state.model !== model || state.inputHash !== hash)) throw new Error("原配音任务参数已变化，请新建任务");
  if (!state) {
    options.checkActive?.();
    state = { model, inputHash: hash, submitting: true };
    write(state); // Persist before the paid POST; an uncertain submission must not be repeated.
    const response = await fetch(`https://queue.fal.run/${model}`, {
      method: "POST", redirect: "error",
      headers: { Authorization: `Key ${options.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      state.rejectedStatus = response.status; write(state);
      throw new Error(`fal 配音提交失败 (${response.status})，未重复提交`);
    }
    const job = await response.json();
    state = { ...state, id: job.request_id, statusUrl: job.status_url, resultUrl: job.response_url };
    write(state);
  }
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(state.id || "")) throw new Error("配音提交尚未确认，未重复提交，请核对原任务");
  const namespace = model.split("/").slice(0, 2).join("/");
  const resultUrl = `https://queue.fal.run/${namespace}/requests/${state.id}`;
  if (state.resultUrl !== resultUrl || state.statusUrl !== `${resultUrl}/status`) throw new Error("fal 配音返回的任务地址无效");
  if (state.result) return state.result;
  const read = async (url: string) => {
    let response;
    try {
      response = await fetch(url, { redirect: "error", headers: { Authorization: `Key ${options.apiKey}` },
        signal: AbortSignal.timeout(60_000) });
    } catch { return null; }
    if (response.status >= 500 || [408, 429].includes(response.status)) {
      await response.body?.cancel().catch(() => {}); return null;
    }
    if (!response.ok) throw new Error(`fal 配音查询失败 (${response.status})，未重复提交`);
    try { return { data: await response.json(), units: response.headers.get("x-fal-billable-units") }; }
    catch { return null; }
  };
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    options.checkActive?.();
    const status = await read(state.statusUrl);
    if (status?.data.error || ["FAILED", "ERROR", "CANCELLED"].includes(status?.data.status)) {
      throw new Error("fal 原配音任务失败，未重复提交");
    }
    if (status?.data.status === "COMPLETED") {
      const result = await read(state.resultUrl);
      if (result) {
        audioUrl(result.data);
        state.result = result.data; state.billableUnits = result.units; write(state);
        return result.data;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 2500));
  }
  throw new Error("配音等待超时，请恢复原任务，未重复提交");
}

export async function generateLocalizedSpeech(text: string, language: "en" | "ms",
  options: IndexTTSOptions): Promise<IndexTTSResult> {
  if (!options.apiKey || !options.speakerAudioUrl || !text.trim()) throw new Error("配音密钥、本人音色或文案未配置");
  const englishReference = language === "en" ? options.englishReferenceAudioUrl ||
    (options.englishReferenceAudioPath
      ? `data:audio/wav;base64,${fs.readFileSync(options.englishReferenceAudioPath).toString("base64")}` : "") : "";
  if (language === "en" && !englishReference) throw new Error("请配置 ZONOS2_REFERENCE_AUDIO_URL 或 ZONOS2_REFERENCE_AUDIO_PATH 英语发音参考");
  if (language === "ms" && !options.qwenTtsApiKey) throw new Error("请配置 QWEN_TTS_API_KEY 或现有 DASHSCOPE_API_KEY");
  if (language === "ms" && !options.qwenMalayVoiceId) throw new Error("请配置同地域的 QWEN_MALAY_VOICE_ID 马来语基础音色");
  const qwenBase = language === "ms" ? qwenBaseUrl(options) : "";
  const toneProfile = options.toneProfile || "low";
  const rate = { half: 0.5, slow: 0.8, low: 1, high: 1.2, fast: 1.5 }[toneProfile];
  const cacheKey = crypto.createHash("sha256").update(JSON.stringify([
    "fal-localized-speech-v1", MODELS[language], CONVERSION, options.cacheScope || "local", text.trim(),
    identity(options.speakerAudioUrl), language === "en" ? identity(englishReference) : [qwenBase, options.qwenMalayVoiceId], rate,
  ])).digest("hex");
  fs.mkdirSync(options.outDir, { recursive: true });
  const manifest = path.join(options.outDir, "localized-speech", "input.json");
  if (fs.existsSync(manifest)) {
    if (JSON.parse(fs.readFileSync(manifest, "utf8")).cacheKey !== cacheKey) throw new Error("原配音任务参数已变化，请新建任务");
  } else {
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(manifest, JSON.stringify({ cacheKey, language }));
  }
  const cache = path.join(process.cwd(), ".runtime", "tts-cache", cacheKey);
  const rawWavPath = path.join(options.outDir, "voice-raw.wav");
  const finalWavPath = path.join(options.outDir, "voice-track.wav");
  if (fs.existsSync(path.join(cache, "meta.json"))) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(cache, "meta.json"), "utf8"));
      fs.copyFileSync(path.join(cache, "voice-raw.wav"), rawWavPath);
      fs.copyFileSync(path.join(cache, "voice-track.wav"), finalWavPath);
      return { ...meta, rawWavPath, finalWavPath, toneProfile, fromCache: true };
    } catch { /* Recover the original jobs if cached files are incomplete. */ }
  }
  // Pack sentences into natural passages; do not pay for conversion once per sentence.
  const chunks: string[] = [];
  for (const sentence of splitSpeechText(text, language)) {
    const last = chunks.length - 1;
    if (last >= 0 && Array.from(chunks[last] + " " + sentence).length <= 600) chunks[last] += " " + sentence;
    else chunks.push(sentence);
  }
  const parts: { text: string; audioPath: string }[] = [];
  for (let index = 0; index < chunks.length; index++) {
    options.checkActive?.();
    const chunkDir = path.join(options.outDir, "localized-speech", cacheKey, String(index + 1));
    fs.mkdirSync(chunkDir, { recursive: true });
    options.onLog?.(`${language === "en" ? "Zonos2" : "Qwen-Audio-3.0-TTS-Plus"} 配音 ${index + 1}/${chunks.length}`);
    let sourceAudio: string;
    if (language === "en") {
      const source = await runJob(MODELS.en, {
        text: chunks[index], reference_audio_url: englishReference,
        language: "en_gb", accurate_mode: false, seed: 20261022,
      }, path.join(chunkDir, "source.json"), options);
      sourceAudio = audioUrl(source);
    } else {
      const source = await runQwen(chunks[index], qwenBase, path.join(chunkDir, "source.json"), options);
      const sourcePath = path.join(chunkDir, "source.wav");
      if (!fs.existsSync(sourcePath)) {
        const url = qwenAudioUrl(source);
        const pending = path.join(chunkDir, "source.downloading.wav");
        await downloadFileToDisk({ url, outputPath: pending, maxBytes: 100 * 1024 * 1024,
          urlPolicy: { name: "qwen-tts", allowedHosts: [new URL(url).hostname] } });
        fs.renameSync(pending, sourcePath);
      }
      sourceAudio = `data:audio/wav;base64,${fs.readFileSync(sourcePath).toString("base64")}`;
    }
    options.onLog?.("正在转换为所选本人音色...");
    const converted = await runJob(CONVERSION, {
      source_audio_url: sourceAudio, target_voice_audio_url: options.speakerAudioUrl,
    }, path.join(chunkDir, "conversion.json"), options);
    const providerPath = path.join(chunkDir, "converted.audio");
    const audioPath = path.join(chunkDir, "converted.wav");
    const policy = providerUrlPolicy("fal");
    await downloadFileToDisk({ url: audioUrl(converted), outputPath: providerPath,
      maxBytes: 100 * 1024 * 1024,
      urlPolicy: { ...policy, allowedHosts: [...policy.allowedHosts, "storage.googleapis.com"] } });
    await execMediaCommand("ffmpeg", ["-v", "error", "-y", "-protocol_whitelist", "file,pipe",
      "-i", providerPath, "-vn", "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", audioPath]);
    fs.rmSync(providerPath, { force: true });
    parts.push({ text: chunks[index], audioPath });
  }
  options.checkActive?.();
  if (parts.length === 1) fs.copyFileSync(parts[0].audioPath, rawWavPath);
  else await stitchSpeechSegments(parts, rawWavPath);
  // Apply the selected speed once, after conversion and before lip sync.
  const durations = await applyToneProfile(rawWavPath, finalWavPath, rate);
  const result = { ...durations, rawWavPath, finalWavPath, rate, toneProfile, fromCache: false };
  try {
    fs.mkdirSync(cache, { recursive: true });
    fs.copyFileSync(rawWavPath, path.join(cache, "voice-raw.wav"));
    fs.copyFileSync(finalWavPath, path.join(cache, "voice-track.wav"));
    fs.writeFileSync(path.join(cache, "meta.json"), JSON.stringify({ ...durations, rate }));
  } catch {
    options.onLog?.("音频已完成，缓存暂未写入，本次音频和任务回执已保留。");
  }
  return result;
}
