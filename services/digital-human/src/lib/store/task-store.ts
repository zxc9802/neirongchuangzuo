import { logServerError } from "../server/safe-log";
import fs from "fs";
import path from "path";
import { CosService } from "../cos";
import { LipsyncProvider } from "../lipsync-provider";
import type { TaskWorker } from "../server/task-worker";
import {
  generatedTaskObjectKeys, isTaskOutputExpired, purgeLocalTaskOutputs, taskCompletedAt,
} from "../task-output-retention";

export type TaskStep =
  | "idle"
  | "tts"
  | "media_prep"
  | "mcp_preflight"
  | "mcp_lipsync_submit"
  | "mcp_lipsync_polling"
  | "finalize"
  | "done"
  | "error";

export interface LogEntry {
  timestamp: number;
  level: "info" | "warn" | "error" | "success";
  message: string;
  /** Application-authored summary; upstream messages stay private for recovery. */
  publicMessage?: string;
}

export interface TaskBillingInfo {
  source?: "workspace" | "main-app" | "internal";
  isExternalUser: boolean;
  ratePerSecond: number;
  costCnyPerSecond: number;
  requestId?: string;
  estimatedDuration?: number;
  estimatedPoints?: number;
  reservedPoints?: number;
  actualDuration?: number;
  chargedPoints?: number;
  costCny?: number;
  pointsBalanceBefore?: number;
  pointsBalanceAfter?: number;
  status:
    | "not_applicable"
    | "reserving"
    | "reserved"
    | "provider_committed"
    | "settle_pending"
    | "settled"
    | "released"
    | "insufficient_balance";
}

export interface TaskItem {
  executionOwner?: TaskWorker;
  id: string;
  userId?: string;
  userAccount?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  outputsPurgedAt?: number;
  cloudOutputsPurgedAt?: number;
  status: "pending" | "processing" | "completed" | "failed";
  step: TaskStep;
  failedStep?: TaskStep;
  progress: number;
  logs: LogEntry[];
  billing?: TaskBillingInfo;
  inputs: {
    outputType?: "video" | "audio";
    avatarId?: string;
    videoName: string;
    videoPath: string;
    videoUrl: string;
    scriptText: string;
    toneProfile: "low" | "high";
    videoFit: "smart" | "preserve";
    emotionIntensity: number;
    speakerVoiceId?: string;
    speakerAudioUrl?: string;
    emotionAudioUrl?: string;
    lipsyncProvider?: LipsyncProvider;
  };
  results: {
    originalVideoUrl?: string;
    finalVideoUrl?: string;
    exactAudioUrl?: string;
    audioFormat?: "wav" | "mp3";
    evidenceJsonUrl?: string;
    heygenLipsyncId?: string;
    lipsyncProvider?: LipsyncProvider;
    lipsyncCredits?: number;
    pixverseResultUrl?: string;
    heygenResultUrl?: string;
    veedResultUrl?: string;
    chargedPoints?: number;
    costCny?: number;
    billingDuration?: number;
    lipsyncChunks?: {
      index: number;
      lipsyncId?: string;
      resultUrl?: string;
      outputName?: string;
      status: "created" | "ready" | "downloaded";
    }[];
    creditsBefore?: number;
    creditsAfter?: number;
    videoDuration?: number;
    audioDuration?: number;
    resolution?: string;
    fps?: number;
    sha256Video?: string;
    sha256Audio?: string;
  };
  error?: string;
  errorCode?: string;
}

const WORKING_DIR = process.cwd();
const STATE_DIR = path.join(process.cwd(), ".runtime", "state");
const STORE_PATH = path.join(STATE_DIR, "tasks.json");
const BACKUP_STORE_PATH = path.join(STATE_DIR, "tasks.backup.json");
const LEGACY_STORE_PATH = path.join(process.cwd(), ".tasks.json");
const LEGACY_ROOT_BACKUP_STORE_PATH = path.join(process.cwd(), ".tasks.backup.json");
const LEGACY_BACKUP_STORE_PATH = path.join(process.cwd(), "public", "jobs", ".backup", ".tasks.json");
const COS_TASKS_KEY = "_system/tasks.json";
const memoryTasks = new Map<string, TaskItem>();
const deletedTaskIds = new Set<string>();
const subscribers = new Map<string, Set<(task: TaskItem) => void>>();
let hasLoadedFromCloud = false;

