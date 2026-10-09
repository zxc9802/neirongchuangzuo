import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

export const INITIAL_POINTS = 1000;
export const IMAGE_POINTS = 50;
export const VIDEO_POINTS = 333;
export const VIDEO_SECONDS = 30;
const VERSION = '2026-10-08';
const MAX_UNITS = 1_000_000;
const MAX_POINTS = Number.MAX_SAFE_INTEGER;
const KINDS = new Set(['image', 'restaurant', 'video', 'mix', 'digital-human']);
const PRICING = Object.freeze({ imagePerUnit: IMAGE_POINTS, videoPoints: VIDEO_POINTS,
  videoSeconds: VIDEO_SECONDS, initialPoints: INITIAL_POINTS, version: VERSION });
const clone = value => value == null ? value : structuredClone(value);

export class CreditsError extends Error {
  constructor(message, status = 400, code = 'CREDITS_INVALID_ARGUMENT') {
    super(message);
    this.name = 'CreditsError';
    this.status = status;
    this.statusCode = status;
    this.code = code;
  }
}

function identifier(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_:@.-]{1,200}$/.test(value)
    || ['__proto__', 'prototype', 'constructor'].includes(value)) {
    throw new CreditsError(`${label}无效。`);
  }
  return value;
}

export function calculateCredits(kind, units) {
  if (!KINDS.has(kind) || typeof units !== 'number' || !Number.isFinite(units)
    || units < 0 || units > MAX_UNITS || (['image', 'restaurant'].includes(kind) && !Number.isSafeInteger(units))) {
    throw new CreditsError('积分计费单位无效。');
  }
  const points = ['image', 'restaurant'].includes(kind) ? units * IMAGE_POINTS : Math.ceil(units * VIDEO_POINTS / VIDEO_SECONDS);
  if (!Number.isSafeInteger(points) || points < 0 || points > MAX_POINTS) throw new CreditsError('积分计费金额无效。');
  return points;
}

const unavailable = () => new CreditsError('积分服务暂时不可用，已暂停生成，请稍后重试。', 503, 'CREDITS_STORAGE_UNAVAILABLE');
const insufficient = () => new CreditsError('积分余额不足，请减少生成数量或缩短视频后重试。', 402, 'INSUFFICIENT_POINTS');
const conflict = message => new CreditsError(message, 409, 'CREDITS_REQUEST_CONFLICT');

function walletSnapshot(wallet) {
  return { initialPoints: INITIAL_POINTS, balance: wallet.available, available: wallet.available,
    held: wallet.held, total: wallet.available + wallet.held, unlimited: wallet.unlimited === true, pricing: { ...PRICING } };
}

function publicReservation(record, wallet) {
  return record ? { ...clone(record), ...(wallet ? { wallet: walletSnapshot(wallet) } : {}) } : null;
}

function validateWallet(wallet) {
  if (!wallet || (wallet.unlimited !== undefined && typeof wallet.unlimited !== 'boolean')
    || !Number.isSafeInteger(wallet.available) || wallet.available < 0
    || !Number.isSafeInteger(wallet.held) || wallet.held < 0
    || !Number.isSafeInteger(wallet.available + wallet.held)
    || !Number.isSafeInteger(wallet.createdAt) || !Number.isSafeInteger(wallet.updatedAt)) throw unavailable();
}

function validateRecord(record, userId, taskId) {
  if (!record || record.userId !== userId || record.taskId !== taskId || !KINDS.has(record.kind)
    || (record.exempt !== undefined && typeof record.exempt !== 'boolean')
    || !['reserved', 'settled', 'released'].includes(record.status)
    || !Number.isSafeInteger(record.reservedPoints) || record.reservedPoints < 0
    || !Number.isSafeInteger(record.chargedPoints) || record.chargedPoints < 0
    || !Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.updatedAt)) throw unavailable();
  try {
    calculateCredits(record.kind, record.units);
    const reservedCost = calculateCredits(record.kind, record.reservedUnits);
    const settledCost = record.status === 'settled' ? calculateCredits(record.kind, record.settledUnits) : 0;
    if (record.units <= 0 || (record.exempt === true ? 0 : reservedCost) !== record.reservedPoints
      || record.reservedUnits < record.units
      || (record.status === 'settled' && (record.exempt === true ? 0 : settledCost) !== record.chargedPoints)
      || (record.status !== 'settled' && record.chargedPoints !== 0)) throw unavailable();
  } catch { throw unavailable(); }
}

