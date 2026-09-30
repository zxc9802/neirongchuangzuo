import type {SemanticCache} from '../motion-library/semantics';
import "server-only";
import fs from "node:fs";
import path from "node:path";
import { CosService } from "@/lib/cos";
import { getAppConfig } from "@/lib/config";
import type { MotionProject } from "./contract";
import { DEFAULT_MOTION_CROP } from "./contract";

export interface StoredMotionProject extends Omit<MotionProject, "sourceUrl" | "finalUrl"> {
  semanticCache?: SemanticCache;
  userId?: string; source: string; output?: string;
}
const state = globalThis as typeof globalThis & { motionStore?: { loaded: boolean; projects: StoredMotionProject[]; queue: Promise<unknown>; active: Set<string> } };
const store = state.motionStore ??= {loaded: false, projects: [], queue: Promise.resolve(), active: new Set()};
const file = () => path.join(getAppConfig().storageDir, "..", "state", "motion-projects.json");
const cloudKey = "_system/motion-projects.json";
export function motionDirectory(id: string): string {
  if (!/^motion_[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid motion ID");
  return path.join(getAppConfig().storageDir, id);
}
async function load() {
  if (store.loaded) return;
  const local: StoredMotionProject[] = fs.existsSync(file()) ? JSON.parse(fs.readFileSync(file(), "utf8")) : [];
  const remote = CosService.isConfigured() ? await CosService.getJsonFromCos<StoredMotionProject[]>(cloudKey) : [];
  const byId = new Map(local.map(p => [p.id, p]));
  for (const p of remote || []) if (!byId.has(p.id) || p.updatedAt > byId.get(p.id)!.updatedAt) byId.set(p.id, p);
  store.projects = [...byId.values()];
  // Background processes do not survive a server restart; make the retry explicit.
  for (const p of store.projects) if (["analyzing", "rendering"].includes(p.status)) {
    p.status = "failed"; p.error = "处理因服务重启中断，请重试"; p.message = p.error;
  }
  store.loaded = true;
}
async function persist() {
  fs.mkdirSync(path.dirname(file()), {recursive: true});
  fs.writeFileSync(`${file()}.tmp`, JSON.stringify(store.projects), {mode: 0o600});
  fs.renameSync(`${file()}.tmp`, file());
  if (CosService.isConfigured()) await CosService.saveJsonToCos(cloudKey, store.projects);
}
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = store.queue.then(fn, fn); store.queue = next.catch(() => {}); return next;
}
export const MotionStore = {
  list: () => serial(async () => { await load(); return structuredClone(store.projects).sort((a, b) => b.createdAt - a.createdAt); }),
  get: (id: string) => serial(async () => { await load(); return structuredClone(store.projects.find(p => p.id === id)); }),
  save: (project: StoredMotionProject) => serial(async () => {
    await load();
    const index = store.projects.findIndex(p => p.id === project.id);
    const next = structuredClone({...project, updatedAt: Date.now()});
    if (index < 0) store.projects.push(next); else store.projects[index] = next;
    await persist(); return structuredClone(next);
  }),
  claim(id: string) { if (store.active.has(id)) return false; store.active.add(id); return true; },
  release(id: string) { store.active.delete(id); },
};
export function publicMotion(p: StoredMotionProject): MotionProject {
  return {id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt, status: p.status,
    progress: p.progress, message: p.message, error: p.error, duration: p.duration, width: p.width, height: p.height,
    title: p.title, subtitle: p.subtitle, fit: p.fit, crop: p.crop ?? {...DEFAULT_MOTION_CROP}, captions: p.captions, scenes: p.scenes, ...(p.effect ? {effect:p.effect} : {}),
    sourceUrl: `/api/motion/${p.id}/media/source`, finalUrl: p.status === "completed" && p.output ? `/api/motion/${p.id}/media/final?v=${p.updatedAt}` : undefined};
}
