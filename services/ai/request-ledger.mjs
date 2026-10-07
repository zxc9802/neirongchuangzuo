import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';

const TERMINAL = new Set(['completed', 'failed', 'uncertain', 'cancelled']);
const STATUSES = new Set(['reserved', 'dispatched', ...TERMINAL]);
const DEFAULT_LIMITS = { imageDaily: 20, chatDaily: 100, perMinute: 10 };
const TIME_ZONE = 'Asia/Shanghai';
const dayAt = time => new Date(time + 8 * 3600000).toISOString().slice(0, 10);
const copy = value => value == null ? value : structuredClone(value);
const error = (code, message, status = 503) => Object.assign(new Error(message), { code, status });
const locked = () => error('AI_INSTANCE_LOCKED', '生成服务已有实例运行，或运行锁无法确认，请稍后重试。');
const storageError = () => error('AI_LEDGER_UNAVAILABLE', '调用记录暂时不可用，已暂停新的生成请求。');
const counted = record => record.status === 'reserved' || Number.isFinite(record.dispatchedAt);
const recentAttempt = (record, timestamp) => {
  const age = timestamp - (record.dispatchedAt ?? record.createdAt);
  return age >= 0 && age < 60_000;
};
const quotaError = kind => error('DAILY_QUOTA_EXCEEDED', `${kind === 'image' ? '图片生成' : '对话'}今日调用次数已用完，北京时间次日恢复。`, 429);
const rateError = () => error('RATE_LIMITED', '操作过于频繁，请一分钟后重试。', 429);

async function assertDirectoryChain(path) {
  const resolved = resolve(path);
  if (resolved === parse(resolved).root) throw storageError();
  let cursor = resolved;
  while (cursor !== parse(cursor).root) {
    try {
      const stat = await lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw storageError();
    } catch (cause) {
      if (cause.code !== 'ENOENT') throw cause;
    }
    cursor = dirname(cursor);
  }
}

async function checkedFile(path, maximumBytes) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximumBytes) throw storageError();
  return stat;
}

function safeUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const result = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens']) {
    if (Number.isSafeInteger(usage[key]) && usage[key] >= 0) result[key] = usage[key];
  }
  return Object.keys(result).length ? result : undefined;
}

function safeRecord(record) {
  const safe = {};
  for (const key of ['id', 'kind', 'model', 'status', 'day', 'createdAt', 'dispatchedAt', 'finishedAt', 'code', 'providerRequestId']) {
    if (record[key] !== undefined) safe[key] = record[key];
  }
  const usage = safeUsage(record.usage);
  if (usage) safe.usage = usage;
  return copy(safe);
}

function validRecord(record) {
  return record && /^[A-Za-z0-9_-]{1,128}$/.test(record.id)
    && ['image', 'chat'].includes(record.kind) && STATUSES.has(record.status)
    && typeof record.fingerprint === 'string' && record.fingerprint.length > 0 && record.fingerprint.length <= 256
    && typeof record.model === 'string' && record.model.length <= 200
    && Number.isSafeInteger(record.createdAt) && record.createdAt >= 0
    && (record.dispatchedAt === undefined || Number.isFinite(record.dispatchedAt))
    && (record.finishedAt === undefined || Number.isFinite(record.finishedAt))
    && record.day === dayAt(record.dispatchedAt ?? record.createdAt)
    && (!['dispatched', 'completed', 'uncertain'].includes(record.status) || Number.isFinite(record.dispatchedAt))
    && (record.status !== 'reserved' || record.dispatchedAt === undefined)
    && (!TERMINAL.has(record.status) || Number.isFinite(record.finishedAt));
}

