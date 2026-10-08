import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRestaurantStore, FILES_TTL_MS, TASK_TTL_MS } from '../services/restaurant/store.mjs';
import { createRestaurantMedia } from '../services/restaurant/media.mjs';

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'restaurant-store-'));
  let time = Date.UTC(2026, 9, 7, 5);
  const stores = [];
  const make = () => { const store = createRestaurantStore({ dataDir, databaseUrl: '', now: () => time, ...options }); stores.push(store); return store; };
  const store = make(); await store.ready;
  t.after(async () => { for (const item of stores) await item.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, store, make, advance: value => { time += value; }, now: () => time };
}

test('profiles and tasks survive reopening and accounts cannot read each other', async t => {
  const f = await fixture(t);
  await f.store.saveProfile('alice', { name: '真实面馆', city: '武汉' });
  await f.store.createTask('alice', { id: 'one', status: 'awaiting_selection', copy: { body: '真实文案' } });
  assert.equal(await f.store.getProfile('bob'), null);
  assert.equal(await f.store.getTask('bob', 'one'), null);
  assert.deepEqual(await f.store.listTasks('bob'), []);
  await f.store.close();
  const reopened = f.make(); await reopened.ready;
  assert.equal((await reopened.getProfile('alice')).name, '真实面馆');
  assert.equal((await reopened.getTask('alice', 'one')).copy.body, '真实文案');
});

test('task claims serialize concurrent generation and creation is idempotent', async t => {
  const f = await fixture(t);
  await f.store.createTask('alice', { id: 'one', status: 'awaiting_selection', profileSnapshot: { name: '原始资料' } });
  const again = await f.store.createTask('alice', { id: 'one', status: 'generating', profileSnapshot: { name: '不应覆盖' } });
  assert.equal(again.profileSnapshot.name, '原始资料');
  const claimed = await Promise.all(Array.from({ length: 8 }, () => f.store.claimTask('alice', 'one', ['awaiting_selection'], { status: 'generating' })));
  assert.equal(claimed.filter(Boolean).length, 1);
  const edited = await f.store.patchTask('alice', 'one', { userId: 'bob', id: 'changed', createdAt: 0, copy: { body: '输出' } });
  assert.equal(edited.userId, 'alice'); assert.equal(edited.id, 'one'); assert.ok(edited.createdAt > 0);
});

test('successful packages charge once; reservations enforce quota and failed packages release it', async t => {
  const f = await fixture(t, { packageDailyLimit: 1 });
  await f.store.createTask('alice', { id: 'first', status: 'generating' });
  await f.store.createTask('alice', { id: 'second', status: 'awaiting_selection' });
  await f.store.reservePackage('alice', 'first');
  assert.equal((await f.store.reservePackage('alice', 'first')).duplicate, true);
  await assert.rejects(f.store.reservePackage('alice', 'second'), { code: 'package_limit', statusCode: 429 });
  await f.store.releasePackage('alice', 'first');
  assert.equal((await f.store.usage('alice')).remaining, 1);
  await f.store.reservePackage('alice', 'second');
  const result = await f.store.completeTask('alice', 'second', { copy: { body: '成功正文' } });
  assert.equal(result.status, 'completed');
  const duplicate = await f.store.completeTask('alice', 'second', { copy: { body: '重复覆盖' } });
  assert.equal(duplicate.copy.body, '成功正文');
  assert.deepEqual((await f.store.usage('alice')).used, 1);
  assert.equal((await f.store.usage('alice')).reserved, 0);
  await f.store.releasePackage('alice', 'second');
  assert.equal((await f.store.usage('alice')).used, 1);
});

test('quota charges the Beijing delivery day and pending packages span midnight', async t => {
  const f = await fixture(t, { packageDailyLimit: 1 });
  await f.store.createTask('alice', { id: 'late', status: 'generating' });
  await f.store.reservePackage('alice', 'late');
  assert.equal((await f.store.usage('alice')).day, '2026-10-07');
  f.advance(12 * 3600000);
  assert.equal((await f.store.usage('alice')).day, '2026-10-08');
  assert.equal((await f.store.usage('alice')).reserved, 1);
  assert.equal((await f.store.usage('alice')).remaining, 0);
  await f.store.createTask('alice', { id: 'today', status: 'awaiting_selection' });
  await assert.rejects(f.store.reservePackage('alice', 'today'), { code: 'package_limit' });
  await f.store.completeTask('alice', 'late');
  assert.equal((await f.store.usage('alice')).used, 1);
  assert.equal((await f.store.usage('alice')).reserved, 0);
});