async function safeDirectory(path) {
  const root = resolve(path);
  if (root === parse(root).root) throw unavailable();
  let cursor = root;
  while (cursor !== parse(cursor).root) {
    try { const stat = await lstat(cursor); if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    cursor = dirname(cursor);
  }
  await mkdir(root, { recursive: true });
}

async function safeFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 128 * 1024 * 1024) throw unavailable();
}

const SCHEMA = `
  CREATE SCHEMA IF NOT EXISTS workspace_credits;
  CREATE TABLE IF NOT EXISTS workspace_credits.wallets (
    user_id TEXT PRIMARY KEY, available BIGINT NOT NULL CHECK (available >= 0),
    held BIGINT NOT NULL CHECK (held >= 0), created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workspace_credits.reservations (
    user_id TEXT NOT NULL REFERENCES workspace_credits.wallets(user_id), task_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('image','restaurant','video','mix','digital-human')),
    units DOUBLE PRECISION NOT NULL, reserved_units DOUBLE PRECISION NOT NULL,
    reserved_points BIGINT NOT NULL CHECK (reserved_points >= 0), charged_points BIGINT NOT NULL CHECK (charged_points >= 0),
    settled_units DOUBLE PRECISION, status TEXT NOT NULL CHECK (status IN ('reserved','settled','released')),
    created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, PRIMARY KEY (user_id,task_id)
  );
  CREATE TABLE IF NOT EXISTS workspace_credits.ledger (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES workspace_credits.wallets(user_id), task_id TEXT,
    event_key TEXT NOT NULL, kind TEXT NOT NULL, available_delta BIGINT NOT NULL, held_delta BIGINT NOT NULL,
    available_after BIGINT NOT NULL CHECK (available_after >= 0), held_after BIGINT NOT NULL CHECK (held_after >= 0),
    created_at BIGINT NOT NULL, UNIQUE (user_id,event_key)
  );
  CREATE INDEX IF NOT EXISTS credits_ledger_user_created ON workspace_credits.ledger(user_id,created_at);
  ALTER TABLE workspace_credits.wallets ADD COLUMN IF NOT EXISTS unlimited BOOLEAN NOT NULL DEFAULT FALSE;
  ALTER TABLE workspace_credits.reservations ADD COLUMN IF NOT EXISTS exempt BOOLEAN NOT NULL DEFAULT FALSE;
`;

