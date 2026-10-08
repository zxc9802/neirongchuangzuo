import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequestLedger } from '../services/ai/request-ledger.mjs';

const input = (id, overrides = {}) => ({ id, kind: 'image', fingerprint: `hash-${id}`, model: 'mock-model', ...overrides });
const at = Date.parse('2026-09-30T08:00:00Z');

async function fixture(t, options = {}) {
  const parent = resolve(tmpdir());
  const storageDir = await mkdtemp(join(parent, 'ai-ledger-test-'));
  const opened = [];
  const create = (overrides = {}) => {
    const ledger = createRequestLedger({ storageDir, now: () => at, ...options, ...overrides });
    opened.push(ledger);
    return ledger;
  };
  t.after(async () => {
    for (const ledger of opened) await ledger.close();
    assert.equal(dirname(resolve(storageDir)), parent);
    assert.ok(resolve(storageDir).startsWith(join(parent, 'ai-ledger-test-')));
    await rm(storageDir, { recursive: true, force: true });
  });
  return { storageDir, create, file: join(storageDir, '.runtime-control', 'requests.json'), lock: join(storageDir, '.runtime-control', 'lock') };
}

test('concurrent reservations atomically respect daily limits; duplicate ids reuse and mismatches conflict', async t => {
  const { create } = await fixture(t, { limits: { imageDaily: 2, chatDaily: 3, perMinute: 20 } });
  const ledger = create();
  await ledger.ready;
  const outcomes = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => ledger.reserve(input(`image-${i}`))));
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 2);
  for (const value of outcomes.filter(value => value.status === 'rejected')) {
    assert.equal(value.reason.status, 429);
    assert.equal(value.reason.code, 'DAILY_QUOTA_EXCEEDED');
  }
  assert.equal((await ledger.reserve(input('image-0'))).created, false);
  await assert.rejects(ledger.reserve(input('image-0', { fingerprint: 'changed' })), { status: 409, code: 'REQUEST_ID_CONFLICT' });
  await ledger.reserve(input('chat', { kind: 'chat' }));
  assert.deepEqual((await ledger.summary()).used, { image: 2, chat: 1 });
});

test('batch reservations atomically reserve every image or none, and duplicate batches never consume again', async t => {
  const { create, file } = await fixture(t, { limits: { imageDaily: 4, perMinute: 10 } });
  const ledger = create();
  const batch = [input('set'), input('set-2'), input('set-3')];
  assert.equal((await ledger.reserveBatch(batch)).created, true);
  assert.equal((await ledger.summary()).used.image, 3);
  assert.equal((await ledger.reserveBatch(batch)).created, false);
  await assert.rejects(ledger.reserveBatch([input('other'), input('other-2')]), { code: 'DAILY_QUOTA_EXCEEDED' });
  assert.equal(await ledger.get('other'), null);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).records.length, 3);
  await assert.rejects(ledger.reserveBatch([input('set'), input('new-child')]), { code: 'REQUEST_ID_CONFLICT' });
  await assert.rejects(ledger.reserveBatch([input('set', { fingerprint: 'changed' }), input('set-2'), input('set-3')]), { code: 'REQUEST_ID_CONFLICT' });
  await ledger.markDispatched('set');
  await ledger.finish('set', { status: 'completed' });
  await ledger.finish('set-2', { status: 'cancelled' });
  await ledger.finish('set-3', { status: 'cancelled' });
  assert.equal((await ledger.summary()).used.image, 1);
});

test('concurrent image batches cannot overbook quota and invalid batches leave no reservations', async t => {
  const { create } = await fixture(t, { limits: { imageDaily: 3, perMinute: 10 } });
  const ledger = create();
  for (const bad of [[], null, [input('same'), input('same')], Array.from({ length: 16 }, (_, i) => input(`too-many-${i}`)), [input('valid'), input('bad', { model: 2 })]]) {
    await assert.rejects(ledger.reserveBatch(bad), { code: 'INVALID_REQUEST_ID' });
  }
  const results = await Promise.allSettled([ledger.reserveBatch([input('one'), input('one-2')]), ledger.reserveBatch([input('two'), input('two-2')])]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'DAILY_QUOTA_EXCEEDED');
  assert.equal((await ledger.summary()).used.image, 2);
});

