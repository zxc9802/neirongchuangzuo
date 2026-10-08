import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, lstat, symlink, utimes, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createImageRetention, IMAGE_RETENTION_MS } from '../services/ai/retention.mjs';

const START = Date.parse('2026-09-30T06:00:00Z');
const iso = value => new Date(value).toISOString();
const completed = (overrides = {}) => ({ id: randomUUID(), status: 'completed', createdAt: iso(START - IMAGE_RETENTION_MS * 2), completedAt: iso(START), images: [{ filename: 'result-1.png' }], fingerprint: 'private-deduplication-hash', ...overrides });
const missing = async path => assert.rejects(lstat(path), { code: 'ENOENT' });

async function setup(t, options = {}) {
  const parent = resolve(tmpdir());
  const directory = await mkdtemp(join(parent, 'ai-retention-contract-'));
  const storageDir = join(directory, 'storage');
  const logs = [];
  const stores = [];
  const create = (extra = {}) => {
    const store = createImageRetention({ storageDir, now: () => START, logger: { warn: (...args) => logs.push(args) }, ...options, ...extra });
    stores.push(store);
    return store;
  };
  const store = create();
  t.after(async () => {
    await Promise.all(stores.map(item => item.dispose()));
    assert.equal(dirname(resolve(directory)), parent);
    assert.ok(resolve(directory).startsWith(join(parent, 'ai-retention-contract-')));
    await rm(directory, { recursive: true, force: true });
  });
  await store.ready;
  const output = async (id, name = 'result-1.png', value = 'generated') => {
    const folder = await store.taskDirectory(id, { create: true });
    const path = join(folder, name);
    await writeFile(path, value);
    return path;
  };
  return { directory, storageDir, store, create, logs, output };
}

test('completion defines an exact 72-hour window; expiry hides results and preserves deduplication on disk', async t => {
  let clock = START;
  const ctx = await setup(t, { now: () => clock });
  const task = completed();
  await ctx.store.save(task);
  const result = await ctx.output(task.id);
  const source = await ctx.output(task.id, 'source.png', 'user original');
  const jobs = new Map([[task.id, task]]);
  assert.equal(ctx.store.expiresAt(task), START + IMAGE_RETENTION_MS);
  clock += IMAGE_RETENTION_MS - 1;
  await ctx.store.sweep(jobs);
  assert.equal(task.status, 'completed');
  assert.equal(await readFile(result, 'utf8'), 'generated');
  clock++;
  assert.equal(ctx.store.isExpired(task), true);
  assert.equal(ctx.store.publicTask(task).status, 'expired');
  assert.deepEqual(ctx.store.publicTask(task).images, []);
  assert.equal(ctx.store.publicTask(task).fingerprint, undefined);
  await ctx.store.sweep(jobs);
  await missing(result);
  assert.equal(await readFile(source, 'utf8'), 'user original');
  const record = JSON.parse(await readFile(join(ctx.storageDir, task.id, 'task.json'), 'utf8'));
  assert.equal(record.status, 'expired');
  assert.equal(record.fingerprint, task.fingerprint);
  assert.equal(record.completedAt, iso(START));
  assert.equal(ctx.store.status().deletedFiles, 1);
  assert.equal(ctx.store.status().lastSuccess, iso(clock));
});

test('explicit expiry cannot extend retention and legacy completion falls back without extending on reads', async t => {
  const { store, storageDir } = await setup(t);
  const task = completed({ expiresAt: iso(START + IMAGE_RETENTION_MS * 3) });
  assert.equal(store.expiresAt(task), START + IMAGE_RETENTION_MS);
  task.expiresAt = iso(START + 1);
  assert.equal(store.expiresAt(task), START + 1);
  const legacy = completed({ completedAt: undefined, createdAt: iso(START - IMAGE_RETENTION_MS) });
  assert.equal(store.isExpired(legacy), true);
  assert.equal(store.publicTask(legacy).expiresAt, iso(START));
  assert.equal(store.isExpired({ status: 'completed' }), true);
  await store.taskDirectory(legacy.id, { create: true });
  await writeFile(join(storageDir, legacy.id, 'task.json'), JSON.stringify(legacy));
  await store.sweep(new Map([[legacy.id, legacy]]));
  assert.equal(legacy.status, 'expired');
  assert.equal(legacy.completedAt, undefined);
  assert.equal(legacy.expiresAt, iso(START));
});

