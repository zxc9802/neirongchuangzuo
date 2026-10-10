import fs from "fs";
import path from "path";
import { CosService } from "../cos";
import { logServerError } from "../server/safe-log";
import { execMediaCommand, probeMedia } from "./ffmpeg";

// A playback-only rendition. The original download and its exact audio stay intact.
export async function createVideoPreview(finalPath: string): Promise<string | undefined> {
  const previewPath = path.join(path.dirname(finalPath), "preview.mp4");
  const candidate = path.join(path.dirname(finalPath), "preview-encoding.mp4");
  try {
    const source = await probeMedia(finalPath);
    const bytes = fs.statSync(finalPath).size;
    if (!source.width || !source.height || source.durationSeconds <= 0) return;
    // Small files already buffer quickly; don't add another generation stage for them.
    if (bytes * 8 / source.durationSeconds <= 1_800_000) return;
    await execMediaCommand("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", finalPath,
      "-map", "0:v:0", "-map", "0:a:0?",
      "-vf", "scale=w='min(720,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
      "-c:v", "libx264", "-threads", "2", "-preset", "fast", "-crf", "25",
      "-maxrate", "1600k", "-bufsize", "3200k", "-pix_fmt", "yuv420p",
      "-c:a", "copy", "-movflags", "+faststart", candidate], { timeoutMs: 90_000 });
    if (fs.statSync(candidate).size >= bytes) return;
    fs.renameSync(candidate, previewPath);
    if (CosService.isConfigured()) {
      return await CosService.uploadFile(previewPath, `jobs/${path.basename(path.dirname(finalPath))}/preview.mp4`);
    }
    return previewPath;
  } catch (error) {
    // Playback optimization must never reject or replace an otherwise usable final.
    logServerError("video.preview_unavailable", error, "warn");
    return undefined;
  } finally {
    try { fs.rmSync(candidate, { force: true }); } catch { /* Optional cleanup. */ }
  }
}
