import * as defaultFs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const IMAGE_RETENTION_HOURS = 72;
export const IMAGE_RETENTION_MS = IMAGE_RETENTION_HOURS * 60 * 60 * 1000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const RESULT_FILE = /^result-(?:[1-9]|1[0-5])\.(?:png|jpg|webp)$/;
const STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'interrupted', 'expired']);
const REPLACE_RETRY_DELAYS = [20, 40, 80];
const timestamp = value => typeof value === 'number' ? value : Date.parse(value);
const validTask = (task, id = task?.id) => task && typeof task === 'object' && !Array.isArray(task)
  && typeof id === 'string' && UUID.test(id) && task.id === id && STATUSES.has(task.status)
  && (task.kind === undefined || task.kind === 'image' || task.kind === 'chat');
const failure = task => task.status === 'failed' || task.status === 'interrupted';

// Only the fixed generated output filenames are disposable. Task records stay as
// durable deduplication tombstones; uploads and unknown files are never removed.
export function createImageRetention({ storageDir, now = Date.now, logger = console, cleanupIntervalMs = 60_000, fsOverrides = {}, onTaskExpired } = {}) {
  if (typeof storageDir !== 'string' || !storageDir) throw new Error('AI storage directory required');
  const fs = { ...defaultFs, ...fsOverrides };
  const root = resolve(storageDir);
  let canonicalRoot, cleanupPromise, timer, disposed = false;
  let lastSweep = null, lastSuccess = null, failures = 0, deletedFiles = 0, warnings = 0;
  const pending = new Set();
  const writes = new Map();
  const stamp = () => new Date(now()).toISOString();
  const inside = path => {
    const suffix = relative(canonicalRoot, path);
    return suffix && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
  };
  function warn() {
    warnings++;
    try { logger?.warn?.('AI_RETENTION_CLEANUP_PENDING', { pending: pending.size, failures }); }
    catch { /* A logging failure must not interrupt cleanup or requests. */ }
  }
  async function checkRoot() {
    const stat = await fs.lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(root) !== canonicalRoot) throw new Error('Unsafe AI storage directory');
  }
  const ready = (async () => {
    await fs.mkdir(root, { recursive: true });
    const stat = await fs.lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe AI storage directory');
    canonicalRoot = await fs.realpath(root);
  })();
  ready.catch(() => {});

  async function taskDirectory(id, { create = false } = {}) {
    await ready;
    if (typeof id !== 'string' || !UUID.test(id)) throw new Error('Invalid AI task identifier');
    await checkRoot();
    const directory = join(root, id);
    if (create) {
      try { await fs.mkdir(directory); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !inside(await fs.realpath(directory))) throw new Error('Unsafe AI task directory');
    return directory;
  }
  async function ordinaryFile(path) {
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile() || !inside(await fs.realpath(path))) throw new Error('Unsafe AI task file');
    return stat;
  }
  async function resultPath(id, filename) {
    if (!RESULT_FILE.test(filename)) throw new Error('Invalid AI result filename');
    const path = join(await taskDirectory(id), filename);
    await ordinaryFile(path);
    return path;
  }
  function expiresAt(task) {
    const completion = [task.completedAt, task.updatedAt, task.createdAt].map(timestamp).find(Number.isFinite) ?? 0;
    const ceiling = completion + IMAGE_RETENTION_MS;
    const explicit = timestamp(task.expiresAt);
    return Number.isFinite(explicit) ? Math.min(ceiling, explicit) : ceiling;
  }
  function isExpired(task) { return task.status === 'expired' || (task.status === 'completed' && expiresAt(task) <= now()); }
  function publicTask(task) {
    const { fingerprint, userId, ...output } = task;
    if (task.status === 'completed' || task.status === 'expired') output.expiresAt = new Date(expiresAt(task)).toISOString();
    if (isExpired(task)) Object.assign(output, { status: 'expired', code: 'RESULT_EXPIRED', images: [] });
    if (isExpired(task) || failure(task)) delete output.text;
    if (failure(task)) output.images = [];
    return output;
  }
  function normalizeTask(task) {
    if (!validTask(task)) throw new Error('Invalid AI task metadata');
    if (task.status === 'completed' && !Number.isFinite(timestamp(task.completedAt))) task.completedAt = stamp();
    if (failure(task)) {
      if (!Number.isFinite(timestamp(task.failedAt))) task.failedAt = stamp();
      delete task.text;
      task.images = [];
    }
    if (isExpired(task)) {
      task.expiresAt = new Date(expiresAt(task)).toISOString();
      task.status = 'expired'; task.code = 'RESULT_EXPIRED'; task.images = [];
      delete task.text;
    }
  }
  async function save(task) {
    normalizeTask(task);
    // Snapshot before yielding, and serialize per ID so a terminal state cannot
    // be overwritten by an older, slower write.
    const serialized = JSON.stringify(task);
    const previous = writes.get(task.id) || Promise.resolve();
    const write = previous.catch(() => {}).then(async () => {
      const directory = await taskDirectory(task.id, { create: true });
      const metadata = join(directory, 'task.json');
      try { await ordinaryFile(metadata); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const temp = join(directory, `task-${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temp, serialized, { flag: 'wx', mode: 0o600 });
        for (let attempt = 0; ; attempt++) {
          await taskDirectory(task.id);
          await ordinaryFile(temp);
          try { await ordinaryFile(metadata); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          try { await fs.rename(temp, metadata); break; }
          catch (error) {
            // Windows readers or scanners can briefly lock the old metadata.
            // Retry this same local snapshot only, with fresh safety checks.
            if (process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes(error.code) || attempt >= REPLACE_RETRY_DELAYS.length) throw error;
            await delay(REPLACE_RETRY_DELAYS[attempt]);
          }
        }
      } catch (error) {
        try { await taskDirectory(task.id); await ordinaryFile(temp); await fs.unlink(temp); } catch { /* Leave only a safe temporary file on failure. */ }
        throw error;
      }
    });
    writes.set(task.id, write);
    try { await write; } finally { if (writes.get(task.id) === write) writes.delete(task.id); }
  }
  async function readTask(id) {
    const metadata = join(await taskDirectory(id), 'task.json');
    await ordinaryFile(metadata);
    const task = JSON.parse(await fs.readFile(metadata, 'utf8'));
    if (!validTask(task, id)) throw new Error('Invalid AI task metadata');
    return task;
  }
  async function loadTasks() {
    await ready;
    await checkRoot();
    const tasks = new Map();
    for (const id of await fs.readdir(root)) {
      if (!UUID.test(id)) continue;
      try { tasks.set(id, await readTask(id)); }
      catch { /* Unknown or malformed records are considered by orphan cleanup. */ }
    }
    return tasks;
  }
  async function removeResults(id, onlyOld = false) {
    const directory = await taskDirectory(id);
    let incomplete = false;
    for (const filename of await fs.readdir(directory)) {
      if (!RESULT_FILE.test(filename)) continue;
      try {
        const path = await resultPath(id, filename);
        const stat = await ordinaryFile(path);
        if (onlyOld && stat.mtimeMs + IMAGE_RETENTION_MS > now()) continue;
        await fs.unlink(path);
        deletedFiles++;
      } catch (error) {
        if (error.code !== 'ENOENT') { incomplete = true; failures++; }
      }
    }
    if (incomplete) throw new Error('AI result cleanup incomplete');
  }
  async function sweep(jobs) {
    if (disposed) return;
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      await ready;
      lastSweep = stamp();
      const failedThisSweep = new Set();
      const attempt = async (id, operation) => {
        try { await operation(); pending.delete(id); }
        catch { pending.add(id); failedThisSweep.add(id); failures++; }
      };
      try {
        await checkRoot();
        for (const [id, task] of jobs) {
          if (!validTask(task, id)) continue;
          if (!isExpired(task) && !failure(task)) continue;
          // Hide before filesystem work; inability to delete must never extend
          // availability of an expired result.
          const before = JSON.stringify(task);
          if (isExpired(task)) {
            // Freeze the legacy timestamp before save can fill completedAt on
            // a newly completed task. Reading old records must never renew them.
            task.expiresAt = new Date(expiresAt(task)).toISOString();
            task.status = 'expired';
          }
          normalizeTask(task);
          await attempt(id, async () => {
            let failure;
            try {
              if (before !== JSON.stringify(task) || pending.has(id)) await save(task);
              await removeResults(id);
            } catch (error) { failure = error; }
            // File cleanup and credit reconciliation must both be attempted.
            // Neither failed deletion nor a billing outage can renew access.
            if (task.status === 'expired' && onTaskExpired) {
              try { await onTaskExpired(task); } catch (error) { failure ||= error; }
            }
            if (failure) throw failure;
          });
        }
        for (const id of await fs.readdir(root)) {
          if (!UUID.test(id) || jobs.has(id)) continue;
          await attempt(id, async () => {
            // A valid record created since loadTasks is not an orphan and must
            // not lose its outputs simply because this Map is stale.
            try { await readTask(id); return; } catch { /* Missing or broken metadata. */ }
            await removeResults(id, true);
          });
        }
        pending.delete('storage');
      } catch { pending.add('storage'); failedThisSweep.add('storage'); failures++; }
      if (failedThisSweep.size) warn();
      else if (!pending.size) lastSuccess = stamp();
    })();
    try { await cleanupPromise; } finally { cleanupPromise = undefined; }
  }
  async function start(jobs) {
    if (disposed) return;
    await sweep(jobs);
    if (disposed || timer || cleanupIntervalMs <= 0) return;
    timer = setInterval(() => { void sweep(jobs).catch(() => { pending.add('storage'); failures++; warn(); }); }, cleanupIntervalMs);
    timer.unref?.();
  }
  function status() { return { retentionHours: IMAGE_RETENTION_HOURS, lastSweep, lastSuccess, pending: pending.size, failures, deletedFiles, warnings }; }
  async function dispose() {
    disposed = true;
    clearInterval(timer);
    await cleanupPromise;
    await Promise.allSettled([...writes.values()]);
  }
  return { ready, loadTasks, save, resultPath, taskDirectory, expiresAt, isExpired, publicTask, sweep, start, status, dispose };
}
