import fs from "fs";
import path from "path";
import type { TaskItem } from "./store/task-store";

export const TASK_OUTPUT_RETENTION_MS = 72 * 60 * 60 * 1000;

/** The first successful completion is immutable; later logs must not extend it. */
export function taskCompletedAt(task: TaskItem): number | undefined {
  if (Number.isFinite(task.completedAt)) return task.completedAt;
  if (task.status !== "completed") return undefined;
  return Number.isFinite(task.updatedAt) ? task.updatedAt : task.createdAt;
}

export function taskOutputExpiresAt(task: TaskItem): number | undefined {
  const completedAt = taskCompletedAt(task);
  return completedAt === undefined ? undefined : completedAt + TASK_OUTPUT_RETENTION_MS;
}

export function isTaskOutputExpired(task: TaskItem, now = Date.now()): boolean {
  const expiresAt = taskOutputExpiresAt(task);
  return expiresAt !== undefined && now >= expiresAt;
}

const GENERATED_FILES = new Set([
  "final.mp4", "preview.mp4", "rendered-source.mp4", "voice-track.wav", "voice-track.mp3",
  "voice-raw.wav", "exact-final-indextts.wav", "production-report.json", "evidence.json",
]);

export function isGeneratedTaskFile(relative: string): boolean {
  return GENERATED_FILES.has(relative) || /^lipsync-chunks\/result-\d+\.mp4$/.test(relative);
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Never follow symlinks, remove directories, or accept arbitrary persisted paths. */
export function purgeLocalTaskOutputs(task: TaskItem, options: {
  cwd?: string; protectedSources?: readonly string[]; now?: number;
} = {}): void {
  if (!isTaskOutputExpired(task, options.now) || !/^[a-zA-Z0-9_-]+$/.test(task.id)) return;
  const cwd = path.resolve(options.cwd || process.cwd());
  const protectedPaths = new Set((options.protectedSources || []).flatMap(source => {
    if (source.startsWith("/jobs/") || source.startsWith("/uploads/")) {
      return [path.resolve(cwd, "public", `.${source}`)];
    }
    return path.isAbsolute(source) ? [path.resolve(source)] : [];
  }));
  for (const candidate of [...protectedPaths]) {
    if (fs.existsSync(candidate)) protectedPaths.add(fs.realpathSync.native(candidate));
  }
  for (const root of [path.join(cwd, ".runtime", "jobs"), path.join(cwd, "public", "jobs")]) {
    const jobDir = path.join(root, task.id);
    if (!fs.existsSync(jobDir)) continue;
    // Validate every parent before walking so a junction cannot redirect cleanup.
    if ([path.dirname(root), root, jobDir].some(dir => fs.lstatSync(dir).isSymbolicLink())) continue;
    const realCwd = fs.realpathSync.native(cwd);
    const realJobDir = fs.realpathSync.native(jobDir);
    if (!inside(realCwd, realJobDir)) continue;
    const candidates = [...GENERATED_FILES];
    const chunks = path.join(jobDir, "lipsync-chunks");
    if (fs.existsSync(chunks) && !fs.lstatSync(chunks).isSymbolicLink() && fs.statSync(chunks).isDirectory()) {
      candidates.push(...fs.readdirSync(chunks).map(name => `lipsync-chunks/${name}`).filter(isGeneratedTaskFile));
    }
    for (const relative of candidates) {
      const candidate = path.resolve(jobDir, relative);
      if (!inside(jobDir, candidate) || protectedPaths.has(candidate) || !fs.existsSync(candidate)) continue;
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const realCandidate = fs.realpathSync.native(candidate);
      if (!inside(realJobDir, realCandidate) || protectedPaths.has(realCandidate)) continue;
      fs.unlinkSync(candidate);
    }
  }
}

export function generatedTaskObjectKeys(task: TaskItem, listedKeys: readonly string[], now = Date.now()): string[] {
  if (!isTaskOutputExpired(task, now) || !/^[a-zA-Z0-9_-]+$/.test(task.id)) return [];
  const prefix = `jobs/${task.id}/`;
  return [...new Set([
    ...[...GENERATED_FILES].map(file => `${prefix}${file}`),
    ...(task.results.lipsyncChunks || []).flatMap(chunk => Number.isSafeInteger(chunk.index) && chunk.index >= 0
      ? [`${prefix}lipsync-chunks/result-${chunk.index}.mp4`] : []),
    ...listedKeys.filter(key => key.startsWith(prefix) && isGeneratedTaskFile(key.slice(prefix.length))),
  ])];
}
