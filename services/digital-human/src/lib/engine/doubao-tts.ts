import fs from "fs";
import path from "path";
import crypto from "crypto";
import { applyToneProfile } from "./ffmpeg";
import { splitSpeechText, stitchSpeechSegments } from "./speech-stitch";
import type { IndexTTSResult } from "./indextts";

type DoubaoTTSOptions = {
  apiKey: string;
  speakerId: string;
  toneProfile?: "half" | "slow" | "gentle" | "low" | "high" | "fast";
  outDir: string;
  onLog?: (message: string) => void;
  checkActive?: () => void;
};

export async function generateDoubaoTTS(
  text: string,
  options: DoubaoTTSOptions,
): Promise<IndexTTSResult> {
  options.checkActive?.();
  fs.mkdirSync(options.outDir, { recursive: true });
  const rawWavPath = path.join(options.outDir, "voice-raw.wav");
  const finalWavPath = path.join(options.outDir, "voice-track.wav");
  const texts = splitSpeechText(text);
  if (texts.length <= 1) {
    await synthesizeDoubaoSegment(text.trim(), rawWavPath, options);
  } else {
    // Long expressive requests can rush later sentences. Reset synthesis at natural
    // boundaries, keeping the same voice/model and applying speed only after joining.
    const segmentDir = fs.mkdtempSync(path.join(options.outDir, ".doubao-segments-"));
    try {
      const segments: { text: string; audioPath: string }[] = [];
      for (let index = 0; index < texts.length; index++) {
        const audioPath = path.join(segmentDir, `${index}.wav`);
        await synthesizeDoubaoSegment(texts[index], audioPath, options);
        segments.push({ text: texts[index], audioPath });
        options.onLog?.(`豆包配音已完成 ${index + 1}/${texts.length} 段`);
      }
      options.checkActive?.();
      await stitchSpeechSegments(segments, rawWavPath);
    } finally {
      fs.rmSync(segmentDir, { recursive: true, force: true });
    }
  }
  options.checkActive?.();
  const toneProfile = options.toneProfile || "low";
  const rate = { half: 0.5, slow: 0.8, gentle: 0.9, low: 1, high: 1.2, fast: 1.5 }[toneProfile];
  const durations = await applyToneProfile(rawWavPath, finalWavPath, rate);
  options.onLog?.(`豆包完整配音已就绪，语速 ${rate} 倍，时长 ${durations.selectedDuration.toFixed(1)}s`);
  return { rawWavPath, finalWavPath, ...durations, toneProfile, rate, fromCache: false };
}

async function synthesizeDoubaoSegment(
  text: string,
  rawWavPath: string,
  options: DoubaoTTSOptions,
): Promise<void> {
  options.checkActive?.();
  const response = await fetch("https://openspeech.bytedance.com/api/v3/tts/unidirectional", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(12 * 60 * 1000),
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": options.apiKey,
      "X-Api-Resource-Id": "seed-icl-2.0",
      "X-Api-Request-Id": crypto.randomUUID(),
    },
    body: JSON.stringify({
      req_params: {
        text: text.trim(),
        speaker: options.speakerId,
        model: "seed-tts-2.0-expressive",
        audio_params: { format: "pcm", sample_rate: 24000 },
      },
    }),
  });
  if (!response.ok || !response.body) {
    throw new Error(`豆包声音复刻请求失败 (${response.status})`);
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  let finished = false;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    if (message.code === 20000000) finished = true;
    else if (message.code !== 0) throw new Error(`豆包合成失败 (${message.code})`);
    if (message.data) {
      const audio = Buffer.from(message.data, "base64");
      bytes += audio.length;
      if (bytes > 100 * 1024 * 1024) throw new Error("豆包配音超过允许大小");
      chunks.push(audio);
    }
  };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      options.checkActive?.();
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      if (pending.length > 150 * 1024 * 1024) throw new Error("豆包响应超过允许大小");
      let end;
      while ((end = pending.indexOf("\n")) >= 0) {
        consume(pending.slice(0, end));
        pending = pending.slice(end + 1);
      }
    }
    consume(pending + decoder.decode());
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (!finished || bytes < 2 || bytes % 2 !== 0) {
    throw new Error("豆包配音未完整生成，不能交付不完整音轨");
  }
  options.checkActive?.();

  // Streaming PCM has no WAV header; write one header for the complete mono 16-bit track.
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(bytes + 36, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(bytes, 40);
  fs.writeFileSync(rawWavPath, Buffer.concat([header, ...chunks]));
}
