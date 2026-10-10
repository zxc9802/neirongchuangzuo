import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { concatVideos, execMediaCommand, probeMedia } from "../src/lib/engine/ffmpeg.ts";

test("provider tail frames and audio padding do not accumulate at lipsync chunk boundaries", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lipsync-timing-"));
  try {
    const parts = ["red", "blue"].map(color => path.join(dir, `${color}.mp4`));
    for (const [i, color] of ["red", "blue"].entries()) {
      // Like the live failure: two extra video frames, plus a longer audio stream.
      await execMediaCommand("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i",
        `color=c=${color}:s=64x64:r=30:d=1.066667`, "-f", "lavfi", "-i",
        "sine=frequency=440:sample_rate=44100:duration=1.093", "-c:v", "libx264",
        "-c:a", "libmp3lame", "-pix_fmt", "yuv420p", parts[i]]);
    }
    const output = path.join(dir, "joined.mp4");
    await concatVideos(parts, output, [1, 1]);
    const info = await probeMedia(output);
    assert.ok(Math.abs(info.videoDurationSeconds - 2) < 1 / 30,
      `Provider/container padding leaked into final duration: ${info.videoDurationSeconds}`);
    assert.equal(info.hasAudio, false);
    const pixel = path.join(dir, "boundary.rgb");
    await execMediaCommand("ffmpeg", ["-v", "error", "-i", output,
      "-vf", "select=eq(n\\,30),scale=1:1", "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", pixel]);
    const samples = fs.readFileSync(pixel);
    // The first frame after the boundary must already be the second (blue) clip.
    assert.ok(samples[2] > samples[0],
      "The preceding chunk's tail moved the next chunk off its speech boundary");
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test("large provider truncation is rejected without replacing the existing render", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lipsync-truncated-"));
  try {
    const input = path.join(dir, "short.mp4");
    const output = path.join(dir, "existing.mp4");
    fs.writeFileSync(output, "existing-render");
    await execMediaCommand("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
      "color=c=blue:s=64x64:r=30:d=0.5", "-c:v", "libx264", input]);
    await assert.rejects(concatVideos([input], output, [1]), {code: "LIPSYNC_MEDIA"});
    assert.equal(fs.readFileSync(output, "utf8"), "existing-render");
    assert.ok(!fs.readdirSync(dir).some(name => name.startsWith(".lipsync-chunks-")));
  } finally {fs.rmSync(dir, {recursive: true, force: true});}
});