test('undispatched failures release allowance but dispatched failures and unknown results still count', async t => {
  const { create } = await fixture(t, { limits: { imageDaily: 2, perMinute: 20 } });
  const ledger = create();
  await ledger.reserve(input('invalid-upload'));
  await ledger.finish('invalid-upload', { status: 'failed', code: 'INVALID_IMAGE' });
  assert.equal((await ledger.summary()).used.image, 0);
  assert.equal((await ledger.reserve(input('invalid-upload'))).created, false);
  await ledger.reserve(input('provider-failed'));
  const sent = await ledger.markDispatched('provider-failed');
  assert.equal(sent.dispatchedAt, at);
  await ledger.markDispatched('provider-failed');
  await ledger.finish('provider-failed', { status: 'failed', code: 'UPSTREAM_ERROR' });
  await ledger.reserve(input('timeout'));
  await ledger.markDispatched('timeout');
  await ledger.finish('timeout', { status: 'uncertain', code: 'UPSTREAM_TIMEOUT' });
  assert.equal((await ledger.summary()).used.image, 2);
  await assert.rejects(ledger.reserve(input('over-limit')), { code: 'DAILY_QUOTA_EXCEEDED' });
  await assert.rejects(ledger.markDispatched('timeout'), { code: 'REQUEST_ALREADY_FINISHED' });
});

test('rolling minute restriction is shared by image and chat and duplicate operations do not consume it', async t => {
  let clock = at;
  const { create } = await fixture(t, { now: () => clock, limits: { perMinute: 2 } });
  const ledger = create();
  await ledger.reserve(input('one'));
  await ledger.markDispatched('one');
  await ledger.markDispatched('one');
  await ledger.reserve(input('one'));
  await ledger.reserve(input('two', { kind: 'chat' }));
  await assert.rejects(ledger.reserve(input('three')), { status: 429, code: 'RATE_LIMITED' });
  clock += 60_000;
  await ledger.reserve(input('three'));
  assert.deepEqual((await ledger.summary()).used, { image: 2, chat: 1 });
});

test('daily counters roll over at Beijing midnight and zero limits disable calls', async t => {
  let clock = Date.parse('2026-09-30T15:59:59Z');
  const { create } = await fixture(t, { now: () => clock, limits: { imageDaily: 1, chatDaily: 0, perMinute: 10 } });
  const ledger = create();
  await ledger.reserve(input('before-midnight'));
  assert.equal((await ledger.summary()).day, '2026-09-30');
  await assert.rejects(ledger.reserve(input('blocked-chat', { kind: 'chat' })), { code: 'DAILY_QUOTA_EXCEEDED' });
  clock += 1000;
  const summary = await ledger.summary();
  assert.equal(summary.day, '2026-10-01');
  assert.equal(summary.timeZone, 'Asia/Shanghai');
  assert.equal(summary.used.image, 0);
  await ledger.reserve(input('after-midnight'));
});

test('restart releases reserved work and marks sent work uncertain without allowing duplicate payment', async t => {
  const { create } = await fixture(t);
  const first = create();
  await first.reserve(input('reserved'));
  await first.reserve(input('sent'));
  await first.markDispatched('sent');
  await first.close();
  const second = create();
  await second.ready;
  assert.equal((await second.get('reserved')).status, 'cancelled');
  assert.equal((await second.get('sent')).status, 'uncertain');
  assert.equal((await second.get('sent')).code, 'SERVICE_RESTARTED');
  assert.equal((await second.summary()).used.image, 1);
  assert.equal((await second.reserve(input('sent'))).created, false);
});