test('unconfirmed expired result releases its reservation and cannot be delivered or charged', async t => {
  const f = await fixture(t, { packageDailyLimit: 1 });
  await f.store.createTask('alice', { id: 'unconfirmed', status: 'generating' });
  await f.store.reservePackage('alice', 'unconfirmed');
  await f.store.patchTask('alice', 'unconfirmed', { status: 'awaiting_confirmation', files: [{ key: 'alice/unconfirmed/01.jpg', expiresAt: f.now() + FILES_TTL_MS }] });
  f.advance(FILES_TTL_MS + 1);
  await assert.rejects(f.store.completeTask('alice', 'unconfirmed'), { code: 'FILES_EXPIRED', statusCode: 410 });
  await f.store.sweep();
  const task = await f.store.getTask('alice', 'unconfirmed');
  assert.equal(task.status, 'failed'); assert.equal(task.code, 'FILES_EXPIRED'); assert.equal(task.retryable, false);
  assert.equal((await f.store.usage('alice')).reserved, 0); assert.equal((await f.store.usage('alice')).used, 0);
  assert.equal((await f.store.usage('alice')).remaining, 1);
  await assert.rejects(f.store.completeTask('alice', 'unconfirmed'), { code: 'FILES_EXPIRED', statusCode: 410 });
});

test('restart fails interrupted work without repeating model calls or charging user quota', async t => {
  const f = await fixture(t);
  await f.store.createTask('alice', { id: 'interrupted', status: 'generating' });
  await f.store.createTask('alice', { id: 'uploading', status: 'uploading', sourceImages: [{ id: 'src1', key: 'alice/uploading/source.jpg', expiresAt: f.now() + FILES_TTL_MS }] });
  await f.store.createTask('alice', { id: 'selection', status: 'awaiting_selection' });
  await f.store.reservePackage('alice', 'interrupted');
  await f.store.close();
  const reopened = f.make(); await reopened.ready;
  const interrupted = await reopened.getTask('alice', 'interrupted');
  assert.equal(interrupted.status, 'failed'); assert.equal(typeof interrupted.error, 'string');
  assert.equal(interrupted.code, 'SERVICE_RESTARTED'); assert.equal(interrupted.retryable, false);
  assert.equal((await reopened.getTask('alice', 'uploading')).status, 'failed');
  assert.equal((await reopened.getTask('alice', 'selection')).status, 'awaiting_selection');
  assert.equal((await reopened.usage('alice')).used, 0);
  assert.equal((await reopened.usage('alice')).reserved, 0);
});

test('batch upload drafts and pending object intents survive restart and expire after three days', async t => {
  const f = await fixture(t), expiresAt = f.now() + FILES_TTL_MS;
  await f.store.createTask('alice', { id: 'draft', status: 'uploading', uploadProtocol: 'batches', imageCount: 6, uploadExpiresAt: expiresAt,
    sourceImages: [{ id: 'photo-1', key: 'alice/draft/original.jpg', expiresAt }], uploadBatches: [{ startIndex: 0, count: 1, fingerprint: 'acknowledged' }],
    pendingUpload: { startIndex: 1, fingerprint: 'pending', sourceImages: [{ id: 'photo-2', key: 'alice/draft/pending.jpg', expiresAt }] } });
  await f.store.close(); const reopened = f.make(); await reopened.ready;
  const task = await reopened.getTask('alice', 'draft');
  assert.equal(task.status, 'uploading'); assert.equal(task.sourceImages.length, 1); assert.equal(task.pendingUpload.startIndex, 1);
  f.advance(FILES_TTL_MS + 1);
  const expired = await reopened.sweep();
  assert.equal(expired.expiredFiles.length, 2); assert.deepEqual(new Set(expired.expiredFiles.map(file => file.key)), new Set(['alice/draft/original.jpg', 'alice/draft/pending.jpg']));
  assert.equal((await reopened.getTask('alice', 'draft')).code, 'FILES_EXPIRED'); assert.equal((await reopened.usage('alice')).used, 0);
});