function reloadFromDisk() {
  try {
    let raw = "";
    let migrateLegacy = false;
    if (fs.existsSync(STORE_PATH)) {
      raw = fs.readFileSync(STORE_PATH, "utf-8");
    } else if (fs.existsSync(BACKUP_STORE_PATH)) {
      raw = fs.readFileSync(BACKUP_STORE_PATH, "utf-8");
      migrateLegacy = true;
    } else if (fs.existsSync(LEGACY_STORE_PATH)) {
      raw = fs.readFileSync(LEGACY_STORE_PATH, "utf-8");
      migrateLegacy = true;
    } else if (fs.existsSync(LEGACY_ROOT_BACKUP_STORE_PATH)) {
      raw = fs.readFileSync(LEGACY_ROOT_BACKUP_STORE_PATH, "utf-8");
      migrateLegacy = true;
    } else if (fs.existsSync(LEGACY_BACKUP_STORE_PATH)) {
      raw = fs.readFileSync(LEGACY_BACKUP_STORE_PATH, "utf-8");
      migrateLegacy = true;
    }

    if (raw) {
      const arr: TaskItem[] = JSON.parse(raw);
      for (const t of arr) {
        if (!deletedTaskIds.has(t.id)) memoryTasks.set(t.id, t);
      }
      if (migrateLegacy) {
        try {
          fs.mkdirSync(STATE_DIR, { recursive: true });
          fs.writeFileSync(STORE_PATH, raw, "utf-8");
          fs.writeFileSync(BACKUP_STORE_PATH, raw, "utf-8");
        } catch {}
      }
    }
  } catch (e) {
    // ignore read error
  }
}

reloadFromDisk();

function persistStore(strict = false) {
  try {
    const arr = Array.from(memoryTasks.values()).sort(
      (a, b) => b.createdAt - a.createdAt
    );
    const content = JSON.stringify(arr, null, 2);
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, content, "utf-8");

    // Mirror to persistent mounted volume
    try {
      fs.writeFileSync(BACKUP_STORE_PATH, content, "utf-8");
    } catch {}

    // Mirror to cloud object storage for 100% persistent cloud recovery across container restarts
    if (CosService.isConfigured()) {
      CosService.saveJsonToCos(COS_TASKS_KEY, arr).catch((err) => {
        logServerError("tasks.sync_failed", err, "warn");
      });
    }
  } catch (e) {
    if (strict) throw e;
    logServerError("tasks.persist_failed", e);
  }
}

let retentionSweep: Promise<void> | undefined;

function sweepExpiredTaskOutputs(): Promise<void> {
  if (retentionSweep) return retentionSweep;
  retentionSweep = Promise.resolve().then(async () => {
    reloadFromDisk();
    const all = [...memoryTasks.values()];
    let changed = false;
    for (const task of all) {
      if (task.completedAt === undefined && task.status === "completed") {
        task.completedAt = taskCompletedAt(task);
        changed = true;
      }
    }
    // Persist the legacy completion timestamp before any asynchronous cleanup.
    if (changed) persistStore();
    const protectedSources = all.flatMap(task => [
      task.inputs.videoPath, task.inputs.videoUrl, task.inputs.speakerAudioUrl,
      task.inputs.emotionAudioUrl, task.results.originalVideoUrl,
    ].filter((source): source is string => Boolean(source)));
    const protectedKeys = new Set(protectedSources.map(source => CosService.getManagedObjectKey(source)).filter(Boolean));
    for (const task of all.filter(task => isTaskOutputExpired(task))) {
      try {
        if (!task.outputsPurgedAt) {
          purgeLocalTaskOutputs(task, { cwd: WORKING_DIR, protectedSources });
          TaskStore.update(task.id, { outputsPurgedAt: Date.now() });
        }
        if (!task.cloudOutputsPurgedAt && CosService.isConfigured()) {
          // Keys come from this completed task's known filenames and segment indices.
          // No bucket scan and no deletion based on third-party URLs.
          const keys = generatedTaskObjectKeys(task, []).filter(key => !protectedKeys.has(key));
          await Promise.all(keys.map(key => CosService.deleteObject(key)));
          TaskStore.update(task.id, { cloudOutputsPurgedAt: Date.now() });
        }
      } catch (error) {
        logServerError("tasks.retention_cleanup_failed", error, "warn");
      }
    }
  }).finally(() => { retentionSweep = undefined; });
  return retentionSweep;
}

// Access checks enforce the exact boundary; this timer also removes inactive outputs.
const retentionTimer = setInterval(() => { void sweepExpiredTaskOutputs(); }, 60_000);
retentionTimer.unref();

