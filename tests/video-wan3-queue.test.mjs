import test from 'node:test';
import assert from 'node:assert/strict';
import { createWan3Queue } from '../services/video/wan3-queue.mjs';
import { WAN3_MODEL, WAN3_FAST_MODEL } from '../services/video/provider.mjs';

function fixture() {
  let at = 10_000, jobs = new Map(), queue;
  const disk = new Map(), save = async task => disk.set(task.id, structuredClone(task));
  const open = () => queue = createWan3Queue({ jobs, save, now: () => at });
  open();
  return {
    get queue() { return queue; }, get jobs() { return jobs; }, disk,
    advance(ms) { at += ms; },
    async add(id, count, wan3Route = 'official', model = WAN3_MODEL) {
      const task = { id, userId: id, model, wan3Route, status: 'reviewing', recoveryDeadline: at + 30 * 60_000,
        ...(count ? { segments: Array.from({ length: count }, (_, index) => ({ index, wan3Route })) } : {}) };
      jobs.set(id, task); await queue.enqueue(task); return task;
    },
    async restart() { jobs = new Map(structuredClone([...disk])); open(); await queue.restore(); },
  };
}

test('official users still share five active slots, a rolling five-RPS limit and FIFO admission', async () => {
  const app = fixture(), tasks = [];
  for (let i = 0; i < 10; i++) tasks.push(await app.add(String(i)));
  assert.deepEqual(await Promise.all(tasks.map(task => app.queue.admit(task))), [true, true, true, true, true, false, false, false, false, false]);
  assert.equal(app.queue.view(tasks[5]).position, 1);
  app.queue.observe(tasks[0], { completed: true });
  assert.equal(await app.queue.admit(tasks[5]), false, 'a freed slot does not bypass RPS');
  app.advance(999); assert.equal(await app.queue.admit(tasks[5]), false);
  app.advance(1); assert.equal(await app.queue.admit(tasks[5]), true);
  assert.equal(await app.queue.admit(tasks[6]), false, 'still at five processing tasks');
  tasks[6].status = 'cancelled';
  app.queue.observe(tasks[1], { failed: true });
  assert.equal(await app.queue.admit(tasks[8]), false, 'later users cannot jump the queue');
  assert.equal(await app.queue.admit(tasks[7]), true, 'cancelled waiting tickets are skipped');
});

test('segments count individually and free slots before their parent finishes', async () => {
  const app = fixture(), first = await app.add('first', 4), second = await app.add('second', 4);
  for (const part of first.segments) assert.equal(await app.queue.admit(first, part), true);
  assert.equal(await app.queue.admit(second, second.segments[0]), true);
  assert.equal(await app.queue.admit(second, second.segments[1]), false);
  assert.deepEqual(app.queue.view(second), { position: 1, pending: 3 });
  app.queue.observe(second.segments[0], { completed: true }); app.advance(1000);
  assert.equal(await app.queue.admit(second, second.segments[1]), true);
  assert.equal(await app.queue.admit(second, second.segments[2]), false);
  app.advance(60 * 60_000);
  const deadline = second.recoveryDeadline;
  app.queue.finish(second);
  assert.equal(second.recoveryDeadline - deadline, 60 * 60_000 + 1000);
});

test('restart preserves active, unconfirmed and stopped upstream jobs plus FIFO order', async () => {
  const app = fixture();
  for (let i = 0; i < 7; i++) { const task = await app.add(String(i)); await app.queue.admit(task); }
  const cancelled = app.disk.get('0'); cancelled.status = 'cancelled'; cancelled.providerId = 'existing-job';
  await app.restart(); app.advance(1000);
  assert.equal(await app.queue.admit(app.jobs.get('5')), false);
  assert.equal(await app.queue.admit(app.jobs.get('1')), false, 'unknown dispatch must not replay');
  app.queue.observe(app.jobs.get('0'), { failed: true });
  assert.equal(await app.queue.admit(app.jobs.get('6')), false);
  assert.equal(await app.queue.admit(app.jobs.get('5')), true);
});

test('429 releases its slot but applies a durable route-wide retry delay', async () => {
  const app = fixture(), first = await app.add('first'), second = await app.add('second');
  assert.equal(await app.queue.admit(first), true);
  await app.queue.rejected(first, first, { throttled: true, retryAfterMs: 7000 });
  assert.equal(first.providerDispatched, false);
  assert.equal(await app.queue.admit(first), false);
  assert.equal(await app.queue.admit(second), false);
  await app.restart(); app.advance(6999);
  assert.equal(await app.queue.admit(app.jobs.get('first')), false);
  app.advance(1); assert.equal(await app.queue.admit(app.jobs.get('first')), true);
  assert.equal(await app.queue.admit(app.jobs.get('second')), true);
});

