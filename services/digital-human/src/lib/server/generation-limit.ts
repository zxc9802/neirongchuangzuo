import "server-only";
import fs from "node:fs";
import path from "node:path";
import { logServerError } from "./safe-log";

const WINDOW_MS = 60 * 60_000;
const MAX_USER_ATTEMPTS = 6;
const MAX_GLOBAL_ATTEMPTS = 30;
const MAX_ACTIVE = 4;
const activeUsers = new Set<string>();

export class GenerationLimitError extends Error {
  readonly status: number;
  constructor(message: string, status = 429) {
    super(message);
    this.status = status;
  }
}

// The attempt ledger survives task deletion and process restarts. Share the state
// volume between worker processes; concurrency slots below are per process.
export function acquireGenerationSlot(userId: string, options: {enforceHourlyLimit?: boolean} = {}): () => void {
  if (activeUsers.has(userId) || activeUsers.size >= MAX_ACTIVE) {
    throw new GenerationLimitError("生成任务正在处理中，请完成后再试");
  }
  // Internal/local motion work still reserves concurrency, but is not an external attempt.
  if (options.enforceHourlyLimit !== false) recordHourlyAttempt(userId);
  activeUsers.add(userId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeUsers.delete(userId);
  };
}

function recordHourlyAttempt(userId: string): void {
  const file = process.env.GENERATION_LIMIT_PATH ||
    path.join(process.cwd(), ".runtime", "state", "generation-limits.json");
  const lock = `${file}.lock`;
  let descriptor: number | undefined;
  try {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) fs.unlinkSync(lock);
    } catch (error: any) { if (error.code !== "ENOENT") throw error; }
    descriptor = fs.openSync(lock, "wx", 0o600);
    const parsed: unknown = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
    if (!Array.isArray(parsed) || parsed.some(entry => !entry ||
      typeof entry.userId !== "string" || !Number.isFinite(entry.at))) {
      throw new Error("Invalid generation ledger");
    }
    const now = Date.now();
    const entries = parsed.filter(entry => entry.at > now - WINDOW_MS);
    if (entries.length >= MAX_GLOBAL_ATTEMPTS ||
      entries.filter(entry => entry.userId === userId).length >= MAX_USER_ATTEMPTS) {
      throw new GenerationLimitError("本小时生成次数已达上限，请稍后再试（每个外部账号每小时最多 6 次）");
    }
    entries.push({userId, at: now});
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(entries), {mode: 0o600});
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, {force: true});
    }
  } catch (error) {
    if (error instanceof GenerationLimitError) throw error;
    logServerError("generation.admission_failed", error);
    throw new GenerationLimitError("生成服务暂时繁忙，请稍后重试", 503);
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
      fs.unlinkSync(lock);
    }
  }
}
