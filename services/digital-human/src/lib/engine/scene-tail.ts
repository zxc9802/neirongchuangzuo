import fs from "fs";
import path from "path";
import { execMediaCommand, probeMedia } from "./ffmpeg";

const SAMPLE_BYTES = 24 * 40;
const FPS = 30;

// Compare coarse composition and movement, not a speaker's individual mouth
// shapes. Choose real consecutive frames; never reverse or freeze a gesture.
export function selectContinuationShots(samples: Uint8Array[], sampleFps: number, sourceSeconds: number, extraSeconds: number) {
  const difference = (a: Uint8Array, b: Uint8Array) => {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return sum / a.length;
  };
  const motion = samples.map((frame, i) => i ? difference(frame, samples[i - 1]) : 0);
  const shots: { startSeconds: number; durationSeconds: number }[] = [];
  let end = samples.length - 1;
  let remainingFrames = Math.ceil(extraSeconds * FPS);
  while (remainingFrames > 0) {
    const shotFrames = Math.min(remainingFrames, Math.max(1, Math.floor(Math.min(20, sourceSeconds / 2) * FPS)));
    const duration = shotFrames / FPS;
    const count = Math.max(1, Math.ceil(duration * sampleFps));
    let best = 0, bestScore = Infinity;
    for (let start = 0; start + count < samples.length; start++) {
      const averageMotion = motion.slice(start + 1, start + count + 1).reduce((a, b) => a + b, 0) / count;
      const overlap = shots.reduce((total, shot) => total + Math.max(0,
        Math.min((start + count) / sampleFps, shot.startSeconds + shot.durationSeconds) -
        Math.max(start / sampleFps, shot.startSeconds)), 0) / duration;
      const score = difference(samples[end], samples[start]) + averageMotion * 2 + overlap * 30;
      if (score < bestScore) { bestScore = score; best = start; }
    }
    shots.push({ startSeconds: best / sampleFps, durationSeconds: duration });
    end = Math.min(samples.length - 1, best + count);
    remainingFrames -= shotFrames;
  }
  return shots;
}

// Extend BEFORE lip-sync so every reused frame receives the new narration's
// mouth motion. Recovery uses the resulting persisted source-video.mp4 as usual.
export async function prepareSceneContinuation(params: {
  inputPath: string;
  targetSeconds: number;
  outputPath: string;
  onLog?: (message: string) => void;
}): Promise<string> {
  const source = await probeMedia(params.inputPath);
  const sourceFrames = Math.floor((source.videoDurationSeconds ?? source.durationSeconds) * FPS);
  const targetFrames = Math.ceil(params.targetSeconds * FPS);
  if (sourceFrames >= targetFrames || sourceFrames < 2) return params.inputPath;
  const sourceSeconds = sourceFrames / FPS;
  const folder = fs.mkdtempSync(path.join(path.dirname(params.outputPath), ".scene-tail-"));
  try {
    const sampleFps = Math.min(2, 480 / sourceSeconds);
    let shots;
    try {
      const raw = path.join(folder, "samples.gray");
      await execMediaCommand("ffmpeg", ["-v", "error", "-nostdin", "-y", "-i", params.inputPath,
        "-an", "-vf", `fps=${sampleFps},scale=24:40`, "-pix_fmt", "gray", "-f", "rawvideo", raw]);
      const bytes = fs.readFileSync(raw);
      const samples = Array.from({ length: Math.floor(bytes.length / SAMPLE_BYTES) }, (_, i) => bytes.subarray(i * SAMPLE_BYTES, (i + 1) * SAMPLE_BYTES));
      if (samples.length < 2) throw new Error("Too few picture samples");
      shots = selectContinuationShots(samples, sampleFps, sourceSeconds, (targetFrames - sourceFrames) / FPS);
    } catch {
      // Selection is an editing aid, never another quality gate. If sampling
      // fails, use a bounded middle section of this same source and keep going.
      shots = [];
      let remaining = targetFrames - sourceFrames;
      while (remaining > 0) {
        const frames = Math.min(remaining, Math.max(1, Math.floor(sourceFrames / 2)));
        shots.push({ startSeconds: sourceSeconds / 4, durationSeconds: frames / FPS });
        remaining -= frames;
      }
      params.onLog?.("自动选段暂不可用，使用原片中段接续画面，继续制作");
    }
    const clips = [{ startSeconds: 0, durationSeconds: sourceSeconds }, ...shots];
    for (const [i, clip] of clips.entries()) {
      await execMediaCommand("ffmpeg", ["-v", "error", "-nostdin", "-y",
        "-ss", String(clip.startSeconds), "-i", params.inputPath, "-an",
        "-vf", "setpts=PTS-STARTPTS,scale=trunc(iw*sar/2)*2:trunc(ih/2)*2,setsar=1,fps=30,format=yuv420p",
        "-frames:v", String(Math.round(clip.durationSeconds * FPS)),
        "-c:v", "libx264", "-threads", "2", "-preset", "fast", "-crf", "18", path.join(folder, `${i}.mp4`)]);
    }
    const list = path.join(folder, "parts.txt");
    fs.writeFileSync(list, clips.map((_, i) => `file '${i}.mp4'`).join("\n"));
    await execMediaCommand("ffmpeg", ["-v", "error", "-nostdin", "-y", "-f", "concat", "-safe", "1", "-i", list,
      "-c:v", "copy", "-an", "-movflags", "+faststart", params.outputPath]);
    const result = await probeMedia(params.outputPath);
    if (!result.width || Math.abs((result.videoDurationSeconds ?? result.durationSeconds) * FPS - targetFrames) > 1) {
      throw new Error("原片接续画面导出不完整");
    }
    fs.writeFileSync(path.join(path.dirname(params.outputPath), "scene-tail.json"), JSON.stringify({
      sourceSeconds, targetSeconds: targetFrames / FPS, shots,
    }));
    params.onLog?.(`已从同一原片选取 ${shots.map(s => `${s.startSeconds.toFixed(1)}–${(s.startSeconds + s.durationSeconds).toFixed(1)} 秒`).join("、")}接续画面，随后按完整配音统一对口型`);
    return params.outputPath;
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}