test('failed and interrupted tasks immediately discard managed half-results and chat text, preserving original files', async t => {
  const ctx = await setup(t);
  const jobs = new Map();
  for (const status of ['failed', 'interrupted']) {
    const task = completed({ status, kind: 'chat', text: 'partial private answer', completedAt: undefined });
    await ctx.store.save(task);
    assert.equal(task.text, undefined);
    assert.equal(task.failedAt, iso(START));
    jobs.set(task.id, task);
    await ctx.output(task.id);
    await ctx.output(task.id, 'result-4.webp');
    await ctx.output(task.id, 'source.png', 'keep');
    await ctx.output(task.id, 'result-16.png', 'unknown keep');
  }
  await ctx.store.start(jobs);
  for (const task of jobs.values()) {
    await missing(join(ctx.storageDir, task.id, 'result-1.png'));
    await missing(join(ctx.storageDir, task.id, 'result-4.webp'));
    assert.equal(await readFile(join(ctx.storageDir, task.id, 'source.png'), 'utf8'), 'keep');
    assert.equal(await readFile(join(ctx.storageDir, task.id, 'result-16.png'), 'utf8'), 'unknown keep');
  }
  assert.equal(ctx.store.status().deletedFiles, 4);
});

test('missing and corrupt task records clean only aged fixed result filenames by mtime', async t => {
  const ctx = await setup(t);
  for (const malformed of [undefined, '{broken', JSON.stringify(completed({ id: randomUUID() }))]) {
    const id = randomUUID();
    const old = await ctx.output(id);
    const young = await ctx.output(id, 'result-2.jpg');
    const source = await ctx.output(id, 'reference-1.png', 'original');
    await utimes(old, new Date(START - IMAGE_RETENTION_MS), new Date(START - IMAGE_RETENTION_MS));
    await utimes(young, new Date(START - IMAGE_RETENTION_MS + 1000), new Date(START - IMAGE_RETENTION_MS + 1000));
    if (malformed !== undefined) await writeFile(join(ctx.storageDir, id, 'task.json'), malformed);
    await ctx.store.sweep(new Map());
    await missing(old);
    assert.equal(await readFile(young, 'utf8'), 'generated');
    assert.equal(await readFile(source, 'utf8'), 'original');
  }
  assert.equal((await ctx.store.loadTasks()).size, 0);
  assert.equal(ctx.store.status().deletedFiles, 3);
});

test('failed deletion remains inaccessible, logs no private data, and is retried successfully', async t => {
  let fail = true;
  const ctx = await setup(t, { fsOverrides: { unlink: async path => {
    if (fail && path.endsWith('result-1.png')) throw Object.assign(new Error('PRIVATE PATH AND PROMPT MUST NOT BE LOGGED'), { code: 'EPERM' });
    return unlink(path);
  } } });
  const task = completed({ completedAt: iso(START - IMAGE_RETENTION_MS), prompt: 'PRIVATE CREATIVE REQUIREMENT' });
  await ctx.store.save(task);
  const file = await ctx.output(task.id);
  const jobs = new Map([[task.id, task]]);
  await ctx.store.sweep(jobs);
  assert.equal(ctx.store.publicTask(task).status, 'expired');
  assert.equal(ctx.store.status().pending, 1);
  assert.ok(ctx.store.status().failures > 0);
  assert.doesNotMatch(JSON.stringify(ctx.logs), /PRIVATE|result-1|storage|[A-Z]:\\/);
  assert.equal(await readFile(file, 'utf8'), 'generated');
  fail = false;
  await ctx.store.sweep(jobs);
  await missing(file);
  assert.equal(ctx.store.status().pending, 0);
  assert.equal(ctx.store.status().lastSuccess, iso(START));
});

