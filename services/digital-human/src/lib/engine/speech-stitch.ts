import fs from "fs";
import path from "path";
import { execMediaCommand, probeMedia } from "./ffmpeg";

// Keep individual requests short enough that the provider rarely needs another internal split.
const MAX_SEGMENT_CHARACTERS = 50;

export function splitSpeechText(text: string): string[] {
  const result: string[] = [];
  const sentences = new Intl.Segmenter("zh", { granularity: "sentence" });
  const words = new Intl.Segmenter("zh", { granularity: "word" });
  const length = (value: string) => Array.from(value).length;
  for (const { segment } of sentences.segment(text.trim())) {
    const sentence = segment.trim();
    if (!sentence) continue;
    if (length(sentence) <= MAX_SEGMENT_CHARACTERS) {
      result.push(sentence);
      continue;
    }
    let current = "";
    for (const clause of sentence.split(/(?<=[，,、：:])/u)) {
      const units = length(clause) <= MAX_SEGMENT_CHARACTERS
        ? [clause] : Array.from(words.segment(clause), item => item.segment);
      for (const unit of units) {
        if (current && length(current + unit) > MAX_SEGMENT_CHARACTERS) {
          if (current.trim()) result.push(current.trim());
          current = "";
        }
        current += unit;
      }
    }
    if (current.trim()) result.push(current.trim());
  }
  return result;
}

export async function stitchSpeechSegments(
  segments: { text: string; audioPath: string }[],
  outputPath: string,
): Promise<void> {
  const joinDir = fs.mkdtempSync(path.join(path.dirname(outputPath), ".tts-join-"));
  try {
    const entries: string[] = [];
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index];
      const name = `${index}.wav`;
      const pause = /[。！？!?；;.][”’"')）]*$/u.test(segment.text.trim()) ? 0.18 : 0.06;
      const normalized = path.join(joinDir, `${index}-source.wav`);
      await execMediaCommand("ffmpeg", ["-v", "error", "-y", "-i", segment.audioPath,
        "-ar", "22050", "-ac", "1", "-c:a", "pcm_s16le", normalized]);
      const source = await probeMedia(normalized);
      // silenceremove in FFmpeg 5.1 can erase valid speech. Detect the edges separately
      // and trim by time so a detector never rewrites or removes pauses within speech.
      const detection = await execMediaCommand("ffmpeg", ["-hide_banner", "-nostats", "-i", normalized,
        "-af", "silencedetect=noise=-55dB:d=0.01", "-f", "null", "-"], { returnStderr: true });
      const silences: { start: number; end: number }[] = [];
      let silenceStart: number | undefined;
      for (const match of detection.matchAll(/silence_(start|end):\s*(-?[\d.]+(?:e[+-]?\d+)?)/gi)) {
        const time = Math.max(0, Number(match[2]));
        if (match[1] === "start") silenceStart = time;
        else if (silenceStart !== undefined) {
          silences.push({ start: silenceStart, end: time });
          silenceStart = undefined;
        }
      }
      if (silenceStart !== undefined) silences.push({ start: silenceStart, end: source.durationSeconds });
      const first = silences[0]; const last = silences[silences.length - 1];
      const start = first && first.start <= 1 / 22050 ? first.end : 0;
      const end = last && last.end >= source.durationSeconds - 1 / 22050 ? last.start : source.durationSeconds;
      if (end - start <= 0.02) throw new Error(`第 ${index + 1} 段没有可用声音，请重新合成`);
      const filters = [`atrim=start=${Math.max(0, start - 0.035)}:end=${Math.min(source.durationSeconds, end + 0.035)}`, "asetpts=N/SR/TB"];
      const padding = index < segments.length - 1 ? pause : 0;
      if (padding) filters.push(`apad=pad_dur=${padding}`);
      await execMediaCommand("ffmpeg", ["-v", "error", "-y", "-i", normalized,
        "-af", filters.join(","), "-c:a", "pcm_s16le", path.join(joinDir, name)]);
      const audio = await probeMedia(path.join(joinDir, name));
      if (audio.durationSeconds <= padding + 0.02) throw new Error(`第 ${index + 1} 段没有可用声音，请重新合成`);
      entries.push(`file '${name}'`);
    }
    const listPath = path.join(joinDir, "parts.txt");
    fs.writeFileSync(listPath, entries.join("\n"));
    await execMediaCommand("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "1",
      "-i", listPath, "-c:a", "pcm_s16le", outputPath]);
  } finally {
    fs.rmSync(joinDir, { recursive: true, force: true });
  }
}
