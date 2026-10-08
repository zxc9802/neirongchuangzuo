import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

export const FILES_TTL_MS = 3 * 24 * 60 * 60 * 1000;
export const TASK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const INTERRUPTED = new Set(['uploading', 'analysing', 'generating', 'retrying']);
const copy = value => value == null ? value : structuredClone(value);
const empty = () => ({ version: 1, profile: null, tasks: {}, ledger: {}, garbage: [] });
const dayAt = value => new Date(value + 8 * 3600000).toISOString().slice(0, 10);
const problem = (code, message, statusCode = 503) => Object.assign(new Error(message), { code, statusCode, status: statusCode });
export function validMediaKey(key) {
  return typeof key === 'string' && key.length <= 300 && key.split('/').length >= 2
    && key.split('/').every(part => /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9]{1,8})?$/.test(part));
}
function userKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_:@.-]{1,200}$/.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value)) {
    throw problem('invalid_user', '账号标识无效。', 400);
  }
  return value;
}
function taskKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value)) {
    throw problem('invalid_task', '任务标识无效。', 400);
  }
  return value;
}
function checkedPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw problem('invalid_task', '任务数据无效。', 400);
  const result = copy(patch);
  for (const field of ['id', 'userId', 'createdAt', 'updatedAt', 'textExpiresAt', '__proto__', 'constructor', 'prototype']) delete result[field];
  for (const field of ['files', 'sourceImages']) {
    if (result[field] === undefined) continue;
    if (!Array.isArray(result[field]) || result[field].length > 30 || result[field].some(file =>
      !file || !validMediaKey(file.key) || !Number.isFinite(file.expiresAt))) {
      throw problem('invalid_file', '任务文件标识无效。', 400);
    }
  }
  return result;
}
async function directory(path) {
  const root = resolve(path);
  if (root === parse(root).root) throw problem('storage_unavailable', '数据目录无效。');
  let cursor = root;
  while (cursor !== parse(cursor).root) {
    try {
      const stat = await lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw problem('storage_unavailable', '数据目录不安全。');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    cursor = dirname(cursor);
  }
  await mkdir(root, { recursive: true });
}
async function safeFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 128 * 1024 * 1024) {
    throw problem('storage_unavailable', '数据文件不安全。');
  }
}
function validState(state) {
  return state?.version === 1 && state.tasks && !Array.isArray(state.tasks) && typeof state.tasks === 'object'
    && state.ledger && !Array.isArray(state.ledger) && typeof state.ledger === 'object';
}

