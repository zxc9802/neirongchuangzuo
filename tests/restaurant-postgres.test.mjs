import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGlite } from '@electric-sql/pglite';
import { createRestaurantStore, FILES_TTL_MS, TASK_TTL_MS } from '../services/restaurant/store.mjs';

// This runs real PostgreSQL SQL and rollback semantics locally. PGlite has one connection,
// so do not run concurrent BEGIN statements or pretend this tests pg advisory/session locks.
const adapter = pg => ({ query: (...args) => pg.query(...args),
  async connect() { return { query: (...args) => pg.query(...args), release() {} }; } });

test('PostgreSQL storage persists account data, transactions, quota idempotency and retention across restarts', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'restaurant-postgres-'));
  let time = Date.UTC(2026, 9, 7, 5);
  let pg, store;
  async function reopen() {
    pg = new PGlite(join(dataDir, 'postgres')); await pg.waitReady;
    store = createRestaurantStore({ dataDir, databaseUrl: '', pool: adapter(pg), acquireDatabaseLock: false, now: () => time, packageDailyLimit: 1 });
    await store.ready;
  }
  async function shutdown() { await store?.close(); await pg?.close(); }
  t.after(async () => { await shutdown(); await rm(dataDir, { recursive: true, force: true }); });
  await reopen();
  assert.equal(store.mode, 'postgres');

  await store.saveProfile('alice', { name: '刘顺兴面馆', city: '武汉', address: '验收真实地址', category: '面食' });
  assert.equal((await store.getProfile('alice')).name, '刘顺兴面馆');
  assert.equal(await store.getProfile('bob'), null);
  await store.createTask('alice', { id: 'package_one', status: 'awaiting_selection', copy: { body: '真实文字' },
    files: [{ key: 'alice/package_one/01.jpg', expiresAt: time + FILES_TTL_MS }] });
  assert.equal(await store.getTask('bob', 'package_one'), null);
  assert.deepEqual(await store.listTasks('bob'), []);
  assert.equal((await store.createTask('alice', { id: 'package_one', status: 'failed' })).status, 'awaiting_selection');
  assert.ok(await store.claimTask('alice', 'package_one', ['awaiting_selection'], { status: 'generating' }));
  assert.equal(await store.claimTask('alice', 'package_one', ['awaiting_selection'], { status: 'generating' }), null);
  await store.reservePackage('alice', 'package_one');
  assert.equal((await store.reservePackage('alice', 'package_one')).duplicate, true);
  await store.completeTask('alice', 'package_one', { review: { status: 'passed' }, copy: { body: '成功发布文案' } });
  await store.completeTask('alice', 'package_one', { copy: { body: '重复提交不覆盖' } });
  assert.equal((await store.getTask('alice', 'package_one')).copy.body, '成功发布文案');
  assert.equal((await store.usage('alice')).used, 1);

  await store.createTask('alice', { id: 'over_quota', status: 'awaiting_selection' });
  await assert.rejects(store.reservePackage('alice', 'over_quota'), { code: 'package_limit' });
  const records = await pg.query("SELECT state #>> '{ledger,package_one,status}' AS charge, state #>> '{tasks,package_one,status}' AS task_status FROM restaurant_workspaces WHERE user_id=$1", ['alice']);
  assert.equal(records.rows[0].charge, 'completed'); assert.equal(records.rows[0].task_status, 'completed');
  assert.equal((await store.usage('alice')).reserved, 0, 'failed reserve rolls back instead of leaving a reservation');

  await shutdown(); await reopen();
  assert.equal((await store.getProfile('alice')).city, '武汉');
  assert.equal((await store.usage('alice')).used, 1);
  assert.equal((await store.getTask('alice', 'package_one')).status, 'completed');
  await store.completeTask('alice', 'package_one');
  assert.equal((await store.usage('alice')).used, 1, 'completed task still charges only once after restart');

  await store.createTask('bob', { id: 'interrupted', status: 'generating' });
  await store.reservePackage('bob', 'interrupted');
  await shutdown(); await reopen();
  const interrupted = await store.getTask('bob', 'interrupted');
  assert.equal(interrupted.status, 'failed'); assert.equal(interrupted.retryable, false);
  assert.equal(interrupted.code, 'SERVICE_RESTARTED'); assert.equal(typeof interrupted.error, 'string');
  assert.equal((await store.usage('bob')).used, 0);
  assert.equal((await store.usage('bob')).reserved, 0);
  await store.createTask('bob', { id: 'after_restart', status: 'awaiting_selection' });
  await store.reservePackage('bob', 'after_restart');
  await store.releasePackage('bob', 'after_restart');
  assert.equal((await store.usage('bob')).remaining, 1);

  await store.createTask('bob', { id: 'midnight_pending', status: 'awaiting_confirmation',
    files: [{ key: 'bob/midnight_pending/01.jpg', expiresAt: time + FILES_TTL_MS }] });
  await store.reservePackage('bob', 'midnight_pending');
  time += 12 * 3600000;
  assert.equal((await store.usage('bob')).day, '2026-10-08');
  assert.equal((await store.usage('bob')).remaining, 0, 'yesterday pending delivery reserves today capacity');
  await store.completeTask('bob', 'midnight_pending');
  assert.equal((await store.usage('bob')).used, 1);
  const crossDay = await pg.query("SELECT state #>> '{ledger,midnight_pending,day}' AS charge_day FROM restaurant_workspaces WHERE user_id=$1", ['bob']);
  assert.equal(crossDay.rows[0].charge_day, '2026-10-08');

  time += FILES_TTL_MS + 1;
  const expired = await store.sweep();
  assert.equal(expired.expiredFiles.length, 2);
  await store.acknowledgeFiles('bob', ['bob/midnight_pending/01.jpg']);
  assert.equal((await store.getTask('alice', 'package_one')).files[0].expired, true);
  assert.equal((await store.getTask('alice', 'package_one')).copy.body, '成功发布文案');
  time += TASK_TTL_MS;
  const removed = await store.sweep();
  assert.ok(removed.expiredTaskIds.some(item => item.taskId === 'package_one'));
  assert.equal(await store.getTask('alice', 'package_one'), null);
  assert.equal(removed.expiredFiles.length, 1, 'failed COS deletion stays in persistent cleanup queue after task text expiry');
  await store.acknowledgeFiles('alice', ['alice/package_one/01.jpg']);
  assert.equal((await store.sweep()).expiredFiles.length, 0);
  const retained = await pg.query("SELECT state #>> '{ledger,package_one,status}' AS charge FROM restaurant_workspaces WHERE user_id=$1", ['alice']);
  assert.equal(retained.rows[0].charge, 'completed');
  assert.equal((await store.getProfile('alice')).name, '刘顺兴面馆');
  await assert.rejects(store.createTask('alice', { id: 'package_one' }), { code: 'task_expired' });
});