test('only minimal usage fields are saved; summaries omit fingerprints and request bodies', async t => {
  const { create, file } = await fixture(t);
  const ledger = create();
  await ledger.reserve(input('safe', { prompt: 'secret prompt', apiKey: 'secret-key', images: ['base64-sensitive'] }));
  await ledger.markDispatched('safe');
  await ledger.finish('safe', { status: 'completed', code: 'OK', providerRequestId: 'req_123',
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, price: 999, secret: 'secret' },
    text: 'private output', apiKey: 'secret-key' });
  const summary = await ledger.summary();
  assert.deepEqual(summary.recent[0].usage, { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
  assert.equal(summary.recent[0].fingerprint, undefined);
  assert.equal(summary.recent[0].providerRequestId, 'req_123');
  const saved = await readFile(file, 'utf8');
  for (const secret of ['secret prompt', 'secret-key', 'base64-sensitive', 'private output', '"price"']) assert.equal(saved.includes(secret), false);
  summary.recent[0].status = 'corrupted';
  assert.equal((await ledger.get('safe')).status, 'completed');
});

test('exclusive lock rejects a second instance even in the same process and close releases only its own lock', async t => {
  const { create, lock } = await fixture(t);
  const first = create();
  await first.ready;
  const second = create();
  await assert.rejects(second.ready, { code: 'AI_INSTANCE_LOCKED', status: 503 });
  await second.close();
  assert.equal(JSON.parse(await readFile(lock, 'utf8')).pid, process.pid);
  await first.reserve(input('still-owner'));
  await first.close();
  const third = create();
  await third.ready;
});

test('a lock is taken over only when its local PID is confirmed absent', async t => {
  const { create, lock } = await fixture(t);
  await mkdir(dirname(lock), { recursive: true });
  const child = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  assert.equal(child.status, 0);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  await writeFile(lock, JSON.stringify({ pid: child.pid, hostname: hostname(), token: randomUUID() }));
  const ledger = create();
  await ledger.ready;
  assert.equal(JSON.parse(await readFile(lock, 'utf8')).pid, process.pid);
});

test('unknown-host and corrupt locks fail closed; age never permits stealing a live lock', async t => {
  for (const state of [
    { pid: process.pid, hostname: 'another-server', token: randomUUID(), createdAt: 1 },
    { pid: process.pid, hostname: hostname(), token: randomUUID(), createdAt: 1 },
    { nonsense: true },
  ]) {
    const { create, lock } = await fixture(t);
    await mkdir(dirname(lock), { recursive: true });
    await writeFile(lock, JSON.stringify(state));
    const ledger = create();
    await assert.rejects(ledger.ready, { code: 'AI_INSTANCE_LOCKED' });
    assert.deepEqual(JSON.parse(await readFile(lock, 'utf8')), state);
  }
});

test('malformed storage fails closed rather than resetting used counters', async t => {
  const { create, file } = await fixture(t);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, '{invalid');
  const ledger = create();
  await assert.rejects(ledger.ready, { code: 'AI_LEDGER_UNAVAILABLE' });
  await assert.rejects(ledger.reserve(input('must-not-send')), { code: 'AI_LEDGER_UNAVAILABLE' });
  assert.equal(await readFile(file, 'utf8'), '{invalid');
});

test('junction or symlink storage cannot redirect managed files outside the root', async t => {
  const { storageDir, create } = await fixture(t);
  const outside = await mkdtemp(join(resolve(tmpdir()), 'ai-ledger-test-outside-'));
  const linked = join(storageDir, '.runtime-control');
  try {
    await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (cause) {
    if (['EPERM', 'EACCES'].includes(cause.code)) { t.skip('symlink permission unavailable'); return; }
    throw cause;
  }
  t.after(async () => {
    await unlink(linked).catch(() => {});
    assert.equal(dirname(resolve(outside)), resolve(tmpdir()));
    await rm(outside, { recursive: true, force: true });
  });
  const ledger = create();
  await assert.rejects(ledger.ready, { code: 'AI_LEDGER_UNAVAILABLE' });
  await assert.rejects(readFile(join(outside, 'lock')), { code: 'ENOENT' });
});

test('mutations fail closed when ownership is lost and close preserves the replacement lock', async t => {
  const { create, lock } = await fixture(t);
  const ledger = create();
  await ledger.ready;
  const replacement = { pid: process.pid, hostname: hostname(), token: randomUUID() };
  await writeFile(lock, JSON.stringify(replacement));
  await assert.rejects(ledger.reserve(input('lost')), { code: 'AI_INSTANCE_LOCKED' });
  await ledger.close();
  assert.deepEqual(JSON.parse(await readFile(lock, 'utf8')), replacement);
});

test('simultaneous identical requests persist exactly one reservation', async t => {
  const { create } = await fixture(t);
  const ledger = create();
  const results = await Promise.all(Array.from({ length: 12 }, () => ledger.reserve(input('duplicate'))));
  assert.equal(results.filter(result => result.created).length, 1);
  assert.equal((await ledger.summary()).used.image, 1);
});

test('close drains already queued writes and rejects new work', async t => {
  const { create } = await fixture(t);
  const ledger = create();
  const pending = ledger.reserve(input('queued-before-close'));
  const closing = ledger.close();
  assert.equal((await pending).created, true);
  await closing;
  await assert.rejects(ledger.reserve(input('after-close')), { code: 'AI_SERVICE_CLOSED' });
  const next = create();
  await next.ready;
  assert.equal((await next.get('queued-before-close')).status, 'cancelled');
});

test('a persisted completed record without dispatch data is rejected to avoid resetting attempted-call totals', async t => {
  const { create, file } = await fixture(t);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, records: [{ ...input('broken'), status: 'completed',
    day: '2026-09-30', createdAt: at, finishedAt: at + 1 }] }));
  await assert.rejects(create().ready, { code: 'AI_LEDGER_UNAVAILABLE' });
});