/** Durable attempt counters, not a monetary billing ledger. Never persist request bodies. */
export function createRequestLedger({ storageDir, now = Date.now, limits = {}, logger = () => {} } = {}) {
  const root = resolve(storageDir || '.data/ai');
  const controlDir = join(root, '.runtime-control');
  const lockPath = join(controlDir, 'lock');
  const ledgerPath = join(controlDir, 'requests.json');
  const token = randomUUID();
  const effectiveLimits = Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([key, fallback]) => {
    const value = limits[key] ?? fallback;
    if (!Number.isSafeInteger(value) || value < 0) throw error('INVALID_AI_LIMIT', '调用上限必须为非负整数。', 400);
    return [key, value];
  }));
  let records = new Map();
  let owned = false;
  let closed = false;
  let closing;
  let canonicalRoot;
  let fatal;
  let sequence = Promise.resolve();
  const emit = event => { try { logger(event); } catch {} };

  async function assertPaths() {
    await assertDirectoryChain(controlDir);
    if (await realpath(root) !== canonicalRoot) throw storageError();
  }

  async function readLock() {
    await checkedFile(lockPath, 4096);
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0 || typeof lock.hostname !== 'string'
      || typeof lock.token !== 'string' || !/^[a-f0-9-]{36}$/.test(lock.token)) throw locked();
    return lock;
  }

  async function acquireLock() {
    for (let attempt = 0; attempt < 3; attempt++) {
      let handle;
      try {
        handle = await open(lockPath, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), token, createdAt: now() }));
        await handle.sync();
        owned = true;
        return;
      } catch (cause) {
        if (cause.code !== 'EEXIST') throw storageError();
        let existing;
        try { existing = await readLock(); } catch { throw locked(); }
        if (existing.hostname !== hostname()) throw locked();
        let absent = false;
        try { process.kill(existing.pid, 0); } catch (cause) { absent = cause.code === 'ESRCH'; }
        if (!absent) throw locked();
        // Serialize takeover: a second contender cannot unlink a freshly acquired lock.
        const guardPath = join(controlDir, 'takeover');
        let guard;
        try {
          guard = await open(guardPath, 'wx', 0o600);
          const current = await readLock();
          if (current.token !== existing.token) throw locked();
          await unlink(lockPath);
          handle = await open(lockPath, 'wx', 0o600);
          await handle.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), token, createdAt: now() }));
          await handle.sync();
          owned = true;
          return;
        } catch { throw locked(); }
        finally {
          await guard?.close();
          if (guard) await unlink(guardPath).catch(() => {});
        }
      } finally { await handle?.close(); }
    }
    throw locked();
  }

  async function verifyOwner() {
    await assertPaths();
    if (!owned || (await readLock()).token !== token) throw locked();
  }

  async function persist(next) {
    await verifyOwner();
    try { await checkedFile(ledgerPath, 64 * 1024 * 1024); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    const temporary = join(controlDir, `requests-${token}-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ version: 1, records: [...next.values()] }));
      await handle.sync();
      await handle.close();
      handle = undefined;
      await verifyOwner();
      await rename(temporary, ledgerPath);
      records = next;
    } catch (cause) {
      fatal = storageError();
      emit({ event: 'ai_ledger_write_failed', code: fatal.code });
      throw fatal;
    } finally {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
  }

  async function release() {
    if (!owned) return;
    try {
      await assertPaths();
      const lock = await readLock();
      if (lock.token === token) await unlink(lockPath);
    } catch (cause) {
      if (cause.code !== 'ENOENT') emit({ event: 'ai_ledger_unlock_failed', code: 'AI_INSTANCE_LOCKED' });
    } finally { owned = false; }
  }

  const ready = (async () => {
    try {
      await assertDirectoryChain(root);
      await mkdir(root, { recursive: true });
      await assertDirectoryChain(root);
      canonicalRoot = await realpath(root);
      await assertDirectoryChain(controlDir);
      await mkdir(controlDir, { recursive: true });
      await assertPaths();
      await acquireLock();
      try {
        await checkedFile(ledgerPath, 64 * 1024 * 1024);
        const saved = JSON.parse(await readFile(ledgerPath, 'utf8'));
        if (saved.version !== 1 || !Array.isArray(saved.records) || !saved.records.every(validRecord)) throw storageError();
        records = new Map(saved.records.map(record => [record.id, { ...safeRecord(record), fingerprint: record.fingerprint }]));
        if (records.size !== saved.records.length) throw storageError();
      } catch (cause) { if (cause.code !== 'ENOENT') throw storageError(); }
      const recovered = new Map(records);
      let changed = false;
      for (const [id, record] of records) {
        if (!['reserved', 'dispatched'].includes(record.status)) continue;
        recovered.set(id, { ...record, status: record.status === 'reserved' ? 'cancelled' : 'uncertain',
          code: 'SERVICE_RESTARTED', finishedAt: now() });
        changed = true;
      }
      if (changed) {
        await persist(recovered);
        emit({ event: 'ai_ledger_recovered', count: [...recovered.values()].filter(record => record.code === 'SERVICE_RESTARTED').length });
      }
    } catch (cause) {
      fatal = cause.code === 'AI_INSTANCE_LOCKED' ? cause : storageError();
      await release();
      throw fatal;
    }
  })();
  // The host may expose status before awaiting ready; suppress only the unhandled event.
  ready.catch(() => {});

  function run(operation) {
    if (closed || closing) return Promise.reject(error('AI_SERVICE_CLOSED', '生成服务正在重启，请稍后重试。'));
    const result = sequence.then(async () => {
      await ready;
      if (closed) throw error('AI_SERVICE_CLOSED', '生成服务正在重启，请稍后重试。');
      if (fatal) throw fatal;
      await verifyOwner();
      return operation();
    });
    sequence = result.catch(() => {});
    return result;
  }

  function validateReservation({ id, kind, fingerprint, model = '' } = {}) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id || '') || !['image', 'chat'].includes(kind)
      || typeof fingerprint !== 'string' || fingerprint.length < 1 || fingerprint.length > 256
      || typeof model !== 'string' || model.length > 200) throw error('INVALID_REQUEST_ID', '调用标识无效，请刷新页面后重试。', 400);
    return { id, kind, fingerprint, model };
  }

  async function reserveInputs(inputs) {
    const checked = inputs.map(validateReservation);
    if (new Set(checked.map(item => item.id)).size !== checked.length) throw error('INVALID_REQUEST_ID', '调用标识重复，请刷新页面后重试。', 400);
    const existing = checked.map(item => records.get(item.id));
    for (const [index, record] of existing.entries()) {
      const input = checked[index];
      if (record && (record.kind !== input.kind || record.fingerprint !== input.fingerprint || record.model !== input.model)) throw error('REQUEST_ID_CONFLICT', '该请求标识已经用于不同内容，请重新发起。', 409);
    }
    if (existing.every(Boolean)) return { created: false, records: existing.map(copy) };
    if (existing.some(Boolean)) throw error('REQUEST_ID_CONFLICT', '套图已有调用记录，请查询原任务。', 409);
    const timestamp = now(), day = dayAt(timestamp);
    const active = [...records.values()].filter(counted);
    for (const kind of ['image', 'chat']) {
      const requested = checked.filter(item => item.kind === kind).length;
      if (requested && active.filter(record => record.kind === kind && record.day === day).length + requested > effectiveLimits[`${kind}Daily`]) throw quotaError(kind);
    }
    if (active.filter(record => recentAttempt(record, timestamp)).length + checked.length > effectiveLimits.perMinute) throw rateError();
    const reserved = checked.map(input => ({ ...input, status: 'reserved', day, createdAt: timestamp }));
    const next = new Map(records);
    for (const record of reserved) next.set(record.id, record);
    await persist(next);
    return { created: true, records: reserved.map(copy) };
  }

  return {
    ready,
    reserve(input = {}) {
      return run(async () => {
        const reserved = await reserveInputs([input]);
        return { created: reserved.created, record: reserved.records[0] };
      });
    },
    reserveBatch(inputs) {
      return run(async () => {
        if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 4) throw error('INVALID_REQUEST_ID', '一次最多预留四张图片。', 400);
        return reserveInputs(inputs);
      });
    },
    markDispatched(id) {
      return run(async () => {
        const record = records.get(id);
        if (!record) throw error('REQUEST_NOT_FOUND', '调用记录不存在。', 404);
        if (record.status === 'dispatched') return copy(record);
        if (record.status !== 'reserved') throw error('REQUEST_ALREADY_FINISHED', '该请求已结束，不会重复调用。', 409);
        const timestamp = now();
        const day = dayAt(timestamp);
        const others = [...records.values()].filter(candidate => candidate.id !== id && counted(candidate));
        if (others.filter(candidate => candidate.kind === record.kind && candidate.day === day).length >= effectiveLimits[`${record.kind}Daily`]) {
          throw quotaError(record.kind);
        }
        if (others.filter(candidate => recentAttempt(candidate, timestamp)).length >= effectiveLimits.perMinute) throw rateError();
        const updated = { ...record, status: 'dispatched', dispatchedAt: timestamp, day };
        await persist(new Map(records).set(id, updated));
        return copy(updated);
      });
    },
    finish(id, details = {}) {
      return run(async () => {
        const record = records.get(id);
        if (!record) throw error('REQUEST_NOT_FOUND', '调用记录不存在。', 404);
        if (!TERMINAL.has(details.status)) throw error('INVALID_REQUEST_STATUS', '调用状态无效。', 400);
        if (TERMINAL.has(record.status)) return copy(record);
        if (record.status === 'reserved' && !['failed', 'cancelled'].includes(details.status)) {
          throw error('INVALID_REQUEST_STATUS', '请求尚未发送，不能记为生成完成。', 409);
        }
        const updated = { ...record, status: details.status, finishedAt: now() };
        if (/^[A-Z0-9_]{1,80}$/.test(details.code || '')) updated.code = details.code;
        const usage = safeUsage(details.usage);
        if (usage) updated.usage = usage;
        if (/^[A-Za-z0-9_.:-]{1,160}$/.test(details.providerRequestId || '')) updated.providerRequestId = details.providerRequestId;
        await persist(new Map(records).set(id, updated));
        return copy(updated);
      });
    },
    get(id) { return run(async () => copy(records.get(id) || null)); },
    summary() {
      return run(async () => {
        const day = dayAt(now());
        const today = [...records.values()].filter(record => record.day === day);
        const used = { image: 0, chat: 0 };
        for (const record of today) if (counted(record)) used[record.kind]++;
        return { day, timeZone: TIME_ZONE, limits: copy(effectiveLimits), used,
          remaining: { image: Math.max(0, effectiveLimits.imageDaily - used.image), chat: Math.max(0, effectiveLimits.chatDaily - used.chat) },
          recent: [...records.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map(safeRecord) };
      });
    },
    close() {
      if (closing) return closing;
      closing = (async () => { await sequence; await ready.catch(() => {}); closed = true; await release(); })();
      return closing;
    },
  };
}