test('aggregate users and both models share exactly 600 slots across restart, including stopped and uncertain jobs', async () => {
  const app = fixture(), tasks = [];
  for (let i = 0; i < 601; i++) tasks.push(await app.add(String(i), undefined, 'aggregate', i % 2 ? WAN3_FAST_MODEL : WAN3_MODEL));
  for (let i = 0; i < 600; i += 5) {
    assert.deepEqual(await Promise.all(tasks.slice(i, i + 5).map(task => app.queue.admit(task))), Array(5).fill(true));
    assert.equal(await app.queue.admit(tasks[i + 5]), false, '600 concurrency does not bypass the five-RPS limit');
    app.advance(1000);
  }
  assert.equal([...app.jobs.values()].filter(task => app.queue.active(task)).length, 600);
  assert.equal(await app.queue.admit(tasks[600]), false, 'the 601st task waits for a free slot');
  app.disk.get('0').status = 'cancelled'; app.disk.get('0').providerId = 'already-submitted';
  await app.restart(); app.advance(1000);
  assert.equal(await app.queue.admit(app.jobs.get('600')), false, 'stopping locally does not release an upstream job');
  assert.equal(await app.queue.admit(app.jobs.get('1')), false, 'a dispatch without a receipt is never replayed');
  const official = await app.add('official');
  assert.equal(await app.queue.admit(official), true, 'full aggregate capacity does not block the official route');
  app.queue.observe(app.jobs.get('0'), { completed: true });
  assert.equal(await app.queue.admit(app.jobs.get('600')), true);
  assert.equal([...app.jobs.values()].filter(task => task.wan3Route === 'aggregate' && app.queue.active(task)).length, 600);
});

test('a full official queue does not block aggregate FIFO or change the shared request rate', async () => {
  const app = fixture(), official = [];
  for (let i = 0; i < 6; i++) official.push(await app.add('official-' + i));
  for (const task of official.slice(0, 5)) assert.equal(await app.queue.admit(task), true);
  const first = await app.add('aggregate-first', undefined, 'aggregate');
  const second = await app.add('aggregate-second', undefined, 'aggregate');
  assert.equal(await app.queue.admit(first), false, 'requests remain limited across both routes');
  assert.deepEqual(app.queue.view(first), { position: 1, pending: 1 });
  assert.deepEqual(app.queue.view(second), { position: 2, pending: 1 });
  app.advance(1000);
  assert.equal(await app.queue.admit(second), false, 'FIFO is preserved within the aggregate route');
  assert.equal(await app.queue.admit(first), true);
  assert.equal(await app.queue.admit(second), true);
  assert.equal(await app.queue.admit(official[5]), false, 'official concurrency remains five');
});

test('fallback segments move to the official pool and a route cooldown does not block the other provider', async () => {
  const app = fixture(), task = await app.add('segmented', 2, 'aggregate');
  for (const part of task.segments) assert.equal(await app.queue.admit(task, part), true);
  const [first, fallback] = task.segments;
  app.queue.observe(fallback, { failed: true });
  fallback.wan3Route = 'official';
  await app.queue.rejected(task, fallback, { throttled: true, retryAfterMs: 7000 });
  const primary = await app.add('primary', undefined, 'aggregate'), official = await app.add('official');
  assert.equal(await app.queue.admit(primary), true, 'fallback cooldown only affects the official route');
  assert.equal(await app.queue.admit(task, fallback), false);
  assert.equal(await app.queue.admit(official), false);
  await app.restart(); app.advance(7000);
  const saved = app.jobs.get(task.id);
  assert.equal(app.queue.active(saved.segments[0]), true);
  assert.equal(await app.queue.admit(saved, saved.segments[1]), true);
  assert.equal(await app.queue.admit(app.jobs.get('official')), true);
  assert.equal(first.wan3Route, 'aggregate');
});

test('upgrade reconstructs existing jobs without assuming local cancellation freed capacity', async () => {
  const app = fixture();
  for (let i = 0; i < 6; i++) app.jobs.set(String(i), { id: String(i), model: WAN3_MODEL,
    status: i === 0 ? 'cancelled' : 'running', providerId: 'job-' + i, providerDispatched: true });
  await app.queue.restore(); app.advance(1000);
  const waiting = await app.add('new');
  assert.equal(await app.queue.admit(waiting), false);
  app.queue.observe(app.jobs.get('0'), { completed: true });
  assert.equal(await app.queue.admit(waiting), false, 'legacy six jobs must drain below five');
  app.queue.observe(app.jobs.get('1'), { failed: true });
  assert.equal(await app.queue.admit(waiting), true);
});