export const TaskStore = {
  async getAllAsync(): Promise<TaskItem[]> {
    reloadFromDisk();

    // If local memory is empty or not yet synced with cloud, fetch from cloud object storage
    if ((memoryTasks.size === 0 || !hasLoadedFromCloud) && CosService.isConfigured()) {
      try {
        const cloudTasks = await CosService.getJsonFromCos<TaskItem[]>(COS_TASKS_KEY);
        if (cloudTasks && Array.isArray(cloudTasks) && cloudTasks.length > 0) {
          for (const t of cloudTasks) {
            if (deletedTaskIds.has(t.id)) continue;
            const existing = memoryTasks.get(t.id);
            if (!existing || (t.updatedAt || 0) > (existing.updatedAt || 0)) {
              memoryTasks.set(t.id, t);
            }
          }
          hasLoadedFromCloud = true;
          persistStore();
        }
      } catch (err: any) {
        logServerError("tasks.load_failed", err, "warn");
      }
    }

    await sweepExpiredTaskOutputs();
    return Array.from(memoryTasks.values()).sort(
      (a, b) => b.createdAt - a.createdAt
    );
  },

  async getAsync(id: string): Promise<TaskItem | undefined> {
    reloadFromDisk();
    await sweepExpiredTaskOutputs();
    const local = memoryTasks.get(id);
    if (local) return local;

    await this.getAllAsync();
    return memoryTasks.get(id);
  },

  get(id: string): TaskItem | undefined {
    reloadFromDisk();
    void sweepExpiredTaskOutputs();
    return memoryTasks.get(id);
  },

  getAll(): TaskItem[] {
    reloadFromDisk();
    void sweepExpiredTaskOutputs();
    return Array.from(memoryTasks.values()).sort(
      (a, b) => b.createdAt - a.createdAt
    );
  },

  getLatest(): TaskItem | undefined {
    const all = this.getAll();
    return all.length > 0 ? all[0] : undefined;
  },

  create(data: Omit<TaskItem, "id" | "createdAt" | "updatedAt" | "logs"> & { id?: string }): TaskItem {
    reloadFromDisk();
    const id = data.id || "task_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7);
    if (memoryTasks.has(id)) throw new Error("任务编号已存在");
    deletedTaskIds.delete(id);
    const now = Date.now();
    const task: TaskItem = {
      ...data,
      id,
      createdAt: now,
      updatedAt: now,
      logs: [
        {
          timestamp: now,
          level: "info",
          message: `任务已创建 (${data.inputs.videoName})`,
          publicMessage: "任务已创建",
        },
      ],
    };
    memoryTasks.set(id, task);
    try { persistStore(true); } catch (error) { memoryTasks.delete(id); throw error; }
    this.notify(task);
    return task;
  },

  update(id: string, partial: Partial<TaskItem>): TaskItem | undefined {
    if (deletedTaskIds.has(id)) return undefined;
    reloadFromDisk();
    const existing = memoryTasks.get(id);
    if (!existing) return undefined;
    const updated: TaskItem = {
      ...existing,
      ...partial,
      completedAt: taskCompletedAt(existing) ?? (partial.status === "completed" ? Date.now() : undefined),
      inputs: partial.inputs
        ? { ...existing.inputs, ...partial.inputs }
        : existing.inputs,
      results: partial.results
        ? { ...existing.results, ...partial.results }
        : existing.results,
      updatedAt: Date.now(),
    };
    memoryTasks.set(id, updated);
    try { persistStore(updated.billing?.source === "workspace"); }
    catch (error) { memoryTasks.set(id, existing); throw error; }
    this.notify(updated);
    return updated;
  },

  addLog(
    id: string,
    message: string,
    level: LogEntry["level"] = "info",
    publicMessage?: string
  ): void {
    if (deletedTaskIds.has(id)) return;
    reloadFromDisk();
    const task = memoryTasks.get(id);
    if (!task) return;
    task.completedAt = taskCompletedAt(task);
    task.logs.push({
      timestamp: Date.now(),
      level,
      message,
      publicMessage,
    });
    task.updatedAt = Date.now();
    persistStore();
    this.notify(task);
  },

  delete(id: string): boolean {
    reloadFromDisk();
    const res = memoryTasks.delete(id);
    if (res) {
      deletedTaskIds.add(id);
      persistStore();
    }
    return res;
  },

  isDeleted(id: string): boolean {
    return deletedTaskIds.has(id);
  },

  subscribe(id: string, callback: (task: TaskItem) => void): () => void {
    if (!subscribers.has(id)) {
      subscribers.set(id, new Set());
    }
    subscribers.get(id)!.add(callback);
    return () => {
      const set = subscribers.get(id);
      set?.delete(callback);
      if (set?.size === 0) subscribers.delete(id);
    };
  },

  notify(task: TaskItem): void {
    const set = subscribers.get(task.id);
    if (set) {
      for (const cb of set) {
        try {
          cb(task);
        } catch (e) {
          logServerError("tasks.subscriber_failed", e);
        }
      }
    }
  },
};
