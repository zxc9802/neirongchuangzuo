import { logServerError } from "../server/safe-log";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import crypto from "crypto";

export interface MediaProbeInfo {
  durationSeconds: number;
  videoDurationSeconds?: number;
  width?: number;
  height?: number;
  displayAspectRatio?: string;
  fps?: number;
  videoCodec?: string;
  hasAudio: boolean;
  audioChannels?: number;
  sampleRate?: number;
  rotation?: number;
}

export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (data) => hash.update(data));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", (err) => reject(err));
  });
}

export function execMediaCommand(
  command: string,
  args: string[],
  options: { timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? 20 * 60_000;
    const maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    const stop = () => {
      if (child.exitCode !== null || child.killed) return;
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        if (child.exitCode !== null) return;
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {}
      }, 1000).unref();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      reject(error);
    };
    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        fail(new Error(`Command output exceeded ${maxOutputBytes} bytes`));
        return;
      }
      if (target === "stdout") stdout += chunk.toString();
      else stderr += chunk.toString();
    };
    const timer = setTimeout(
      () => fail(new Error(`Command timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error(
            `Command "${command} ${args.join(" ")}" failed with code ${code}: ${stderr || stdout}`
          )
        );
      }
    });
    child.on("error", (err) => fail(err));
  });
}

const execCommand = execMediaCommand;

export async function encodeMp3(inputPath: string, outputPath: string): Promise<void> {
  await execCommand("ffmpeg", [
    "-y", "-i", inputPath, "-vn", "-c:a", "libmp3lame", "-b:a", "192k", outputPath,
  ]);
}

export async function probeMedia(filePath: string): Promise<MediaProbeInfo> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Media file not found: ${filePath}`);
  }

  const args = [
    "-v",
    "error",
    "-show_entries",
    "format=duration,size,bit_rate:stream=index,codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels,duration:stream_tags=rotate:stream_side_data=rotation",
    "-of",
    "json",
    filePath,
  ];

  const output = await execCommand("ffprobe", args);
  const data = JSON.parse(output);

  const format = data.format || {};
  const durationSeconds = parseFloat(format.duration || "0");
  if (!durationSeconds || durationSeconds <= 0) {
    throw new Error(`Invalid or zero media duration for: ${filePath}`);
  }

  let width: number | undefined;
  let height: number | undefined;
  let fps: number | undefined;
  let videoCodec: string | undefined;
  let hasAudio = false;
  let audioChannels: number | undefined;
  let sampleRate: number | undefined;
  let rotation: number | undefined;
  let videoDurationSeconds: number | undefined;

  for (const stream of data.streams || []) {
    if (stream.codec_type === "video" && width === undefined) {
      width = parseInt(stream.width, 10);
      height = parseInt(stream.height, 10);
      videoCodec = stream.codec_name;
      const streamDuration = Number(stream.duration);
      if (Number.isFinite(streamDuration) && streamDuration > 0) videoDurationSeconds = streamDuration;
      if (stream.r_frame_rate) {
        const [num, den] = stream.r_frame_rate.split("/").map(Number);
        if (num && den) fps = Math.round((num / den) * 100) / 100;
      }
      if (stream.tags?.rotate) {
        rotation = parseInt(stream.tags.rotate, 10);
      } else if (stream.side_data_list) {
        for (const sd of stream.side_data_list) {
          if (sd.rotation !== undefined) {
            rotation = parseInt(sd.rotation, 10);
          }
        }
      }
    } else if (stream.codec_type === "audio") {
      hasAudio = true;
      audioChannels = parseInt(stream.channels, 10);
      sampleRate = parseInt(stream.sample_rate, 10);
    }
  }

  return {
    durationSeconds,
    videoDurationSeconds,
    width,
    height,
    fps,
    videoCodec,
    hasAudio,
    audioChannels,
    sampleRate,
    rotation,
  };
}

export async function applyToneProfile(
  sourceWavPath: string,
  outputWavPath: string,
  rate: number
): Promise<{ rawDuration: number; selectedDuration: number }> {
  const probeBefore = await probeMedia(sourceWavPath);
  const rawDuration = probeBefore.durationSeconds;

  if (Math.abs(rate - 1.0) < 0.001) {
    fs.copyFileSync(sourceWavPath, outputWavPath);
    return { rawDuration, selectedDuration: rawDuration };
  }

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    sourceWavPath,
    "-filter:a",
    `atempo=${rate}`,
    "-codec:a",
    "pcm_s16le",
    outputWavPath,
  ];

  await execCommand("ffmpeg", args);
  const probeAfter = await probeMedia(outputWavPath);
  return { rawDuration, selectedDuration: probeAfter.durationSeconds };
}