test('cold startup loads valid tasks and sweeps expired image/chat data without touching active results', async t => {
  const ctx = await setup(t);
  const image = completed();
  const chat = completed({ kind: 'chat', text: 'Completed model reply' });
  const running = completed({ status: 'running', completedAt: undefined });
  for (const task of [image, chat, running]) await ctx.store.save(task);
  await ctx.output(image.id);
  const activeFile = await ctx.output(running.id);
  await ctx.store.dispose();
  const next = ctx.create({ now: () => START + IMAGE_RETENTION_MS });
  const jobs = await next.loadTasks();
  assert.equal(jobs.size, 3);
  assert.equal(jobs.get(chat.id).text, 'Completed model reply');
  await next.start(jobs);
  await missing(join(ctx.storageDir, image.id, 'result-1.png'));
  assert.equal(jobs.get(chat.id).text, undefined);
  const persistedChat = JSON.parse(await readFile(join(ctx.storageDir, chat.id, 'task.json'), 'utf8'));
  assert.equal(persistedChat.text, undefined);
  assert.equal(persistedChat.fingerprint, chat.fingerprint);
  assert.equal(jobs.get(running.id).status, 'running');
  assert.equal(await readFile(activeFile, 'utf8'), 'generated');
  // The server, which knows whether a task still has an active worker, owns this transition.
  jobs.get(running.id).status = 'failed';
  jobs.get(running.id).code = 'INTERRUPTED';
  await next.save(jobs.get(running.id));
  await next.sweep(jobs);
  await missing(activeFile);
});

test('metadata writes are atomic and reject invalid IDs or states', async t => {
  let rejectRename = false;
  const native = await import('node:fs/promises');
  const ctx = await setup(t, { fsOverrides: { rename: async (...args) => {
    if (rejectRename) throw Object.assign(new Error('write denied'), { code: 'EACCES' });
    return native.rename(...args);
  } } });
  const task = completed({ status: 'queued', completedAt: undefined });
  await ctx.store.save(task);
  rejectRename = true;
  task.status = 'completed';
  await assert.rejects(ctx.store.save(task), { code: 'EACCES' });
  const saved = JSON.parse(await readFile(join(ctx.storageDir, task.id, 'task.json'), 'utf8'));
  assert.equal(saved.status, 'queued');
  assert.equal(task.completedAt, iso(START));
  assert.deepEqual(await readdir(join(ctx.storageDir, task.id)), ['task.json']);
  await assert.rejects(ctx.store.save({ ...task, id: '../outside' }), /Invalid/);
  await assert.rejects(ctx.store.save({ ...task, status: 'unknown' }), /Invalid/);
  await assert.rejects(ctx.store.resultPath(task.id, 'source.png'), /Invalid/);
});

test('Windows metadata replacement retries transient locks for one snapshot and remains bounded', { skip: process.platform !== 'win32' }, async t => {
  const native = await import('node:fs/promises');
  let contention = null, attempts = 0, writes = 0;
  const ctx = await setup(t, { fsOverrides: {
    writeFile: async (...args) => { writes++; return native.writeFile(...args); },
    rename: async (...args) => {
      if (contention && ++attempts <= contention.length) throw Object.assign(new Error('temporary local lock'), { code: contention[attempts - 1] });
      return native.rename(...args);
    },
  } });
  const task = completed({ status: 'queued', completedAt: undefined });
  await ctx.store.save(task);
  task.status = 'completed'; contention = ['EPERM', 'EBUSY'];
  const before = writes;
  await ctx.store.save(task);
  assert.equal(attempts, 3);
  assert.equal(writes - before, 1, 'the serialized snapshot is written once');
  const metadata = join(ctx.storageDir, task.id, 'task.json');
  assert.equal(JSON.parse(await readFile(metadata, 'utf8')).status, 'completed');
  assert.equal(ctx.store.publicTask(task).expiresAt, iso(START + IMAGE_RETENTION_MS));
  task.status = 'failed'; attempts = 0; contention = Array(10).fill('EPERM');
  await assert.rejects(ctx.store.save(task), { code: 'EPERM' });
  assert.equal(attempts, 4, 'persistent locks fail after a finite local retry');
  assert.equal(JSON.parse(await readFile(metadata, 'utf8')).status, 'completed');
  assert.deepEqual(await readdir(join(ctx.storageDir, task.id)), ['task.json']);
});