/** A single active workflow instance. PostgreSQL transactions serialize changes per account. */
export function createRestaurantStore({ dataDir = '.data/restaurant', databaseUrl = process.env.RESTAURANT_DATABASE_URL || process.env.AUTH_DATABASE_URL,
  now = Date.now, packageDailyLimit = 20, pool: injectedPool, acquireDatabaseLock = true } = {}) {
  if (!Number.isSafeInteger(packageDailyLimit) || packageDailyLimit < 0) throw problem('invalid_limit', '发布包额度无效。', 400);
  const root = resolve(dataDir);
  const file = join(root, 'workspaces.json');
  const lock = join(root, '.store-lock');
  const token = randomUUID();
  let local = { version: 1, users: {} };
  let pool, guard, owned = false, closed = false, closing, fatal;
  let sequence = Promise.resolve();

  async function saveLocal(next) {
    await directory(root);
    await safeFile(lock);
    if (JSON.parse(await readFile(lock, 'utf8')).token !== token) throw problem('instance_locked', '餐饮服务运行锁已失效。');
    try { await safeFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = join(root, `.workspaces-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(next));
      await handle.sync();
      await handle.close(); handle = undefined;
      await rename(temporary, file);
      local = next;
    } catch (error) { fatal = problem('storage_unavailable', '任务保存失败，已暂停新的操作。'); throw fatal; }
    finally { await handle?.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
  }
  async function acquireLocal() {
    await directory(root);
    try {
      const handle = await open(lock, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ token, pid: process.pid, hostname: hostname() })); await handle.sync(); owned = true; }
      finally { await handle.close(); }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await safeFile(lock);
      const previous = JSON.parse(await readFile(lock, 'utf8'));
      if (previous.hostname !== hostname() || !Number.isSafeInteger(previous.pid) || typeof previous.token !== 'string') throw problem('instance_locked', '餐饮服务已有实例运行。');
      let absent = false;
      try { process.kill(previous.pid, 0); } catch (cause) { absent = cause.code === 'ESRCH'; }
      if (!absent) throw problem('instance_locked', '餐饮服务已有实例运行。');
      // A takeover guard prevents a contender from unlinking a newly acquired lock.
      let takeover;
      try {
        takeover = await open(join(root, '.store-takeover'), 'wx', 0o600);
        const current = JSON.parse(await readFile(lock, 'utf8'));
        if (current.token !== previous.token) throw problem('instance_locked', '餐饮服务已有实例运行。');
        await unlink(lock);
        const handle = await open(lock, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ token, pid: process.pid, hostname: hostname() })); await handle.sync(); owned = true; }
        finally { await handle.close(); }
      } finally { await takeover?.close(); if (takeover) await unlink(join(root, '.store-takeover')).catch(() => {}); }
    }
  }
  async function stateFor(userId, operation, write = true) {
    userKey(userId);
    if (!pool) {
      const next = copy(local);
      const state = next.users[userId] || empty();
      const value = await operation(state);
      if (write) { next.users[userId] = state; await saveLocal(next); }
      return copy(value);
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO restaurant_workspaces (user_id,state) VALUES ($1,$2::jsonb) ON CONFLICT (user_id) DO NOTHING', [userId, JSON.stringify(empty())]);
      const { rows } = await client.query('SELECT state FROM restaurant_workspaces WHERE user_id=$1 FOR UPDATE', [userId]);
      const state = rows[0].state;
      if (!validState(state)) throw problem('storage_unavailable', '任务记录无效。');
      const value = await operation(state);
      if (write) await client.query('UPDATE restaurant_workspaces SET state=$2::jsonb, updated_at=NOW() WHERE user_id=$1', [userId, JSON.stringify(state)]);
      await client.query('COMMIT');
      return copy(value);
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  async function users() {
    return pool ? (await pool.query('SELECT user_id FROM restaurant_workspaces')).rows.map(row => row.user_id) : Object.keys(local.users);
  }
  function reservationExpires(state, entry) {
    const task = state.tasks[entry.taskId];
    if (!task) return 0;
    const files = task.files || [];
    const deadline = files.length ? Math.min(...files.map(file => file.expiresAt)) : entry.expiresAt ?? entry.reservedAt + FILES_TTL_MS;
    return Math.min(deadline, task.textExpiresAt);
  }
  function summary(state) {
    const day = dayAt(now());
    const records = Object.values(state.ledger);
    const used = records.filter(entry => entry.status === 'completed' && entry.day === day).length;
    // Pending deliveries span midnight. Otherwise yesterday's confirmations could bypass today's limit.
    const reserved = records.filter(entry => entry.status === 'reserved' && reservationExpires(state, entry) > now()).length;
    return { day, timeZone: 'Asia/Shanghai', limit: packageDailyLimit, used, reserved, remaining: Math.max(0, packageDailyLimit - used - reserved) };
  }
  function change(state, id, patch) {
    const task = state.tasks[id];
    if (!task || task.textExpiresAt <= now()) return null;
    state.tasks[id] = { ...task, ...checkedPatch(patch), updatedAt: now() };
    return state.tasks[id];
  }
  async function recover() {
    for (const userId of await users()) {
      await stateFor(userId, state => {
        for (const task of Object.values(state.tasks)) {
          if (!INTERRUPTED.has(task.status)) continue;
          if (task.status === 'uploading' && task.uploadProtocol === 'batches') continue;
          task.status = 'failed'; task.updatedAt = now();
          task.error = '服务重启中断了任务，未扣正式生成额度。上游调用结果尚未核实，请联系管理员核对后重新上传，不会自动重复请求。';
          task.code = 'SERVICE_RESTARTED'; task.retryable = false;
          if (state.ledger[task.id]?.status === 'reserved') state.ledger[task.id].status = 'released';
        }
      });
    }
  }
  const ready = (async () => {
    try {
      if (databaseUrl || injectedPool) {
        if (injectedPool) pool = injectedPool;
        else {
          const { default: pg } = await import('pg');
          pool = new pg.Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 12000 });
        }
        guard = await pool.connect();
        if (acquireDatabaseLock) {
          const { rows } = await guard.query("SELECT pg_try_advisory_lock(hashtext('nrcz.restaurant.workflow.v1')) AS locked");
          if (!rows[0]?.locked) throw problem('instance_locked', '餐饮服务已有实例运行，请保持单实例部署。');
        }
        guard.on?.('error', () => { fatal = problem('storage_unavailable', '数据库连接中断，已暂停新的操作。'); });
        await guard.query(`CREATE TABLE IF NOT EXISTS restaurant_workspaces (
          user_id TEXT PRIMARY KEY, state JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      } else {
        if (process.env.NODE_ENV === 'production') throw problem('database_required', '生产环境必须配置餐饮或账号数据库连接。');
        await acquireLocal();
        try {
          await safeFile(file);
          const parsed = JSON.parse(await readFile(file, 'utf8'));
          if (parsed?.version !== 1 || !parsed.users || typeof parsed.users !== 'object' || Array.isArray(parsed.users)
            || Object.values(parsed.users).some(state => !validState(state))) throw problem('storage_unavailable', '任务记录损坏。');
          local = parsed;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      await recover();
    } catch (error) { fatal = error; throw error; }
  })();
  ready.catch(() => {});
  function run(operation) {
    const result = sequence.then(async () => { await ready; if (closed || fatal) throw fatal || problem('store_closed', '任务存储已关闭。'); return operation(); });
    sequence = result.catch(() => {});
    return result;
  }

  return {
    ready,
    mode: databaseUrl || injectedPool ? 'postgres' : 'local',
    getProfile(userId) { return run(() => stateFor(userId, state => state.profile, false)); },
    saveProfile(userId, profile) { return run(() => stateFor(userId, state => {
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw problem('invalid_profile', '门店资料无效。', 400);
      state.profile = { ...copy(profile), updatedAt: now() }; return state.profile;
    })); },
    createTask(userId, task) {
      return run(() => stateFor(userId, state => {
        const id = taskKey(task.id || task.requestId || randomUUID());
        if (state.tasks[id]) return state.tasks[id];
        if (state.ledger[id]?.status === 'completed') throw problem('task_expired', '此任务已过期，请创建新的任务。', 409);
        const createdAt = now();
        state.tasks[id] = { ...checkedPatch(task), id, userId, status: task.status || 'analysing', createdAt, updatedAt: createdAt,
          textExpiresAt: createdAt + TASK_TTL_MS };
        return state.tasks[id];
      }));
    },
    getTask(userId, id) { taskKey(id); return run(() => stateFor(userId, state => state.tasks[id]?.textExpiresAt > now() ? state.tasks[id] : null, false)); },
    listTasks(userId) { return run(() => stateFor(userId, state => Object.values(state.tasks).filter(task => task.textExpiresAt > now()).sort((a, b) => b.createdAt - a.createdAt), false)); },
    patchTask(userId, id, patch) { taskKey(id); return run(() => stateFor(userId, state => change(state, id, patch))); },
    claimTask(userId, id, allowedStatuses, patch) {
      taskKey(id);
      return run(() => stateFor(userId, state => allowedStatuses.includes(state.tasks[id]?.status) ? change(state, id, patch) : null));
    },
    reservePackage(userId, taskId) {
      taskKey(taskId);
      return run(() => stateFor(userId, state => {
        if (!state.tasks[taskId] || state.tasks[taskId].textExpiresAt <= now()) throw problem('task_not_found', '任务不存在。', 404);
        const previous = state.ledger[taskId];
        if (previous?.status === 'completed' || previous?.status === 'reserved' && reservationExpires(state, previous) > now()) return { reserved: true, duplicate: true, usage: summary(state) };
        if (summary(state).remaining <= 0) throw problem('package_limit', '今日发布包额度已用完，北京时间次日恢复。', 429);
        state.ledger[taskId] = { taskId, day: dayAt(now()), status: 'reserved', reservedAt: now(), expiresAt: now() + FILES_TTL_MS };
        return { reserved: true, duplicate: false, usage: summary(state) };
      }));
    },
    releasePackage(userId, taskId) {
      taskKey(taskId);
      return run(() => stateFor(userId, state => { if (state.ledger[taskId]?.status === 'reserved') state.ledger[taskId].status = 'released'; return summary(state); }));
    },
    completeTask(userId, taskId, patch = {}) {
      taskKey(taskId);
      return run(() => stateFor(userId, state => {
        if (!state.tasks[taskId] || state.tasks[taskId].textExpiresAt <= now()) throw problem('task_not_found', '任务不存在。', 404);
        const entry = state.ledger[taskId];
        if (entry?.status === 'completed') return state.tasks[taskId];
        if (entry && reservationExpires(state, entry) <= now() || state.tasks[taskId].files?.some(file => file.expired || file.expiresAt <= now())) {
          throw problem('FILES_EXPIRED', '结果文件或生成预留已过期，请重新上传并创建新的任务。', 410);
        }
        if (entry?.status !== 'reserved') throw problem('quota_not_reserved', '发布包未预留额度，无法完成。', 409);
        const quota = summary(state);
        if (quota.used + quota.reserved - 1 >= packageDailyLimit) throw problem('package_limit', '今日发布包额度已用完，北京时间次日恢复。', 429);
        entry.status = 'completed'; entry.completedAt = now(); entry.day = dayAt(now());
        return change(state, taskId, { ...patch, status: 'completed', completedAt: now() });
      }));
    },
    usage(userId) { return run(() => stateFor(userId, summary, false)); },
    sweep() {
      return run(async () => {
        const expiredTaskIds = [], expiredFiles = [], pendingCredits = [];
        for (const userId of await users()) {
          await stateFor(userId, state => {
            state.garbage ||= [];
            state.pendingCreditCleanup ||= {};
            for (const task of Object.values(state.tasks)) {
              const expiredTask = task.textExpiresAt <= now();
              if (task.status === 'uploading' && task.uploadProtocol === 'batches' && task.uploadExpiresAt <= now()) {
                task.status = 'failed'; task.code = 'FILES_EXPIRED'; task.retryable = false; task.updatedAt = now(); task.error = '上传素材已过3天保留期，请创建新任务。';
              }
              const unsettledCredits = task.billing?.source === 'workspace' && !['settled', 'released'].includes(task.billing.status);
              if ((task.status === 'awaiting_confirmation' || unsettledCredits && task.billing.status === 'settle_pending') && task.files?.some(file => file.expired || file.expiresAt <= now())) {
                task.status = 'failed'; task.code = 'FILES_EXPIRED'; task.retryable = false; task.updatedAt = now();
                task.error = '图片和下载包已过期，请重新上传照片并创建新的任务。';
                if (state.ledger[task.id]?.status === 'reserved') state.ledger[task.id].status = 'released';
              }
              // Keep only the financial reference until cleanup is confirmed, even after the 30-day task record is removed.
              if (unsettledCredits && (expiredTask || task.status === 'failed')) state.pendingCreditCleanup[task.billing.taskId] = { userId, taskId: task.id, creditId: task.billing.taskId };
              for (const item of [...(task.files || []), ...(task.sourceImages || []), ...(task.pendingUpload?.sourceImages || [])]) {
                if (item.expired || (!expiredTask && item.expiresAt > now())) continue;
                if (validMediaKey(item.key) && !state.garbage.some(file => file.key === item.key)) state.garbage.push({ userId, taskId: task.id, key: item.key });
                item.expired = true;
              }
              if (expiredTask) {
                delete state.tasks[task.id];
                if (state.ledger[task.id]?.status === 'reserved') state.ledger[task.id].status = 'released';
                expiredTaskIds.push({ userId, taskId: task.id });
              }
            }
            for (const entry of Object.values(state.ledger)) {
              if (entry.status === 'reserved' && reservationExpires(state, entry) <= now()) entry.status = 'released';
            }
            expiredFiles.push(...state.garbage);
            pendingCredits.push(...Object.values(state.pendingCreditCleanup));
          });
        }
        // Duplicate references to the same source object need just one deletion.
        return { expiredTaskIds, expiredFiles: [...new Map(expiredFiles.map(file => [file.key, file])).values()], pendingCredits };
      });
    },
    acknowledgeCredits(userId, taskId, creditId, record) {
      taskKey(taskId); taskKey(creditId);
      return run(() => stateFor(userId, state => {
        if (state.pendingCreditCleanup?.[creditId]?.taskId !== taskId) return;
        const task = state.tasks[taskId];
        if (task?.billing?.taskId === creditId) task.billing = { ...task.billing, status: record?.status === 'settled' ? 'settled' : 'released', chargedPoints: record?.chargedPoints ?? 0 };
        delete state.pendingCreditCleanup[creditId];
      }));
    },
    acknowledgeFiles(userId, keys) {
      return run(() => stateFor(userId, state => { state.garbage = (state.garbage || []).filter(file => !keys.includes(file.key)); }));
    },
    close() {
      if (closing) return closing;
      closing = (async () => {
        await sequence; await ready.catch(() => {}); closed = true;
        if (guard) { if (acquireDatabaseLock) await guard.query("SELECT pg_advisory_unlock(hashtext('nrcz.restaurant.workflow.v1'))").catch(() => {}); guard.release(); guard = undefined; }
        if (!injectedPool) await pool?.end().catch(() => {});
        if (owned) {
          try { await safeFile(lock); if (JSON.parse(await readFile(lock, 'utf8')).token === token) await unlink(lock); } catch {}
          owned = false;
        }
      })();
      return closing;
    },
  };
}
