import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { createCreditsLedger, calculateCredits, INITIAL_POINTS, IMAGE_POINTS, VIDEO_POINTS, VIDEO_SECONDS, CreditsError } from '../services/credits/store.mjs';
import { parseAccountCreditsArguments, manageAccountCredits } from '../scripts/account-credits.mjs';

const failure = (code, status) => error => error instanceof CreditsError && error.code === code && error.status === status && error.statusCode === status;
const task = (taskId, units, kind = 'image', userId = 'account_alice') => ({ userId, taskId, units, kind });

async function local(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'qiya-credits-'));
  const ledgers = [];
  const open = () => {
    const ledger = createCreditsLedger({ databaseUrl: null, storageDir: root, ...options });
    ledgers.push(ledger); return ledger;
  };
  const ledger = open(); await ledger.ready;
  t.after(async () => {
    await Promise.all(ledgers.map(item => item.close().catch(() => {})));
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\') || resolve(root).startsWith(resolve(tmpdir()) + '/'));
    await rm(root, { recursive: true, force: true });
  });
  return { ledger, root, open, state: async () => JSON.parse(await readFile(join(root, 'wallets.json'), 'utf8')) };
}

test('credit rates use output images and actual seconds, including 3 × 30 seconds for 999 points', () => {
  assert.equal(INITIAL_POINTS, 1000); assert.equal(IMAGE_POINTS, 50);
  assert.equal(VIDEO_POINTS, 333); assert.equal(VIDEO_SECONDS, 30);
  assert.equal(calculateCredits('image', 20), 1000);
  assert.equal(calculateCredits('restaurant', 6), 300);
  for (const kind of ['video', 'mix', 'digital-human']) {
    assert.equal(calculateCredits(kind, 30), 333);
    assert.equal(calculateCredits(kind, 60), 666);
    assert.equal(calculateCredits(kind, 90), 999);
    assert.equal(calculateCredits(kind, 0), 0);
    assert.equal(calculateCredits(kind, 0.01), 1);
    assert.equal(calculateCredits(kind, 30.1), 335);
  }
});

test('invalid, nonfinite, unbounded or fractional image units are rejected', () => {
  for (const [kind, units] of [['image', -1], ['image', 1.5], ['image', '1'], ['image', Infinity],
    ['image', NaN], ['video', -1], ['video', 1_000_001], ['chat', 1], ['video', undefined], ['video', Number.MAX_VALUE]]) {
    assert.throws(() => calculateCredits(kind, units), failure('CREDITS_INVALID_ARGUMENT', 400));
  }
});

test('new and existing accounts each receive the welcome grant exactly once', async t => {
  const { ledger, state } = await local(t);
  const snapshots = await Promise.all(Array.from({ length: 30 }, () => ledger.snapshot('account_alice')));
  for (const snapshot of snapshots) {
    assert.deepEqual(snapshot, { initialPoints: 1000, balance: 1000, available: 1000, held: 0, total: 1000, unlimited: false,
      pricing: { imagePerUnit: 50, videoPoints: 333, videoSeconds: 30, initialPoints: 1000, version: '2026-10-08' } });
  }
  assert.equal((await state()).users.account_alice.ledger.filter(item => item.kind === 'welcome').length, 1);
  assert.equal((await ledger.snapshot('internal_012345abcdef')).balance, 1000);
});

