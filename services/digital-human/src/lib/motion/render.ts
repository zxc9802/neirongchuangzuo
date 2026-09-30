import "server-only";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { execMediaCommand, probeMedia, sha256File } from "@/lib/engine/ffmpeg";
import type {EffectTemplate} from "../motion-library/contract";
import { type MotionEdit } from "./contract";

function runRender(job: string, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(process.cwd(), "scripts/render-motion.mjs"), job], {stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32"});
    let pending = "", error = "", settled = false;
    const stop = () => {try {if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL");} catch {}};
    const timer = setTimeout(() => {stop(); finish(new Error("Remotion render timed out"));}, 60 * 60_000);
    const finish = (err?: Error) => {if (settled) return; settled = true; clearTimeout(timer); if (err) {stop(); reject(err);} else resolve();};
    child.stdout.on("data", chunk => {pending += chunk; const lines = pending.split("\n"); pending = lines.pop() || ""; for (const line of lines) {try {const p = JSON.parse(line).progress; if (Number.isFinite(p)) onProgress(p);} catch {}}});
    child.stderr.on("data", chunk => {error = (error + chunk).slice(-8000);});
    child.on("error", finish); child.on("close", code => finish(code === 0 ? undefined : new Error(`Remotion failed: ${error}`)));
  });
}
async function audioHash(file: string) {
  const data = await execMediaCommand("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_packets", "-show_data_hash", "sha256", "-show_entries", "packet=data_hash", "-of", "csv=p=0", file]);
  // Side data may change during MP4 remux; compare the encoded packet payloads only.
  const hashes = data.match(/SHA256:[a-f0-9]{64}/g);
  if (!hashes?.length) throw new Error("Audio packets missing");
  return crypto.createHash("sha256").update(hashes.join("\n")).digest("hex");
}
export async function renderMotion(source: string, edit: MotionEdit, duration: number, onProgress: (p: number) => void, effectTemplate?: EffectTemplate) {
  const dir = path.dirname(source), silent = path.join(dir, "silent.mp4"), final = path.join(dir, "final.mp4"), job = path.join(dir, "render-input.json");
  fs.writeFileSync(job, JSON.stringify({source, edit, duration, output: silent, effectTemplate}), {mode: 0o600});
  await runRender(job, onProgress);
  await execMediaCommand("ffmpeg", ["-v", "error", "-y", "-i", silent, "-i", source, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "copy", "-movflags", "+faststart", final]);
  const probe = await probeMedia(final);
  if (probe.width !== 1080 || probe.height !== 1920 || !probe.hasAudio || Math.abs(probe.durationSeconds - duration) > 0.15) throw new Error("Motion output metadata mismatch");
  await execMediaCommand("ffmpeg", ["-v", "error", "-xerror", "-i", final, "-f", "null", "-"]);
  const before = await audioHash(source), after = await audioHash(final);
  if (before !== after) throw new Error("Motion output changed source audio");
  fs.writeFileSync(path.join(dir, "evidence.json"), JSON.stringify({renderer: "Remotion", ...(edit.effect ? {effect: edit.effect} : {}), duration: probe.durationSeconds, width: probe.width, height: probe.height, fps: probe.fps, fit: edit.fit, crop: edit.crop, scenes: edit.scenes.length, captions: edit.captions.length, sourceSha256: await sha256File(source), finalSha256: await sha256File(final), sourceAudioPacketHash: before, finalAudioPacketHash: after, audioPreserved: true, fullDecode: "passed"}, null, 2));
  fs.rmSync(silent, {force: true}); fs.rmSync(job, {force: true});
  return final;
}