function rowRecord(row) {
  if (!row) return null;
  return { userId: row.user_id, taskId: row.task_id, kind: row.kind, units: Number(row.units),
    reservedUnits: Number(row.reserved_units), reservedPoints: Number(row.reserved_points), chargedPoints: Number(row.charged_points),
    settledUnits: row.settled_units == null ? null : Number(row.settled_units), status: row.status,
    exempt: row.exempt === true,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}

/** Account identities must come from the verified session; this module has no public mutation endpoint. */
export function createCreditsLedger({ databaseUrl = process.env.AUTH_DATABASE_URL, storageDir = '.data/credits', pool: injectedPool, now = Date.now } = {}) {
  const root = resolve(storageDir), file = join(root, 'wallets.json'), lock = join(root, '.credits-lock');
  const token = randomUUID();
  let pool, ownsPool = false, ownsLock = false, closed = false, closing, fatal;
  let local = { version: 1, users: {} };
  let sequence = Promise.resolve();

  function timestamp() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw unavailable();
    return value;
  }
  function event(userId, taskId, kind, availableDelta, heldDelta, wallet, at, suffix = kind) {
    return { id: randomUUID(), userId, taskId, eventKey: taskId == null ? (kind === 'welcome' ? 'welcome' : JSON.stringify([kind, suffix])) : JSON.stringify([taskId, suffix]),
      kind, availableDelta, heldDelta, availableAfter: wallet.available, heldAfter: wallet.held, createdAt: at };
  }
  async function writeEvent(client, item) {
    await client.query(`INSERT INTO workspace_credits.ledger
      (id,user_id,task_id,event_key,kind,available_delta,held_delta,available_after,held_after,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [item.id, item.userId, item.taskId, item.eventKey, item.kind, item.availableDelta, item.heldDelta,
      item.availableAfter, item.heldAfter, item.createdAt]);
  }
  async function acquireLocalLock() {
    await safeDirectory(root);
    const writeLock = async () => {
      const handle = await open(lock, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ token, pid: process.pid, hostname: hostname() })); await handle.sync(); ownsLock = true; }
      finally { await handle.close(); }
    };
    try { await writeLock(); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await safeFile(lock);
      const previous = JSON.parse(await readFile(lock, 'utf8'));
      if (previous.hostname !== hostname() || !Number.isSafeInteger(previous.pid) || previous.pid <= 0 || typeof previous.token !== 'string') throw unavailable();
      let absent = false;
      try { process.kill(previous.pid, 0); } catch (cause) { absent = cause.code === 'ESRCH'; }
      if (!absent) throw new CreditsError('积分存储已有实例运行，请勿同时启动第二个本地实例。', 503, 'CREDITS_INSTANCE_LOCKED');
      let takeover;
      const guardPath = join(root, '.credits-takeover');
      try {
        takeover = await open(guardPath, 'wx', 0o600);
        await safeFile(lock);
        const current = JSON.parse(await readFile(lock, 'utf8'));
        if (current.token !== previous.token) throw unavailable();
        await unlink(lock);
        await writeLock();
      } finally { await takeover?.close(); if (takeover) await unlink(guardPath).catch(() => {}); }
    }
  }
  async function releaseLocalLock() {
    if (!ownsLock) return;
    try {
      await safeFile(lock);
      if (JSON.parse(await readFile(lock, 'utf8')).token === token) await unlink(lock);
    } finally { ownsLock = false; }
  }
  async function saveLocal(next) {
    await safeDirectory(root);
    await safeFile(lock);
    if (JSON.parse(await readFile(lock, 'utf8')).token !== token) throw unavailable();
    try { await safeFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = join(root, `.wallets-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(next)); await handle.sync(); await handle.close(); handle = undefined;
      await rename(temporary, file); local = next;
    } finally { await handle?.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
  }
  function validateLocalState(state) {
    if (state?.version !== 1 || !state.users || typeof state.users !== 'object' || Array.isArray(state.users)) throw unavailable();
    for (const [userId, entry] of Object.entries(state.users)) {
      identifier(userId, '账号'); validateWallet(entry.wallet);
      if (!entry.reservations || typeof entry.reservations !== 'object' || Array.isArray(entry.reservations) || !Array.isArray(entry.ledger)) throw unavailable();
      let held = 0;
      for (const [taskId, record] of Object.entries(entry.reservations)) {
        identifier(taskId, '任务'); validateRecord(record, userId, taskId);
        if (record.status === 'reserved') held += record.reservedPoints;
      }
      if (held !== entry.wallet.held) throw unavailable();
      let available = 0, ledgerHeld = 0;
      const keys = new Set();
      for (const item of entry.ledger) {
        if (item?.userId !== userId || typeof item.eventKey !== 'string' || keys.has(item.eventKey)
          || !Number.isSafeInteger(item.availableDelta) || !Number.isSafeInteger(item.heldDelta)) throw unavailable();
        keys.add(item.eventKey); available += item.availableDelta; ledgerHeld += item.heldDelta;
        if (available < 0 || ledgerHeld < 0 || available !== item.availableAfter || ledgerHeld !== item.heldAfter) throw unavailable();
      }
      if (!keys.has('welcome') || available !== entry.wallet.available || ledgerHeld !== entry.wallet.held) throw unavailable();
    }
  }
  const ready = (async () => {
    try {
      if (databaseUrl || injectedPool) {
        if (injectedPool) pool = injectedPool;
        else {
          const { default: pg } = await import('pg');
          pool = new pg.Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, allowExitOnIdle: true });
          ownsPool = true;
          pool.on('error', () => { /* The next operation still must receive a successful transaction. */ });
        }
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query("SELECT pg_advisory_xact_lock(hashtext('workspace.credits.schema.v1'))");
          await client.query(SCHEMA); await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
        finally { client.release(); }
      } else {
        if (process.env.NODE_ENV === 'production') throw new CreditsError('生产环境必须配置账号数据库才能使用积分。', 503, 'CREDITS_DATABASE_REQUIRED');
        await acquireLocalLock();
        try {
          await safeFile(file);
          const state = JSON.parse(await readFile(file, 'utf8')); validateLocalState(state); local = state;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    } catch (error) {
      await releaseLocalLock().catch(() => {});
      if (ownsPool) await pool?.end().catch(() => {});
      fatal = error instanceof CreditsError ? error : unavailable(); throw fatal;
    }
  })();
  ready.catch(() => {});

  async function operate(userId, taskId, action) {
    if (!pool) {
      const next = clone(local), at = timestamp();
      let entry = next.users[userId];
      if (!entry) {
        const wallet = { available: INITIAL_POINTS, held: 0, createdAt: at, updatedAt: at };
        entry = { wallet, reservations: {}, ledger: [event(userId, null, 'welcome', INITIAL_POINTS, 0, wallet, at)] };
        next.users[userId] = entry;
      }
      const before = JSON.stringify(entry);
      const state = { wallet: entry.wallet, record: taskId == null ? null : entry.reservations[taskId] ?? null, events: [], at };
      const result = action(state);
      validateWallet(state.wallet);
      if (state.record) { validateRecord(state.record, userId, taskId); entry.reservations[taskId] = state.record; }
      entry.ledger.push(...state.events);
      if (!local.users[userId] || JSON.stringify(entry) !== before) {
        try { await saveLocal(next); } catch { fatal = unavailable(); throw fatal; }
      }
      return clone(result);
    }
    let client;
    try {
      client = await pool.connect(); await client.query('BEGIN');
      const at = timestamp();
      const inserted = await client.query(`INSERT INTO workspace_credits.wallets (user_id,available,held,created_at,updated_at)
        VALUES ($1,$2,0,$3,$3) ON CONFLICT (user_id) DO NOTHING RETURNING user_id`, [userId, INITIAL_POINTS, at]);
      const { rows: [row] } = await client.query('SELECT available,held,created_at,updated_at,unlimited FROM workspace_credits.wallets WHERE user_id=$1 FOR UPDATE', [userId]);
      const wallet = row && { available: Number(row.available), held: Number(row.held), unlimited: row.unlimited === true, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
      validateWallet(wallet);
      if (inserted.rowCount) await writeEvent(client, event(userId, null, 'welcome', INITIAL_POINTS, 0, wallet, at));
      const record = taskId == null ? null : rowRecord((await client.query('SELECT * FROM workspace_credits.reservations WHERE user_id=$1 AND task_id=$2', [userId, taskId])).rows[0]);
      if (record) validateRecord(record, userId, taskId);
      const beforeRecord = JSON.stringify(record), beforeWallet = JSON.stringify(wallet);
      const state = { wallet, record, events: [], at };
      const result = action(state); validateWallet(wallet);
      if (state.record) validateRecord(state.record, userId, taskId);
      if (JSON.stringify(wallet) !== beforeWallet) await client.query('UPDATE workspace_credits.wallets SET available=$2,held=$3,updated_at=$4,unlimited=$5 WHERE user_id=$1', [userId, wallet.available, wallet.held, wallet.updatedAt, wallet.unlimited === true]);
      if (JSON.stringify(state.record) !== beforeRecord) {
        const r = state.record;
        await client.query(`INSERT INTO workspace_credits.reservations
          (user_id,task_id,kind,units,reserved_units,reserved_points,charged_points,settled_units,status,created_at,updated_at,exempt)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT (user_id,task_id) DO UPDATE SET reserved_units=EXCLUDED.reserved_units,reserved_points=EXCLUDED.reserved_points,
          charged_points=EXCLUDED.charged_points,settled_units=EXCLUDED.settled_units,status=EXCLUDED.status,updated_at=EXCLUDED.updated_at`,
        [r.userId, r.taskId, r.kind, r.units, r.reservedUnits, r.reservedPoints, r.chargedPoints, r.settledUnits, r.status, r.createdAt, r.updatedAt, r.exempt === true]);
      }
      for (const item of state.events) await writeEvent(client, item);
      await client.query('COMMIT'); return clone(result);
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      throw error instanceof CreditsError ? error : unavailable();
    } finally { client?.release(); }
  }
  function run(userId, taskId, action) {
    identifier(userId, '账号'); if (taskId != null) identifier(taskId, '任务');
    const result = sequence.then(async () => {
      await ready;
      if (closed || fatal) throw fatal || new CreditsError('积分服务已关闭。', 503, 'CREDITS_CLOSED');
      return operate(userId, taskId, action);
    });
    sequence = result.catch(() => {}); return result;
  }
  function update(state, userId, taskId, kind, availableDelta, heldDelta, suffix) {
    state.wallet.available += availableDelta; state.wallet.held += heldDelta; state.wallet.updatedAt = state.at;
    if (state.record) state.record.updatedAt = state.at;
    validateWallet(state.wallet);
    state.events.push(event(userId, taskId, kind, availableDelta, heldDelta, state.wallet, state.at, suffix));
  }
  function requiredRecord(state) {
    if (!state.record) throw new CreditsError('没有找到该账号的积分预留记录。', 404, 'CREDITS_RESERVATION_NOT_FOUND');
    return state.record;
  }

  return {
    ready,
    mode: databaseUrl || injectedPool ? 'postgres' : 'local',
    snapshot(userId) { return run(userId, null, state => walletSnapshot(state.wallet)); },
    setUnlimited(userId, enabled) {
      if (typeof enabled !== 'boolean') throw new CreditsError('无限积分设置必须为布尔值。');
      return run(userId, null, state => {
        if ((state.wallet.unlimited === true) === enabled) return walletSnapshot(state.wallet);
        state.wallet.unlimited = enabled;
        update(state, userId, null, enabled ? 'unlimited_enabled' : 'unlimited_disabled', 0, 0, randomUUID());
        return walletSnapshot(state.wallet);
      });
    },
    reservation(userId, taskId) { identifier(taskId, '任务'); return run(userId, taskId, state => publicReservation(state.record, state.wallet)); },
    reserve({ userId, taskId, kind, units } = {}) {
      identifier(taskId, '任务');
      const points = calculateCredits(kind, units);
      if (units <= 0) throw new CreditsError('积分预留单位必须大于零。');
      return run(userId, taskId, state => {
        if (state.record) {
          if (state.record.kind !== kind || state.record.units !== units) throw conflict('同一任务不能重复提交不同的计费参数。');
          return publicReservation(state.record, state.wallet);
        }
        const exempt = state.wallet.unlimited === true;
        const reservedPoints = exempt ? 0 : points;
        if (state.wallet.available < reservedPoints) throw insufficient();
        state.record = { userId, taskId, kind, units, reservedUnits: units, reservedPoints, chargedPoints: 0, exempt,
          settledUnits: null, status: 'reserved', createdAt: state.at, updatedAt: state.at };
        update(state, userId, taskId, 'reserve', -reservedPoints, reservedPoints);
        return publicReservation(state.record, state.wallet);
      });
    },
    extendReservation({ userId, taskId, units } = {}) {
      identifier(taskId, '任务');
      return run(userId, taskId, state => {
        const record = requiredRecord(state), points = calculateCredits(record.kind, units);
        if (record.status !== 'reserved') throw conflict('该任务的积分预留已结束，不能追加冻结。');
        if (record.exempt === true) {
          if (units <= record.reservedUnits) return publicReservation(record, state.wallet);
          record.reservedUnits = units;
          update(state, userId, taskId, 'extend', 0, 0, `extend:${units}`);
          return publicReservation(record, state.wallet);
        }
        if (points <= record.reservedPoints) return publicReservation(record, state.wallet);
        const extra = points - record.reservedPoints;
        if (state.wallet.available < extra) throw insufficient();
        record.reservedPoints = points; record.reservedUnits = units;
        update(state, userId, taskId, 'extend', -extra, extra, `extend:${points}`);
        return publicReservation(record, state.wallet);
      });
    },
    settle({ userId, taskId, units } = {}) {
      identifier(taskId, '任务');
      return run(userId, taskId, state => {
        const record = requiredRecord(state), cost = calculateCredits(record.kind, units);
        const points = record.exempt === true ? 0 : cost;
        if (record.status === 'settled') {
          if (record.settledUnits !== units) throw conflict('该任务已经按其他实际用量结算。');
          return publicReservation(record, state.wallet);
        }
        if (record.status === 'released') throw conflict('该任务的积分预留已退回，不能再次结算。');
        const difference = record.reservedPoints - points;
        if (state.wallet.available + difference < 0) throw insufficient();
        record.status = 'settled'; record.settledUnits = units; record.chargedPoints = points;
        update(state, userId, taskId, 'settle', difference, -record.reservedPoints);
        return publicReservation(record, state.wallet);
      });
    },
    release({ userId, taskId } = {}) {
      identifier(taskId, '任务');
      return run(userId, taskId, state => {
        if (!state.record) return null;
        const record = state.record;
        if (record.status === 'settled') throw conflict('该任务已成功结算，不能重复退回积分。');
        if (record.status === 'released') return publicReservation(record, state.wallet);
        record.status = 'released';
        update(state, userId, taskId, 'release', record.reservedPoints, -record.reservedPoints);
        return publicReservation(record, state.wallet);
      });
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        await sequence.catch(() => {}); await ready.catch(() => {});
        await releaseLocalLock();
        if (ownsPool && !fatal) await pool?.end();
      })();
      return closing;
    },
  };
}