test('dispatch after Beijing midnight moves the attempt to its actual day and persists the corrected day', async t => {
  let clock = Date.parse('2026-09-30T15:59:59Z');
  const { create } = await fixture(t, { now: () => clock, limits: { imageDaily: 1, perMinute: 10 } });
  const ledger = create();
  await ledger.reserve(input('crossing-midnight'));
  clock += 1000;
  const sent = await ledger.markDispatched('crossing-midnight');
  assert.equal(sent.day, '2026-10-01');
  assert.equal(sent.dispatchedAt, clock);
  assert.equal((await ledger.summary()).used.image, 1);
  await assert.rejects(ledger.reserve(input('second-today')), { code: 'DAILY_QUOTA_EXCEEDED' });
  await ledger.close();
  const recovered = create();
  await recovered.ready;
  assert.equal((await recovered.get('crossing-midnight')).status, 'uncertain');
  assert.equal((await recovered.summary()).used.image, 1);
});

test('dispatch rechecks the new day allowance and rejects before provider invocation when already full', async t => {
  let clock = Date.parse('2026-09-30T15:59:59Z');
  const { create } = await fixture(t, { now: () => clock, limits: { imageDaily: 1, perMinute: 10 } });
  const ledger = create();
  await ledger.reserve(input('yesterday-waiting'));
  clock += 1000;
  await ledger.reserve(input('today-completed'));
  await ledger.markDispatched('today-completed');
  await ledger.finish('today-completed', { status: 'completed' });
  let providerCalls = 0;
  await assert.rejects((async () => {
    await ledger.markDispatched('yesterday-waiting');
    providerCalls++;
  })(), { status: 429, code: 'DAILY_QUOTA_EXCEEDED' });
  assert.equal(providerCalls, 0);
  assert.equal((await ledger.get('yesterday-waiting')).dispatchedAt, undefined);
  await ledger.finish('yesterday-waiting', { status: 'failed', code: 'DAILY_QUOTA_EXCEEDED' });
  assert.equal((await ledger.summary()).used.image, 1);
});

test('minute counters use dispatch time and recheck queued reservations before sending', async t => {
  let clock = at;
  const { create } = await fixture(t, { now: () => clock, limits: { perMinute: 1 } });
  const ledger = create();
  await ledger.reserve(input('waiting'));
  clock += 60_000;
  await ledger.reserve(input('newer'));
  await ledger.markDispatched('newer');
  await assert.rejects(ledger.markDispatched('waiting'), { status: 429, code: 'RATE_LIMITED' });
  assert.equal((await ledger.get('waiting')).dispatchedAt, undefined);
  clock += 60_000;
  await ledger.markDispatched('waiting');
  await assert.rejects(ledger.reserve(input('third')), { code: 'RATE_LIMITED' });
  clock += 60_000;
  await ledger.reserve(input('third'));
});

test('minute windows exclude future timestamps after a wall-clock correction', async t => {
  let clock = at;
  const { create } = await fixture(t, { now: () => clock, limits: { perMinute: 1 } });
  const ledger = create();
  await ledger.reserve(input('future'));
  await ledger.markDispatched('future');
  clock -= 1000;
  await ledger.reserve(input('corrected-clock'));
  await ledger.markDispatched('corrected-clock');
  assert.equal((await ledger.summary()).used.image, 2);
});