test('concurrent image reservations cannot spend the same balance twice', async t => {
  const { ledger } = await local(t);
  const results = await Promise.allSettled(Array.from({ length: 25 }, (_, i) => ledger.reserve(task(`image_${i}`, 1))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 20);
  const rejections = results.filter(result => result.status === 'rejected');
  assert.equal(rejections.length, 5);
  for (const result of rejections) assert.ok(failure('INSUFFICIENT_POINTS', 402)(result.reason));
  assert.deepEqual(await ledger.snapshot('account_alice'), { initialPoints: 1000, balance: 0, available: 0, held: 1000, total: 1000, unlimited: false,
    pricing: { imagePerUnit: 50, videoPoints: 333, videoSeconds: 30, initialPoints: 1000, version: '2026-10-08' } });
});

test('same task is idempotent and cannot switch count, kind or recharge a released task', async t => {
  const { ledger, state } = await local(t);
  const first = await ledger.reserve(task('same_task', 6));
  assert.equal(first.reservedPoints, 300); assert.equal(first.wallet.available, 700);
  const repeated = await Promise.all(Array.from({ length: 10 }, () => ledger.reserve(task('same_task', 6))));
  assert.ok(repeated.every(value => value.status === 'reserved' && value.reservedPoints === 300));
  await assert.rejects(async () => ledger.reserve(task('same_task', 7)), failure('CREDITS_REQUEST_CONFLICT', 409));
  await assert.rejects(async () => ledger.reserve(task('same_task', 6, 'restaurant')), failure('CREDITS_REQUEST_CONFLICT', 409));
  await ledger.release(task('same_task', 6));
  assert.equal((await ledger.reserve(task('same_task', 6))).status, 'released');
  assert.equal((await ledger.snapshot('account_alice')).balance, 1000);
  assert.equal((await state()).users.account_alice.ledger.filter(item => item.kind === 'reserve').length, 1);
});

test('partial image completion refunds unused images and repeated settlement never charges twice', async t => {
  const { ledger, state } = await local(t);
  await ledger.reserve(task('partial_images', 15, 'restaurant'));
  const result = await ledger.settle(task('partial_images', 6));
  assert.equal(result.status, 'settled'); assert.equal(result.chargedPoints, 300);
  assert.equal(result.settledUnits, 6); assert.equal(result.wallet.balance, 700); assert.equal(result.wallet.held, 0);
  const repeated = await Promise.all(Array.from({ length: 10 }, () => ledger.settle(task('partial_images', 6))));
  assert.ok(repeated.every(value => value.chargedPoints === 300 && value.wallet.balance === 700));
  await assert.rejects(async () => ledger.settle(task('partial_images', 5)), failure('CREDITS_REQUEST_CONFLICT', 409));
  await assert.rejects(async () => ledger.release(task('partial_images', 6)), failure('CREDITS_REQUEST_CONFLICT', 409));
  assert.equal((await state()).users.account_alice.ledger.filter(item => item.kind === 'settle').length, 1);
});

test('zero successful units can be settled without charging any points', async t => {
  const { ledger } = await local(t);
  await ledger.reserve(task('zero_outputs', 10));
  const result = await ledger.settle(task('zero_outputs', 0));
  assert.equal(result.chargedPoints, 0); assert.equal(result.wallet.balance, 1000); assert.equal(result.wallet.held, 0);
});

test('released reservations refund once, remain terminal and survive repeated requests', async t => {
  const { ledger, state } = await local(t);
  await ledger.reserve(task('failed_video', 30, 'video'));
  const results = await Promise.all(Array.from({ length: 10 }, () => ledger.release(task('failed_video', 30))));
  assert.ok(results.every(value => value.status === 'released' && value.wallet.balance === 1000));
  assert.equal(await ledger.release(task('nonexistent', 1)), null);
  await assert.rejects(async () => ledger.settle(task('failed_video', 30)), failure('CREDITS_REQUEST_CONFLICT', 409));
  assert.equal((await state()).users.account_alice.ledger.filter(item => item.kind === 'release').length, 1);
});

test('actual duration exceeding the hold deducts only the extra balance atomically', async t => {
  const { ledger } = await local(t);
  await ledger.reserve(task('actual_60', 30, 'digital-human'));
  const settled = await ledger.settle(task('actual_60', 60));
  assert.equal(settled.chargedPoints, 666); assert.equal(settled.wallet.balance, 334); assert.equal(settled.wallet.held, 0);
});

test('insufficient extra settlement balance leaves the existing hold and wallet unchanged', async t => {
  const { ledger } = await local(t);
  await ledger.reserve(task('larger_video', 30, 'video'));
  await ledger.reserve(task('other_images', 10));
  const before = await ledger.snapshot('account_alice');
  await assert.rejects(async () => ledger.settle(task('larger_video', 60)), failure('INSUFFICIENT_POINTS', 402));
  assert.deepEqual(await ledger.snapshot('account_alice'), before);
  assert.equal((await ledger.reservation('account_alice', 'larger_video')).status, 'reserved');
});

test('account ownership isolates identical task IDs and prevents foreign settlement or refund', async t => {
  const { ledger } = await local(t);
  await ledger.reserve(task('shared_id', 6));
  assert.equal(await ledger.reservation('account_bob', 'shared_id'), null);
  await assert.rejects(async () => ledger.settle(task('shared_id', 6, 'image', 'account_bob')), failure('CREDITS_RESERVATION_NOT_FOUND', 404));
  assert.equal(await ledger.release(task('shared_id', 6, 'image', 'account_bob')), null);
  await ledger.reserve(task('shared_id', 1, 'image', 'account_bob'));
  await ledger.settle(task('shared_id', 1, 'image', 'account_bob'));
  assert.equal((await ledger.snapshot('account_alice')).held, 300);
  assert.equal((await ledger.snapshot('account_alice')).balance, 700);
  assert.equal((await ledger.snapshot('account_bob')).balance, 950);
});

test('wallet, holds, ledger and welcome-once survive reopening the local store', async t => {
  const { ledger, open, state } = await local(t);
  await ledger.reserve(task('paid_picture', 2)); await ledger.settle(task('paid_picture', 2));
  await ledger.reserve(task('pending_avatar', 30, 'digital-human'));
  await ledger.close();
  const reopened = open(); await reopened.ready;
  const snapshot = await reopened.snapshot('account_alice');
  assert.equal(snapshot.balance, 567); assert.equal(snapshot.held, 333); assert.equal(snapshot.total, 900);
  assert.equal((await reopened.reservation('account_alice', 'pending_avatar')).status, 'reserved');
  await reopened.settle(task('paid_picture', 2));
  assert.equal((await reopened.snapshot('account_alice')).total, 900);
  assert.equal((await state()).users.account_alice.ledger.filter(item => item.kind === 'welcome').length, 1);
});

test('a second local instance is refused instead of overselling another process wallet', async t => {
  const { ledger, open } = await local(t);
  await ledger.snapshot('account_alice');
  const second = open();
  await assert.rejects(second.ready, failure('CREDITS_INSTANCE_LOCKED', 503));
  await assert.rejects(second.snapshot('account_alice'), failure('CREDITS_INSTANCE_LOCKED', 503));
});

test('corrupt persisted balance fails closed without resetting the welcome grant', async t => {
  const { ledger, root, open } = await local(t);
  await ledger.snapshot('account_alice'); await ledger.close();
  await writeFile(join(root, 'wallets.json'), '{broken', 'utf8');
  const reopened = open();
  await assert.rejects(reopened.ready, failure('CREDITS_STORAGE_UNAVAILABLE', 503));
  await assert.rejects(reopened.snapshot('account_alice'), failure('CREDITS_STORAGE_UNAVAILABLE', 503));
  assert.equal(await readFile(join(root, 'wallets.json'), 'utf8'), '{broken');
});

test('production missing database fails closed without local or free fallback', async () => {
  const before = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  const ledger = createCreditsLedger({ databaseUrl: null });
  try {
    await assert.rejects(ledger.ready, failure('CREDITS_DATABASE_REQUIRED', 503));
    await assert.rejects(ledger.snapshot('account_alice'), failure('CREDITS_DATABASE_REQUIRED', 503));
  } finally { if (before === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = before; await ledger.close(); }
});

test('missing task IDs, invalid account identities and zero initial reservations are rejected', async t => {
  const { ledger } = await local(t);
  for (const action of [() => ledger.reserve(task(undefined, 1)), () => ledger.reserve(task('test', 0)),
    () => ledger.settle({ userId: 'account_alice', units: 1 }), () => ledger.release({ userId: 'account_alice' }),
    () => ledger.reservation('account_alice', undefined), () => ledger.snapshot('__proto__'),
    () => ledger.snapshot('bad user'), () => ledger.snapshot('../account_bob')]) {
    await assert.rejects(async () => action(), failure('CREDITS_INVALID_ARGUMENT', 400));
  }
});

test('extension freezes actual duration, repeated extensions are idempotent and reserve retains initial parameters', async t => {
  const { ledger, state } = await local(t);
  await ledger.reserve(task('extend_video', 20, 'digital-human'));
  const results = await Promise.all(Array.from({ length: 10 }, () => ledger.extendReservation(task('extend_video', 30))));
  assert.ok(results.every(result => result.reservedPoints === 333 && result.units === 20 && result.reservedUnits === 30));
  const unchanged = await ledger.extendReservation(task('extend_video', 25));
  assert.equal(unchanged.reservedPoints, 333); assert.equal(unchanged.reservedUnits, 30);
  assert.equal((await ledger.reserve(task('extend_video', 20, 'digital-human'))).reservedPoints, 333);
  await assert.rejects(async () => ledger.reserve(task('extend_video', 30, 'digital-human')), failure('CREDITS_REQUEST_CONFLICT', 409));
  assert.equal((await state()).users.account_alice.ledger.filter(item => item.kind === 'extend').length, 1);
  const result = await ledger.settle(task('extend_video', 30));
  assert.equal(result.wallet.balance, 667); assert.equal(result.wallet.held, 0);
  await assert.rejects(async () => ledger.extendReservation(task('extend_video', 60)), failure('CREDITS_REQUEST_CONFLICT', 409));
});

test('extension fails atomically when another task has occupied the additional balance', async t => {
  const { ledger } = await local(t);
  await ledger.reserve(task('actual_video', 20, 'digital-human'));
  await ledger.reserve(task('competing_images', 15));
  const before = await ledger.snapshot('account_alice');
  await assert.rejects(async () => ledger.extendReservation(task('actual_video', 30)), failure('INSUFFICIENT_POINTS', 402));
  assert.deepEqual(await ledger.snapshot('account_alice'), before);
  assert.equal((await ledger.reservation('account_alice', 'actual_video')).reservedPoints, 222);
});

test('three actual 30-second digital humans succeed even when the original estimate is longer', async t => {
  const { ledger } = await local(t);
  for (let i = 0; i < 3; i++) {
    const snapshot = await ledger.snapshot('account_alice');
    const holdPoints = Math.min(calculateCredits('digital-human', 40), snapshot.available);
    const heldSeconds = holdPoints * VIDEO_SECONDS / VIDEO_POINTS;
    await ledger.reserve(task(`digital_${i}`, heldSeconds, 'digital-human'));
    await ledger.extendReservation(task(`digital_${i}`, 30));
    await ledger.settle(task(`digital_${i}`, 30));
  }
  const snapshot = await ledger.snapshot('account_alice');
  assert.equal(snapshot.balance, 1); assert.equal(snapshot.held, 0);
  await assert.rejects(async () => ledger.reserve(task('digital_4', 30, 'digital-human')), failure('INSUFFICIENT_POINTS', 402));
});

/** A transactional SQL double verifies query contracts and rollback without touching any real account database. */
function transactionalPool() {
  let data = { wallets: new Map(), reservations: new Map(), events: [] }, queue = Promise.resolve();
  let failedEvent = null, failedConnect = false;
  const queries = [];
  function fail(message) { throw Object.assign(new Error(message), { code: 'TEST_DATABASE_FAILURE' }); }
  return {
    queries,
    state: () => structuredClone(data),
    failEvent: kind => { failedEvent = kind; },
    failConnect: () => { failedConnect = true; },
    async connect() {
      if (failedConnect) { failedConnect = false; fail('database unavailable'); }
      let transaction = null, unlock;
      return {
        release() { if (unlock) { unlock(); unlock = undefined; } },
        async query(query, args = []) {
          const sql = query.replace(/\s+/g, ' ').trim(); queries.push(sql);
          if (sql === 'BEGIN') {
            const prior = queue;
            queue = new Promise(resolve => { unlock = resolve; });
            await prior; transaction = structuredClone(data); return { rows: [], rowCount: 0 };
          }
          if (sql === 'COMMIT' || sql === 'ROLLBACK') {
            if (sql === 'COMMIT') data = transaction;
            transaction = null; unlock?.(); unlock = undefined; return { rows: [], rowCount: 0 };
          }
          assert.ok(transaction, 'all SQL operations must run within a transaction');
          if (sql.startsWith('CREATE SCHEMA ') || sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [], rowCount: 0 };
          if (sql.startsWith('INSERT INTO workspace_credits.wallets')) {
            const [id, points, at] = args;
            if (transaction.wallets.has(id)) return { rows: [], rowCount: 0 };
            transaction.wallets.set(id, { available: String(points), held: '0', created_at: String(at), updated_at: String(at) });
            return { rows: [{ user_id: id }], rowCount: 1 };
          }
          if (sql.startsWith('SELECT available,held,created_at,updated_at')) {
            assert.match(sql, /FOR UPDATE$/);
            const wallet = transaction.wallets.get(args[0]); return { rows: wallet ? [structuredClone(wallet)] : [], rowCount: wallet ? 1 : 0 };
          }
          if (sql.startsWith('SELECT * FROM workspace_credits.reservations')) {
            const reservation = transaction.reservations.get(args.join('\0'));
            return { rows: reservation ? [structuredClone(reservation)] : [], rowCount: reservation ? 1 : 0 };
          }
          if (sql.startsWith('UPDATE workspace_credits.wallets')) {
            const [id, available, held, at, unlimited] = args;
            const wallet = transaction.wallets.get(id); assert.ok(wallet);
            Object.assign(wallet, { available: String(available), held: String(held), updated_at: String(at), unlimited });
            return { rows: [], rowCount: 1 };
          }
          if (sql.startsWith('INSERT INTO workspace_credits.reservations')) {
            const [user_id, task_id, kind, units, reserved_units, reserved_points, charged_points, settled_units, status, created_at, updated_at, exempt] = args;
            const key = user_id + '\0' + task_id, previous = transaction.reservations.get(key);
            transaction.reservations.set(key, { user_id, task_id, kind: previous?.kind ?? kind, units: previous?.units ?? units,
              reserved_units, reserved_points: String(reserved_points), charged_points: String(charged_points), settled_units,
              status, created_at: String(previous?.created_at ?? created_at), updated_at: String(updated_at), exempt: previous?.exempt ?? exempt });
            return { rows: [], rowCount: 1 };
          }
          if (sql.startsWith('INSERT INTO workspace_credits.ledger')) {
            const [id, userId, taskId, eventKey, kind, availableDelta, heldDelta, availableAfter, heldAfter, createdAt] = args;
            if (kind === failedEvent) { failedEvent = null; fail('ledger insert unavailable'); }
            assert.ok(!transaction.events.some(item => item.userId === userId && item.eventKey === eventKey), 'ledger idempotency key must be unique');
            transaction.events.push({ id, userId, taskId, eventKey, kind, availableDelta, heldDelta, availableAfter, heldAfter, createdAt });
            return { rows: [], rowCount: 1 };
          }
          fail('unexpected SQL: ' + sql);
        },
      };
    },
  };
}

test('PostgreSQL transactions serialize reservations across independent ledger instances and grant once', async t => {
  const pool = transactionalPool();
  const a = createCreditsLedger({ pool }), b = createCreditsLedger({ pool });
  t.after(async () => { await a.close(); await b.close(); });
  await Promise.all([a.ready, b.ready]);
  const results = await Promise.allSettled(Array.from({ length: 24 }, (_, i) => (i % 2 ? a : b).reserve(task(`pg_${i}`, 1))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 20);
  assert.equal(results.filter(result => result.status === 'rejected').length, 4);
  assert.equal((await a.snapshot('account_alice')).available, 0); assert.equal((await b.snapshot('account_alice')).held, 1000);
  assert.equal(pool.state().events.filter(item => item.kind === 'welcome').length, 1);
  assert.ok(pool.queries.filter(query => /FROM workspace_credits.wallets .*FOR UPDATE$/.test(query)).length >= 24);
});

test('PostgreSQL rollback keeps wallet, reservation and ledger atomic after a write failure', async t => {
  const pool = transactionalPool(), ledger = createCreditsLedger({ pool });
  t.after(() => ledger.close()); await ledger.ready; await ledger.snapshot('account_alice');
  const before = pool.state(); pool.failEvent('reserve');
  await assert.rejects(ledger.reserve(task('pg_rollback', 6)), failure('CREDITS_STORAGE_UNAVAILABLE', 503));
  assert.deepEqual(pool.state(), before);
  assert.equal(await ledger.reservation('account_alice', 'pg_rollback'), null);
  await ledger.reserve(task('pg_rollback', 6));
  const beforeSettlement = pool.state(); pool.failEvent('settle');
  await assert.rejects(ledger.settle(task('pg_rollback', 3)), failure('CREDITS_STORAGE_UNAVAILABLE', 503));
  assert.deepEqual(pool.state(), beforeSettlement);
  assert.equal((await ledger.reservation('account_alice', 'pg_rollback')).status, 'reserved');
  const settled = await ledger.settle(task('pg_rollback', 3));
  assert.equal(settled.wallet.available, 850); assert.equal(settled.wallet.held, 0);
});

test('PostgreSQL reconnect never reissues the welcome grant and DB failure never provides free credit', async t => {
  const pool = transactionalPool(), a = createCreditsLedger({ pool });
  await a.ready; await a.reserve(task('pg_persist', 30, 'mix')); await a.settle(task('pg_persist', 30)); await a.close();
  const b = createCreditsLedger({ pool }); t.after(() => b.close()); await b.ready;
  assert.equal((await b.snapshot('account_alice')).available, 667);
  assert.equal(pool.state().events.filter(item => item.kind === 'welcome').length, 1);
  const before = pool.state(); pool.failConnect();
  await assert.rejects(b.reserve(task('unreachable', 1)), failure('CREDITS_STORAGE_UNAVAILABLE', 503));
  assert.deepEqual(pool.state(), before);
});

test('account unlimited permission and its audit event roll back together if the database write fails', async t => {
  const pool = transactionalPool(), ledger = createCreditsLedger({ pool });
  t.after(() => ledger.close()); await ledger.ready; await ledger.snapshot('account_alice');
  const before = pool.state(); pool.failEvent('unlimited_enabled');
  await assert.rejects(ledger.setUnlimited('account_alice', true), failure('CREDITS_STORAGE_UNAVAILABLE', 503));
  assert.deepEqual(pool.state(), before); assert.equal((await ledger.snapshot('account_alice')).unlimited, false);
  await ledger.setUnlimited('account_alice', true);
  assert.equal((await ledger.snapshot('account_alice')).unlimited, true);
});

test('PostgreSQL extension, competing reservations and replay preserve atomic balance across instances', async t => {
  const pool = transactionalPool(), a = createCreditsLedger({ pool }), b = createCreditsLedger({ pool });
  t.after(async () => { await a.close(); await b.close(); }); await Promise.all([a.ready, b.ready]);
  await a.reserve(task('pg_extended', 20, 'digital-human'));
  const race = await Promise.allSettled([a.extendReservation(task('pg_extended', 30)), b.reserve(task('pg_competing', 15))]);
  assert.equal(race.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(race.filter(value => value.status === 'rejected').length, 1);
  const snapshot = await a.snapshot('account_alice'); assert.ok(snapshot.available >= 0); assert.ok(snapshot.held <= 1000);
  const extension = await a.reservation('account_alice', 'pg_extended');
  if (extension.reservedPoints === 333) {
    await b.extendReservation(task('pg_extended', 30));
    assert.equal(pool.state().events.filter(item => item.kind === 'extend').length, 1);
  } else {
    await b.release(task('pg_competing', 15)); await a.extendReservation(task('pg_extended', 30));
  }
  await b.settle(task('pg_extended', 30)); await a.settle(task('pg_extended', 30));
  assert.equal((await a.snapshot('account_alice')).available, 667);
  assert.equal(pool.state().events.filter(item => item.kind === 'settle').length, 1);
});

// PGlite executes real PostgreSQL SQL on one connection. Serialize whole checked-out
// transactions; this verifies SQL/constraints/rollback, not production lock scheduling.
function pglitePool(database) {
  let queue = Promise.resolve(), loseCommitAck = false;
  return {
    loseNextCommitAck() { loseCommitAck = true; },
    async connect() {
      const previous = queue;
      let unlock;
      queue = new Promise(resolve => { unlock = resolve; });
      await previous;
      let released = false;
      return {
        release() { if (!released) { released = true; unlock(); } },
        async query(sql, args = []) {
          const result = !args.length && sql.includes(';') ? (await database.exec(sql)).at(-1) : await database.query(sql, args);
          if (sql === 'COMMIT' && loseCommitAck) {
            loseCommitAck = false;
            throw new Error('The commit persisted but its acknowledgement was lost');
          }
          return { ...result, rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
        },
      };
    },
  };
}

test('real PostgreSQL SQL persists welcome, holds, extensions, settlement and rollback across database reopen', async t => {
  const root = await mkdtemp(join(tmpdir(), 'qiya-credits-postgres-'));
  let pg, pool, a, b;
  async function open() {
    pg = new PGlite(join(root, 'postgres')); await pg.waitReady;
    pool = pglitePool(pg);
    a = createCreditsLedger({ pool }); b = createCreditsLedger({ pool });
    await Promise.all([a.ready, b.ready]);
  }
  async function close() { await a?.close(); await b?.close(); await pg?.close(); }
  t.after(async () => {
    await close();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\') || resolve(root).startsWith(resolve(tmpdir()) + '/'));
    await rm(root, { recursive: true, force: true });
  });
  await open();
  const snapshots = await Promise.all([a.snapshot('account_alice'), b.snapshot('account_alice')]);
  assert.ok(snapshots.every(item => item.available === 1000));
  await a.reserve(task('real_avatar', 20, 'digital-human'));
  await b.extendReservation(task('real_avatar', 30));
  await a.extendReservation(task('real_avatar', 30));
  const held = await b.reservation('account_alice', 'real_avatar');
  assert.equal(held.units, 20); assert.equal(held.reservedUnits, 30); assert.equal(held.reservedPoints, 333);
  await a.settle(task('real_avatar', 30)); await b.settle(task('real_avatar', 30));
  assert.equal((await a.snapshot('account_alice')).available, 667);
  await b.reserve(task('real_image', 4)); await a.settle(task('real_image', 2));
  assert.equal((await a.snapshot('account_alice')).available, 567);
  await a.reserve(task('real_failed', 6, 'restaurant')); await b.release(task('real_failed', 6)); await a.release(task('real_failed', 6));
  assert.equal((await b.snapshot('account_alice')).available, 567);
  await b.reserve(task('real_pending', 1));
  assert.equal((await a.snapshot('account_alice')).available, 517);
  assert.equal((await a.snapshot('account_alice')).held, 50);
  assert.equal(await b.reservation('account_bob', 'real_pending'), null);

  const welcome = await pg.query("SELECT user_id,count(*)::integer AS count FROM workspace_credits.ledger WHERE kind='welcome' GROUP BY user_id ORDER BY user_id");
  assert.deepEqual(welcome.rows, [{ user_id: 'account_alice', count: 1 }, { user_id: 'account_bob', count: 1 }]);
  const events = await pg.query("SELECT kind,count(*)::integer AS count FROM workspace_credits.ledger WHERE user_id=$1 GROUP BY kind ORDER BY kind", ['account_alice']);
  assert.deepEqual(events.rows, [{ kind: 'extend', count: 1 }, { kind: 'release', count: 1 }, { kind: 'reserve', count: 4 }, { kind: 'settle', count: 2 }, { kind: 'welcome', count: 1 }]);
  await assert.rejects(pg.query('INSERT INTO workspace_credits.wallets (user_id,available,held,created_at,updated_at) VALUES ($1,$2,$3,$4,$5)', ['bad_wallet', -1, 0, 0, 0]), { code: '23514' });
  const beforeTrigger = await a.snapshot('account_alice');
  await pg.exec(`CREATE FUNCTION workspace_credits.reject_test_settlement() RETURNS trigger AS $$
    BEGIN IF NEW.task_id='sql_rollback' AND NEW.kind='settle' THEN RAISE EXCEPTION 'test ledger failure'; END IF; RETURN NEW; END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER test_settlement_failure BEFORE INSERT ON workspace_credits.ledger
    FOR EACH ROW EXECUTE FUNCTION workspace_credits.reject_test_settlement();`);
  await a.reserve(task('sql_rollback', 2));
  await assert.rejects(a.settle(task('sql_rollback', 1)), failure('CREDITS_STORAGE_UNAVAILABLE', 503));
  const afterRollback = await b.snapshot('account_alice');
  assert.equal(afterRollback.available, beforeTrigger.available - 100);
  assert.equal(afterRollback.held, beforeTrigger.held + 100);
  assert.equal((await b.reservation('account_alice', 'sql_rollback')).status, 'reserved');
  assert.equal((await pg.query("SELECT count(*)::integer AS count FROM workspace_credits.ledger WHERE task_id='sql_rollback' AND kind='settle'")).rows[0].count, 0);
  await pg.exec('DROP TRIGGER test_settlement_failure ON workspace_credits.ledger; DROP FUNCTION workspace_credits.reject_test_settlement();');
  await b.release(task('sql_rollback', 2));

  await close(); await open();
  assert.equal((await a.snapshot('account_alice')).available, 517); assert.equal((await b.snapshot('account_alice')).held, 50);
  await b.settle(task('real_avatar', 30));
  assert.equal((await a.snapshot('account_alice')).available, 517);
  const retainedWelcome = await pg.query("SELECT count(*)::integer AS count FROM workspace_credits.ledger WHERE user_id=$1 AND kind='welcome'", ['account_alice']);
  assert.equal(retainedWelcome.rows[0].count, 1);
  await a.release(task('real_pending', 1)); assert.equal((await b.snapshot('account_alice')).available, 567);
});

test('a lost COMMIT acknowledgement can be queried and replayed without duplicate charge or grant in real SQL', async t => {
  const pg = new PGlite(); await pg.waitReady;
  const pool = pglitePool(pg), ledger = createCreditsLedger({ pool });
  t.after(async () => { await ledger.close(); await pg.close(); }); await ledger.ready;
  pool.loseNextCommitAck();
  await assert.rejects(ledger.snapshot('account_alice'), failure('CREDITS_STORAGE_UNAVAILABLE', 503));
  assert.equal((await ledger.snapshot('account_alice')).available, 1000);
  pool.loseNextCommitAck();
  await assert.rejects(ledger.reserve(task('uncertain_commit', 6)), failure('CREDITS_STORAGE_UNAVAILABLE', 503));
  assert.equal((await ledger.reservation('account_alice', 'uncertain_commit')).reservedPoints, 300);
  assert.equal((await ledger.reserve(task('uncertain_commit', 6))).wallet.available, 700);
  pool.loseNextCommitAck();
  await assert.rejects(ledger.settle(task('uncertain_commit', 3)), failure('CREDITS_STORAGE_UNAVAILABLE', 503));
  assert.equal((await ledger.reservation('account_alice', 'uncertain_commit')).status, 'settled');
  assert.equal((await ledger.settle(task('uncertain_commit', 3))).wallet.available, 850);
  await assert.rejects(ledger.release(task('uncertain_commit', 3)), failure('CREDITS_REQUEST_CONFLICT', 409));
  const counts = await pg.query('SELECT kind,count(*)::integer AS count FROM workspace_credits.ledger GROUP BY kind ORDER BY kind');
  assert.deepEqual(counts.rows, [{ kind: 'reserve', count: 1 }, { kind: 'settle', count: 1 }, { kind: 'welcome', count: 1 }]);
});

test('unlimited account with zero balance can reserve, extend and settle every creation kind without spending points', async t => {
  const { ledger, state } = await local(t);
  await ledger.reserve(task('spent_welcome', 20)); await ledger.settle(task('spent_welcome', 20));
  assert.equal((await ledger.setUnlimited('account_alice', true)).available, 0);
  for (const kind of ['image', 'restaurant', 'video', 'mix', 'digital-human']) {
    const argument = task(`unlimited_${kind}`, 200, kind);
    const reserved = await ledger.reserve(argument);
    assert.equal(reserved.exempt, true); assert.equal(reserved.reservedPoints, 0);
    const extended = await ledger.extendReservation({ ...argument, units: 400 });
    assert.equal(extended.reservedUnits, 400); assert.equal(extended.reservedPoints, 0);
    const settled = await ledger.settle({ ...argument, units: 450 });
    assert.equal(settled.status, 'settled'); assert.equal(settled.settledUnits, 450);
    assert.equal(settled.chargedPoints, 0); assert.equal(settled.wallet.available, 0); assert.equal(settled.wallet.held, 0);
    assert.deepEqual(await ledger.settle({ ...argument, units: 450 }), settled);
  }
  assert.equal((await ledger.snapshot('account_bob')).unlimited, false);
  await assert.rejects(ledger.reserve(task('ordinary_account', 200, 'image', 'account_bob')), failure('INSUFFICIENT_POINTS', 402));
  assert.equal((await state()).users.account_alice.ledger.filter(item => item.kind === 'unlimited_enabled').length, 1);
});

test('unlimited changes persist, audit once, and do not retroactively change pending task charges', async t => {
  const { ledger, open, state } = await local(t);
  await ledger.reserve(task('ordinary_pending', 2));
  await ledger.setUnlimited('account_alice', true); await ledger.setUnlimited('account_alice', true);
  await ledger.reserve(task('exempt_pending', 500));
  await ledger.close(); const reopened = open(); await reopened.ready;
  assert.equal((await reopened.snapshot('account_alice')).unlimited, true);
  assert.equal((await reopened.snapshot('account_alice')).held, 100);
  await reopened.setUnlimited('account_alice', false);
  assert.equal((await reopened.settle(task('exempt_pending', 500))).chargedPoints, 0);
  assert.equal((await reopened.settle(task('ordinary_pending', 2))).chargedPoints, 100);
  assert.equal((await reopened.snapshot('account_alice')).available, 900);
  await assert.rejects(reopened.reserve(task('new_limited', 100)), failure('INSUFFICIENT_POINTS', 402));
  await reopened.setUnlimited('account_alice', true); await reopened.setUnlimited('account_alice', false);
  const events = (await state()).users.account_alice.ledger;
  assert.equal(events.filter(item => item.kind === 'unlimited_enabled').length, 2);
  assert.equal(events.filter(item => item.kind === 'unlimited_disabled').length, 2);
  assert.equal(events.filter(item => item.kind === 'welcome').length, 1);
});

test('unlimited task failure releases once without minting points and request fields cannot grant unlimited status', async t => {
  const { ledger, state } = await local(t);
  await assert.rejects(ledger.reserve({ ...task('forged_exemption', 100), unlimited: true, exempt: true }), failure('INSUFFICIENT_POINTS', 402));
  for (const value of [1, 'true', null, undefined]) await assert.rejects(async () => ledger.setUnlimited('account_alice', value), failure('CREDITS_INVALID_ARGUMENT', 400));
  await ledger.setUnlimited('account_alice', true);
  await ledger.reserve(task('free_failure', 300));
  await ledger.release(task('free_failure', 300)); await ledger.release(task('free_failure', 300));
  assert.equal((await ledger.snapshot('account_alice')).available, 1000);
  assert.equal((await ledger.snapshot('account_alice')).held, 0);
  assert.equal((await state()).users.account_alice.ledger.filter(item => item.kind === 'release').length, 1);
  await assert.rejects(ledger.settle(task('free_failure', 300)), failure('CREDITS_REQUEST_CONFLICT', 409));
});

test('real SQL migrates old wallets and reservations and persists account exemptions across connections', async t => {
  const pg = new PGlite(); await pg.waitReady;
  const pool = pglitePool(pg); let ledger = createCreditsLedger({ pool });
  t.after(async () => { await ledger.close(); await pg.close(); }); await ledger.ready;
  await ledger.reserve(task('legacy_hold', 20)); await ledger.close();
  await pg.exec('ALTER TABLE workspace_credits.wallets DROP COLUMN unlimited; ALTER TABLE workspace_credits.reservations DROP COLUMN exempt;');
  ledger = createCreditsLedger({ pool }); await ledger.ready;
  assert.equal((await ledger.snapshot('account_alice')).unlimited, false);
  assert.equal((await ledger.reservation('account_alice', 'legacy_hold')).exempt, false);
  const operations = await Promise.all(Array.from({ length: 10 }, () => ledger.setUnlimited('account_alice', true)));
  assert.ok(operations.every(result => result.unlimited && result.available === 0 && result.held === 1000));
  await ledger.reserve(task('sql_free', 500, 'digital-human'));
  await ledger.extendReservation(task('sql_free', 900, 'digital-human'));
  pool.loseNextCommitAck();
  await assert.rejects(ledger.settle(task('sql_free', 900, 'digital-human')), failure('CREDITS_STORAGE_UNAVAILABLE', 503));
  assert.equal((await ledger.settle(task('sql_free', 900, 'digital-human'))).chargedPoints, 0);
  await ledger.close(); ledger = createCreditsLedger({ pool }); await ledger.ready;
  assert.equal((await ledger.snapshot('account_alice')).unlimited, true);
  assert.equal((await ledger.reservation('account_alice', 'sql_free')).exempt, true);
  assert.equal((await pg.query("SELECT count(*)::integer AS count FROM workspace_credits.ledger WHERE kind='unlimited_enabled'")).rows[0].count, 1);
  assert.equal((await pg.query("SELECT count(*)::integer AS count FROM workspace_credits.ledger WHERE task_id='sql_free' AND kind='settle'")).rows[0].count, 1);
  assert.equal((await ledger.snapshot('account_bob')).unlimited, false);
});

test('admin command resolves exact registered account ID and never creates a wallet for a mistyped name', async t => {
  const { ledger } = await local(t);
  assert.deepEqual(parseAccountCreditsArguments(['unlimited', '--account', 'ZXC9911']), { command: 'unlimited', account: 'zxc9911' });
  for (const argv of [[], ['unlimited'], ['unlimited', '--account', 'bad user'], ['unlimited', '--id', 'account_1'], ['unlimited', '--account', 'zxc9911', 'extra']]) assert.throws(() => parseAccountCreditsArguments(argv));
  const queries = [];
  const client = { async query(sql, values) { queries.push({ sql, values }); return { rows: values[0] === 'zxc9911' ? [{ id: 'account_verified', email: 'zxc9911' }] : [] }; } };
  const result = await manageAccountCredits(parseAccountCreditsArguments(['unlimited', '--account', 'zxc9911']), { client, ledger });
  assert.equal(result.userId, 'account_verified'); assert.equal(result.credits.unlimited, true);
  assert.equal((await ledger.snapshot('zxc9911')).unlimited, false);
  assert.ok(queries.every(query => query.sql.includes('WHERE email=$1') && query.values.length === 1));
  await assert.rejects(manageAccountCredits({ command: 'unlimited', account: 'typo' }, { client, ledger }), /没有找到唯一/);
  assert.equal((await manageAccountCredits({ command: 'limited', account: 'zxc9911' }, { client, ledger })).credits.unlimited, false);
});