export async function prepareSourceVideo(
  inputVideoPath: string,
  targetDurationSeconds: number,
  outputVideoPath: string,
  fitMode: "smart" | "preserve" = "smart"
): Promise<{ duration: number; width: number; height: number; fps: number }> {
  const probe = await probeMedia(inputVideoPath);
  if (!probe.width || !probe.height) {
    throw new Error("Video has no valid dimensions");
  }

  const videoDuration = probe.durationSeconds;
  const maxEdge = 1920;
  let targetWidth = probe.width;
  let targetHeight = probe.height;

  // Scale down if larger than 1920
  if (Math.max(targetWidth, targetHeight) > maxEdge) {
    if (targetWidth >= targetHeight) {
      targetHeight = Math.round((targetHeight * maxEdge) / targetWidth);
      targetWidth = maxEdge;
    } else {
      targetWidth = Math.round((targetWidth * maxEdge) / targetHeight);
      targetHeight = maxEdge;
    }
  }

  // Ensure even dimensions
  targetWidth = targetWidth % 2 === 0 ? targetWidth : targetWidth - 1;
  targetHeight = targetHeight % 2 === 0 ? targetHeight : targetHeight - 1;

  // Video filter: scale and set 30 fps
  const vf = `scale=${targetWidth}:${targetHeight}:flags=lanczos,fps=30,format=yuv420p`;

  const args: string[] = ["-hide_banner", "-loglevel", "error", "-y"];

  if (videoDuration < targetDurationSeconds) {
    // Video is shorter than audio -> loop video to match audio length
    const loopCount = Math.ceil(targetDurationSeconds / videoDuration) + 1;
    args.push("-stream_loop", `${loopCount}`, "-i", inputVideoPath);
  } else if (videoDuration > targetDurationSeconds + 0.5) {
    if (fitMode === "preserve") {
      throw Object.assign(new Error(
        `Video duration (${videoDuration.toFixed(1)}s) is longer than narration (${targetDurationSeconds.toFixed(1)}s), but fitMode is set to preserve.`
      ), { code: "MEDIA_FIT_MISMATCH" });
    }
    // Smart trim to target duration
    args.push("-i", inputVideoPath);
  } else {
    args.push("-i", inputVideoPath);
  }

  // Declare every input before output options; otherwise -vf applies to lavfi.
  if (!probe.hasAudio) {
    args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
  }
  args.push("-t", `${targetDurationSeconds}`);
  args.push("-vf", vf);
  args.push("-c:v", "libx264", "-preset", "fast", "-crf", "18");

  // Keep original audio track or synthesize silent track (HeyGen requires audio track)
  if (probe.hasAudio) {
    args.push("-c:a", "aac", "-b:a", "192k");
  } else {
    args.push("-c:a", "aac", "-b:a", "192k", "-shortest");
  }

  args.push("-movflags", "+faststart");
  args.push(outputVideoPath);

  await execCommand("ffmpeg", args);
  const outProbe = await probeMedia(outputVideoPath);

  return {
    duration: outProbe.durationSeconds,
    width: outProbe.width || targetWidth,
    height: outProbe.height || targetHeight,
    fps: outProbe.fps || 30,
  };
}