test('a Windows metadata retry rechecks the destination and cannot replace a newly introduced symlink', { skip: process.platform !== 'win32' }, async t => {
  const native = await import('node:fs/promises');
  let intercept = false, attempts = 0, outside;
  const ctx = await setup(t, { fsOverrides: { rename: async (...args) => {
    if (intercept) {
      attempts++;
      await native.unlink(args[1]);
      await native.symlink(outside, args[1], 'file');
      throw Object.assign(new Error('temporary local lock'), { code: 'EPERM' });
    }
    return native.rename(...args);
  } } });
  outside = join(ctx.directory, 'outside-file');
  await writeFile(outside, 'outside contents');
  const probe = join(ctx.directory, 'symlink-probe');
  try { await symlink(outside, probe, 'file'); await unlink(probe); }
  catch (error) { if (error.code === 'EPERM') return t.skip('Creating file symlinks requires a Windows privilege'); throw error; }
  const task = completed({ status: 'queued', completedAt: undefined });
  await ctx.store.save(task);
  task.status = 'completed'; intercept = true;
  await assert.rejects(ctx.store.save(task), /Unsafe/);
  assert.equal(attempts, 1);
  assert.equal(await readFile(outside, 'utf8'), 'outside contents');
  assert.equal((await lstat(join(ctx.storageDir, task.id, 'task.json'))).isSymbolicLink(), true);
});

test('task junctions and result directories are never traversed or removed', async t => {
  const ctx = await setup(t);
  const outside = join(ctx.directory, 'outside');
  await mkdir(outside);
  const external = join(outside, 'result-1.png');
  await writeFile(external, 'outside stays');
  await utimes(external, new Date(0), new Date(0));
  const id = randomUUID();
  const junction = join(ctx.storageDir, id);
  await symlink(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(ctx.store.taskDirectory(id), /Unsafe/);
  await assert.rejects(ctx.store.save(completed({ id })), /Unsafe/);
  const own = randomUUID();
  await mkdir(join(await ctx.store.taskDirectory(own, { create: true }), 'result-1.png'));
  await ctx.store.sweep(new Map());
  assert.equal(await readFile(external, 'utf8'), 'outside stays');
  assert.equal((await lstat(junction)).isSymbolicLink(), true);
  assert.equal((await lstat(join(ctx.storageDir, own, 'result-1.png'))).isDirectory(), true);
  assert.ok(ctx.store.status().pending >= 2);
  if (process.platform === 'win32') await rmdir(junction); else await unlink(junction);
});

test('symbolic result and metadata files cannot be used for read, overwrite or cleanup', async t => {
  const ctx = await setup(t);
  const id = randomUUID();
  const directory = await ctx.store.taskDirectory(id, { create: true });
  const external = join(ctx.directory, 'outside-file');
  await writeFile(external, 'outside contents');
  try { await symlink(external, join(directory, 'result-1.png'), 'file'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('Creating file symlinks requires a Windows privilege'); throw error; }
  await symlink(external, join(directory, 'task.json'), 'file');
  await assert.rejects(ctx.store.resultPath(id, 'result-1.png'), /Unsafe/);
  await assert.rejects(ctx.store.save(completed({ id })), /Unsafe/);
  await ctx.store.sweep(new Map());
  assert.equal(await readFile(external, 'utf8'), 'outside contents');
  assert.equal((await lstat(join(directory, 'result-1.png'))).isSymbolicLink(), true);
  assert.equal((await ctx.store.loadTasks()).size, 0);
});

test('storage root junction is rejected before writes and scheduled sweeps stop on dispose', async t => {
  let clock = START;
  const ctx = await setup(t, { now: () => clock, cleanupIntervalMs: 5 });
  const task = completed();
  await ctx.store.save(task);
  const file = await ctx.output(task.id);
  await ctx.store.start(new Map([[task.id, task]]));
  clock += IMAGE_RETENTION_MS;
  const deadline = Date.now() + 1500;
  while (ctx.store.status().deletedFiles === 0 && Date.now() < deadline) await delay(10);
  await missing(file);
  await ctx.store.dispose();
  const before = ctx.store.status().lastSweep;
  clock += 1000;
  await delay(20);
  assert.equal(ctx.store.status().lastSweep, before);
  const link = join(ctx.directory, 'root-junction');
  await symlink(ctx.storageDir, link, process.platform === 'win32' ? 'junction' : 'dir');
  const rejected = createImageRetention({ storageDir: link });
  await assert.rejects(rejected.ready, /Unsafe/);
  await rejected.dispose();
  if (process.platform === 'win32') await rmdir(link); else await unlink(link);
});