test('files expire after three days while text lasts thirty; failed deletion remains retryable after task expiry', async t => {
  const f = await fixture(t);
  const expiresAt = f.now() + FILES_TTL_MS;
  await f.store.saveProfile('alice', { name: '长期资料' });
  await f.store.createTask('alice', { id: 'one', status: 'awaiting_selection', files: [{ key: 'alice/one/01.jpg', expiresAt }],
    sourceImages: [{ id: 'src1', key: 'alice/one/source.jpg', expiresAt }], copy: { body: '三十天文字' } });
  await f.store.reservePackage('alice', 'one'); await f.store.completeTask('alice', 'one');
  f.advance(FILES_TTL_MS + 1);
  const swept = await f.store.sweep();
  assert.equal(swept.expiredFiles.length, 2);
  assert.equal(swept.expiredTaskIds.length, 0);
  const task = await f.store.getTask('alice', 'one');
  assert.equal(task.copy.body, '三十天文字'); assert.equal(task.files[0].expired, true);
  await f.store.acknowledgeFiles('alice', ['alice/one/01.jpg']);
  f.advance(TASK_TTL_MS);
  const later = await f.store.sweep();
  assert.equal(later.expiredTaskIds.length, 1);
  assert.equal(later.expiredFiles.length, 1);
  assert.equal(later.expiredFiles[0].key, 'alice/one/source.jpg');
  assert.equal(await f.store.getTask('alice', 'one'), null);
  assert.equal((await f.store.getProfile('alice')).name, '长期资料');
  const disk = JSON.parse(await readFile(join(f.dataDir, 'workspaces.json'), 'utf8'));
  assert.equal(disk.users.alice.ledger.one.status, 'completed');
  await assert.rejects(f.store.createTask('alice', { id: 'one' }), { code: 'task_expired' });
});

test('a second local instance cannot recover or overwrite active work', async t => {
  const f = await fixture(t);
  const second = f.make();
  await assert.rejects(second.ready, { code: 'instance_locked' });
  await second.close();
  await f.store.createTask('alice', { id: 'active', status: 'generating' });
  assert.equal((await f.store.getTask('alice', 'active')).status, 'generating');
});

test('media stores bytes privately and refuses traversal or unsafe references', async t => {
  const f = await fixture(t);
  const media = createRestaurantMedia({ dataDir: f.dataDir, env: {} });
  await media.put('alice/task/source.jpg', Buffer.from('source'));
  assert.equal((await media.get('alice/task/source.jpg')).toString(), 'source');
  for (const key of ['../outside.jpg', 'alice/../../outside.jpg', 'C:/outside.jpg', 'alice/task\\outside.jpg', '/alice/source.jpg', 'alice/./source.jpg']) {
    await assert.rejects(media.put(key, Buffer.from('bad')), { code: 'invalid_media_key' });
    await assert.rejects(media.get(key), { code: 'invalid_media_key' });
    await assert.rejects(media.remove(key), { code: 'invalid_media_key' });
  }
  await assert.rejects(f.store.createTask('alice', { id: 'unsafe', files: [{ key: '../bad', expiresAt: f.now() }] }), { code: 'invalid_file' });
  await media.remove('alice/task/source.jpg');
  assert.equal(await media.get('alice/task/source.jpg'), null);
});

test('media never follows symlinked directories for reads, writes or cleanup', async t => {
  const f = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'restaurant-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(join(f.dataDir, 'media'), { recursive: true });
  await writeFile(join(outside, 'keep.jpg'), 'outside');
  try { await symlink(outside, join(f.dataDir, 'media', 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('OS denied creating symlink'); return; } throw error; }
  const media = createRestaurantMedia({ dataDir: f.dataDir, env: {} });
  await assert.rejects(media.get('linked/keep.jpg'), { code: 'unsafe_media' });
  await assert.rejects(media.remove('linked/keep.jpg'), { code: 'unsafe_media' });
  await assert.rejects(media.put('linked/new.jpg', Buffer.from('x')), { code: 'unsafe_media' });
  assert.equal(await readFile(join(outside, 'keep.jpg'), 'utf8'), 'outside');
});

test('COS media uses a private application prefix, returns bytes and propagates failures', async () => {
  const calls = [];
  const objects = new Map();
  const cosClient = {
    putObject(params, callback) { calls.push(params); objects.set(params.Key, params.Body); callback(null, {}); },
    getObject(params, callback) { objects.has(params.Key) ? callback(null, { Body: objects.get(params.Key) }) : callback({ statusCode: 404 }); },
    deleteObject(params, callback) { objects.delete(params.Key); callback(null, {}); },
  };
  const media = createRestaurantMedia({ env: { COS_BUCKET: 'private-bucket', COS_REGION: 'ap-test' }, cosClient });
  assert.equal(media.mode, 'cos');
  await media.put('alice/task/01.jpg', Buffer.from('private'));
  assert.equal(calls[0].ACL, 'private'); assert.equal(calls[0].Key, 'restaurant/alice/task/01.jpg');
  assert.equal((await media.get('alice/task/01.jpg')).toString(), 'private');
  await media.remove('alice/task/01.jpg'); assert.equal(await media.get('alice/task/01.jpg'), null);
  assert.throws(() => createRestaurantMedia({ env: { COS_SECRET_ID: 'partial' } }), { code: 'media_config_incomplete' });
});
