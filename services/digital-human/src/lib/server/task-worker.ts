import "server-only";
import fs from "node:fs";
import path from "node:path";
import { hostname } from "node:os";
import { createHash, randomUUID } from "node:crypto";

export interface TaskWorker { pid: number; host: string; instance: string; startedAt: number }
const key = Symbol.for("qiya.digital-human.task-worker");
const shared = globalThis as typeof globalThis & { [key]?: TaskWorker };
const worker = shared[key] ||= { pid: process.pid, host: hostname(), instance: randomUUID(), startedAt: Date.now() };
const STALE_MS = 90_000;
const filename = (taskId: string, suffix: string) => path.join(process.cwd(), ".runtime", "state", "credit-workers",
  createHash("sha256").update(taskId).digest("hex") + suffix);

export function currentTaskWorker(): TaskWorker { return { ...worker }; }

function pidAlive(owner: TaskWorker): boolean | undefined {
  if (owner.host !== hostname()) return undefined;
  if (owner.pid === process.pid) return owner.instance === worker.instance;
  try { process.kill(owner.pid, 0); return true; }
  catch (error: any) { return error.code === "ESRCH" ? false : undefined; }
}

export function taskWorkerInterrupted(taskId: string, owner?: TaskWorker): boolean {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !owner.instance || !owner.host) return false;
  const alive = pidAlive(owner);
  if (alive !== undefined) return !alive;
  try {
    const heartbeat = JSON.parse(fs.readFileSync(filename(taskId, ".heartbeat"), "utf8"));
    return heartbeat.instance === owner.instance && Date.now() - heartbeat.at > STALE_MS;
  } catch { return Date.now() - owner.startedAt > STALE_MS; }
}

export function startTaskHeartbeat(taskId: string): () => void {
  const target = filename(taskId, ".heartbeat");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const beat = () => fs.writeFileSync(target, JSON.stringify({ ...worker, at: Date.now() }), { mode: 0o600 });
  beat();
  const timer = setInterval(() => { try { beat(); } catch { /* Submission still checks durable task state under its guard. */ } }, 10_000);
  timer.unref();
  return () => { clearInterval(timer); try { if (JSON.parse(fs.readFileSync(target, "utf8")).instance === worker.instance) fs.unlinkSync(target); } catch {} };
}

/** Serialize stale refunds with the last persisted pre-POST check across Next workers. */
export async function withTaskBillingGuard<T>(taskId: string, action: () => Promise<T> | T): Promise<T> {
  const target = filename(taskId, ".lock"), takeover = target + ".takeover", token = randomUUID();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      fs.writeFileSync(target, JSON.stringify({ ...worker, token, at: Date.now() }), { flag: "wx", mode: 0o600 });
      break;
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() > deadline) throw new Error("任务积分状态正在核对，请稍后重试");
      let existing: TaskWorker & { token: string; at: number };
      try { existing = JSON.parse(fs.readFileSync(target, "utf8")); }
      catch { await new Promise(resolve => setTimeout(resolve, 25)); continue; }
      const alive = pidAlive(existing);
      if (alive === false || alive === undefined && Date.now() - existing.at > STALE_MS) {
        let ownsTakeover = false;
        try {
          fs.writeFileSync(takeover, token, { flag: "wx", mode: 0o600 }); ownsTakeover = true;
          if (JSON.parse(fs.readFileSync(target, "utf8")).token === existing.token) fs.unlinkSync(target);
        } catch (cause: any) { if (!["EEXIST", "ENOENT"].includes(cause.code)) throw cause; }
        finally { if (ownsTakeover) { try { fs.unlinkSync(takeover); } catch {} } }
        if (ownsTakeover) continue;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  const timer = setInterval(() => {
    try { const content = JSON.parse(fs.readFileSync(target, "utf8")); if (content.token === token) fs.writeFileSync(target, JSON.stringify({ ...content, at: Date.now() })); } catch {}
  }, 10_000);
  timer.unref();
  try { return await action(); }
  finally {
    clearInterval(timer);
    try { if (JSON.parse(fs.readFileSync(target, "utf8")).token === token) fs.unlinkSync(target); } catch {}
  }
}