export async function sliceMedia(params: {
  inputPath: string;
  outputPath: string;
  startSeconds: number;
  durationSeconds: number;
  kind: "video" | "audio";
}): Promise<void> {
  const { inputPath, outputPath, startSeconds, durationSeconds, kind } = params;
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Slice source not found: ${inputPath}`);
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-ss",
    startSeconds.toFixed(3),
    "-i",
    inputPath,
    "-t",
    durationSeconds.toFixed(3),
  ];

  if (kind === "video") {
    args.push(
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart"
    );
  } else {
    args.push("-vn", "-c:a", "pcm_s16le");
  }

  args.push(outputPath);
  await execCommand("ffmpeg", args);
}

export async function concatVideos(
  inputPaths: string[],
  outputPath: string
): Promise<void> {
  if (inputPaths.length === 0) {
    throw new Error("没有可拼接的视频分段");
  }
  if (inputPaths.length === 1) {
    fs.copyFileSync(inputPaths[0], outputPath);
    return;
  }

  const listPath = `${outputPath}.concat.txt`;
  const listBody = inputPaths
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join("\n");
  fs.writeFileSync(listPath, listBody, "utf-8");

  try {
    await execCommand("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      outputPath,
    ]);
  } finally {
    try {
      fs.unlinkSync(listPath);
    } catch {
      // ignore
    }
  }
}

export async function finalizeVideo(
  heygenVideoPath: string,
  exactWavPath: string,
  outputFinalPath: string
): Promise<MediaProbeInfo> {
  if (!fs.existsSync(heygenVideoPath)) {
    throw new Error(`HeyGen video not found: ${heygenVideoPath}`);
  }
  if (!fs.existsSync(exactWavPath)) {
    throw new Error(`Exact IndexTTS WAV not found: ${exactWavPath}`);
  }

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    heygenVideoPath,
    "-i",
    exactWavPath,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "256k",
    "-movflags",
    "+faststart",
    outputFinalPath,
  ];

  await execCommand("ffmpeg", args);
  return await probeMedia(outputFinalPath);
}

export async function extractAudioFromMedia(
  inputMediaFilePath: string,
  outputAudioPath: string
): Promise<string> {
  if (!fs.existsSync(inputMediaFilePath)) {
    throw new Error(`Media file not found: ${inputMediaFilePath}`);
  }

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    inputMediaFilePath,
    "-vn",
    "-acodec",
    "libmp3lame",
    "-q:a",
    "2",
    outputAudioPath,
  ];

  await execCommand("ffmpeg", args);
  return outputAudioPath;
}

export async function extractVideoThumbnail(
  videoPathOrUrl: string,
  outputImagePath: string,
  seekSeconds = 1.0
): Promise<string> {
  const isUrl = videoPathOrUrl.startsWith("http://") || videoPathOrUrl.startsWith("https://");
  if (!isUrl && !fs.existsSync(videoPathOrUrl)) {
    throw new Error(`Video not found: ${videoPathOrUrl}`);
  }

  // Ensure output directory exists
  const outputDir = path.dirname(outputImagePath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Attempt 1: Accurate frame seek at specified second (after -i to ensure proper keyframe decoding)
  try {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-threads",
      "1",
      "-filter_threads",
      "1",
      "-filter_complex_threads",
      "1",
      "-max_alloc",
      `${256 * 1024 * 1024}`,
      "-y",
      "-i",
      videoPathOrUrl,
      "-ss",
      `${seekSeconds}`,
      "-vframes",
      "1",
      "-vf",
      "scale='min(640,iw)':'min(640,ih)':force_original_aspect_ratio=decrease",
      "-q:v",
      "2",
      outputImagePath,
    ];
    await execMediaCommand("ffmpeg", args, {
      timeoutMs: 2 * 60_000,
      maxOutputBytes: 512 * 1024,
    });
    if (fs.existsSync(outputImagePath) && fs.statSync(outputImagePath).size > 100) {
      return outputImagePath;
    }
  } catch (err: any) {
    logServerError("media.seek_failed", err, "warn");
  }

  // Attempt 2: Fallback to 0.3s
  try {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-threads",
      "1",
      "-filter_threads",
      "1",
      "-filter_complex_threads",
      "1",
      "-max_alloc",
      `${256 * 1024 * 1024}`,
      "-y",
      "-i",
      videoPathOrUrl,
      "-ss",
      "00:00:00.3",
      "-vframes",
      "1",
      "-vf",
      "scale='min(640,iw)':'min(640,ih)':force_original_aspect_ratio=decrease",
      "-q:v",
      "2",
      outputImagePath,
    ];
    await execMediaCommand("ffmpeg", args, {
      timeoutMs: 2 * 60_000,
      maxOutputBytes: 512 * 1024,
    });
    if (fs.existsSync(outputImagePath) && fs.statSync(outputImagePath).size > 100) {
      return outputImagePath;
    }
  } catch (err: any) {
    logServerError("media.seek_fallback_failed", err, "warn");
  }

  // Attempt 3: Fallback to very first frame (0.01s)
  const argsFirstFrame = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-threads",
    "1",
    "-filter_threads",
    "1",
    "-filter_complex_threads",
    "1",
    "-max_alloc",
    `${256 * 1024 * 1024}`,
    "-y",
    "-i",
    videoPathOrUrl,
    "-vframes",
    "1",
    "-vf",
    "scale='min(640,iw)':'min(640,ih)':force_original_aspect_ratio=decrease",
    "-q:v",
    "2",
    outputImagePath,
  ];
  await execMediaCommand("ffmpeg", argsFirstFrame, {
    timeoutMs: 2 * 60_000,
    maxOutputBytes: 512 * 1024,
  });
  return outputImagePath;
}
