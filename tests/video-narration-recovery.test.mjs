import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createNarrationService } from '../services/video/narration.mjs';
import { groupNarrationSegments } from '../services/video/narration-recovery.mjs';
import { createApiCostMeter } from '../services/credits/meter.mjs';
import { createCreditsLedger } from '../services/credits/store.mjs';

const endpoint = 'fal-ai/index-tts-2/text-to-speech';
const receipt = id => ({ request_id: id, status_url: `https://queue.fal.run/fal-ai/index-tts-2/requests/${id}/status`,
  response_url: `https://queue.fal.run/fal-ai/index-tts-2/requests/${id}` });
const detect = async () => [{ start: 0.1, end: 0.5 }];
const upload = async file => `https://fal.media/${basename(file)}`;
async function source(t, duration = 6, audioDuration = duration, close = async () => {}) {
  const folder = await mkdtemp(join(tmpdir(), 'narration-recovery-'));
  t.after(async () => { await close(); await rm(folder, { recursive: true, force: true }); });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=black:s=160x240:r=24:d=${duration}`,
    '-f', 'lavfi', '-i', `sine=frequency=220:duration=${audioDuration}`, '-c:v', 'libx264', '-c:a', 'aac', join(folder, 'source.mp4')]);
  return folder;
}
const input = () => ({ video: { audio: true }, speech: { segments: [{ start: 5.5, end: 5.916, text: '原视频台词' }] } });

test('the real speech detector accepts a five-second original reference with speech', {
  skip: !process.env.VIDEO_PYTHON_BIN,
}, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'narration-real-vad-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=black:s=160x240:r=24:d=6',
    '-i', 'tests/fixtures/replica-speech.wav', '-af', 'apad', '-t', '6', '-c:v', 'libx264', '-c:a', 'aac', join(folder, 'source.mp4')]);
  const service = createNarrationService({ FAL_KEY: 'test', VIDEO_PYTHON_BIN: process.env.VIDEO_PYTHON_BIN });
  const narration = await service.prepare(input(), folder);
  assert.ok(narration.segments[0].emotionReference.duration >= 5);
});

test('short lines and the short tail merge without removing repeated dialogue or crossing known speakers', () => {
  const parts = [{ start: 0, end: 2, text: '牛蹄筋' }, { start: 2, end: 4, text: '牛蹄筋' },
    { start: 4, end: 6, text: '真好吃' }, { start: 6, end: 6.416, text: '再来' }];
  assert.deepEqual(groupNarrationSegments(parts), [{ start: 0, end: 6.416, text: '牛蹄筋牛蹄筋真好吃再来' }]);
  assert.equal(groupNarrationSegments(parts.map((p, i) => ({ ...p, speaker: i < 2 ? 'A' : 'B' }))).length, 2);
});

test('a 0.416 second final cue uses at least five decoded seconds from the original source', async t => {
  const folder = await source(t), task = input();
  const service = createNarrationService({ FAL_KEY: 'test' }, { detect, upload, fetchImpl: () => assert.fail('preflight must not generate') });
  task.narration = await service.prepare(task, folder);
  const reference = task.narration.segments[0].emotionReference;
  assert.ok(reference.duration >= 5); assert.ok(reference.start >= 0); assert.ok(reference.end <= 6.1);
  const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0',
    join(folder, 'narration', 'emotion-0.wav')]).toString());
  assert.ok(duration >= 5);
  assert.equal(task.narration.emotionSource, 'original-video');
});

test('a long video with a short audio track waits for source material before any paid request', async t => {
  const folder = await source(t, 6, 0.416);
  const service = createNarrationService({ FAL_KEY: 'test' }, { detect, upload, fetchImpl: () => assert.fail('no generation') });
  await assert.rejects(service.prepare(input(), folder), { code: 'VIDEO_NARRATION_WAITING', recoveryAction: 'input' });
});

test('empty original speech is checked three times then waits, with no timbre or text emotion fallback', async t => {
  const folder = await source(t); let checks = 0;
  const service = createNarrationService({ FAL_KEY: 'test' }, {
    detect: async () => { checks++; return []; }, upload, fetchImpl: () => assert.fail('no generation'),
  });
  await assert.rejects(service.prepare(input(), folder), { code: 'VIDEO_NARRATION_WAITING', recoveryAction: 'input' });
  assert.equal(checks, 3);
  await assert.rejects(service.prepare({ ...input(), video: { audio: false } }, folder), { recoveryAction: 'input' });
});

for (const succeeds of [true, false]) test(`confirmed failures preserve other segments, survive restart and ${succeeds ? 'recover on retry' : 'stop after three paid attempts'}`, async t => {
  const folder = await source(t); let clock = Date.now(), posts = 0, saved;
  const options = { now: () => clock, detect, upload, download: async () => {},
    fetchImpl: async (_url, request) => {
      if (request.method === 'POST') { posts++; return Response.json(receipt(`paid-${posts}`)); }
      if (String(_url).endsWith('/status')) return Response.json({ status: 'COMPLETED' });
      return succeeds && posts === 2 ? Response.json({ audio: { url: 'https://fal.media/output.wav' } })
        : Response.json({ detail: [{ type: 'audio_duration_too_short' }] }, { status: 422 });
    } };
  let task = input();
  task.narration = await createNarrationService({ FAL_KEY: 'test' }, options).prepare(task, folder);
  task.narration.segments.push({ start: 0, end: 5, text: '已完成', id: 'already-paid', status: 'ready' });
  const advance = async () => {
    if (saved) task = JSON.parse(saved);
    const service = createNarrationService({ FAL_KEY: 'test' }, options);
    await service.advance(task, folder, null, async () => { saved = JSON.stringify(task); });
  };
  await advance(); assert.equal(posts, 1);
  await assert.rejects(advance(), { code: 'VIDEO_NARRATION_PENDING' });
  await assert.rejects(advance(), { code: 'VIDEO_NARRATION_PENDING' }); assert.equal(posts, 1);
  clock += 30_000; await advance(); assert.equal(posts, 2);
  if (succeeds) {
    await advance(); assert.equal(task.narration.segments[0].status, 'ready');
    await advance(); assert.equal(posts, 2);
  } else {
    await assert.rejects(advance(), { code: 'VIDEO_NARRATION_PENDING' });
    clock += 30_000; await advance(); assert.equal(posts, 3);
    await assert.rejects(advance(), { code: 'VIDEO_NARRATION_WAITING', recoveryAction: 'limit' });
    clock += 60_000;
    await assert.rejects(advance(), { code: 'VIDEO_NARRATION_WAITING', recoveryAction: 'limit' });
    assert.equal(posts, 3);
  }
  assert.equal(task.narration.segments[1].id, 'already-paid');
  assert.equal(task.narration.segments[1].status, 'ready');
  assert.ok(task.narration.segments[0].previousJobs.length >= 1);
  assert.equal(task.narration.segments[0].diagnostic.reason, 'audio_duration_too_short');
});

test('a lost paid submission receipt is recovered from one exact match and settles one cost record', async t => {
  let credits;
  const folder = await source(t, 6, 6, () => credits?.close());
  credits = createCreditsLedger({ storageDir: join(folder, 'credits'), databaseUrl: null, costMode: true }); await credits.ready;
  const scope = { userId: 'alice', taskId: 'lost-narration' };
  await credits.reserveCost(scope);
  const id = '01a1595c-1374-7d52-a73a-591b2dcae36f';
  let posts = 0, submitted, saved, ambiguous = true;
  const meter = createApiCostMeter({ credits, prices: { fal: async () => ({ unit_price: 0.001, fx: 1 }) },
    fetchImpl: async (url, options) => {
      if (new URL(url).hostname === 'api.fal.ai') {
        const item = { endpoint_id: endpoint, request_id: id, json_input: submitted };
        return Response.json({ items: ambiguous ? [item, item] : [item], has_more: false });
      }
      if (options.method === 'POST') { posts++; submitted = JSON.parse(options.body); throw new Error('receipt lost'); }
      if (String(url).endsWith('/status')) return Response.json({ status: 'COMPLETED' });
      return Response.json({ audio: { url: 'https://fal.media/output.wav' } }, { headers: { 'x-fal-billable-units': '10' } });
    } });
  const options = { detect, upload, fetchImpl: meter.fetch, recoverReceipt: meter.recoverFalRequest, download: async () => {} };
  let task = input(); task.narration = await createNarrationService({ FAL_KEY: 'test' }, options).prepare(task, folder);
  const advance = () => meter.run(scope, () => createNarrationService({ FAL_KEY: 'test' }, options).advance(
    task, folder, null, async () => { saved = JSON.stringify(task); }));
  await assert.rejects(advance(), { code: 'VIDEO_NARRATION_PENDING' });
  task = JSON.parse(saved);
  await assert.rejects(advance(), { code: 'VIDEO_NARRATION_PENDING' }); assert.equal(posts, 1);
  ambiguous = false; await advance();
  assert.equal(task.narration.segments[0].status, 'ready'); assert.equal(task.narration.segments[0].id, id);
  assert.equal(posts, 1);
  const settled = await credits.settleCost(scope);
  assert.equal(Object.keys(settled.costItems).length, 1); assert.equal(settled.settledUnits, 10_000);
  assert.equal(Object.values(settled.costItems)[0].providerRequestId, id);
  assert.doesNotMatch(JSON.stringify(Object.values(settled.costItems)[0].metadata), /fal\.media/);
});

test('failed-result billing uses the provider usage header, and never assumes a failed request was free', async t => {
  let credits;
  const folder = await source(t, 6, 6, () => credits?.close());
  credits = createCreditsLedger({ storageDir: join(folder, 'credits'), databaseUrl: null, costMode: true }); await credits.ready;
  const scope = { userId: 'alice', taskId: 'failed-cost' }; await credits.reserveCost(scope);
  let header = false;
  const meter = createApiCostMeter({ credits, prices: { fal: async () => ({ unit_price: 0.001, fx: 1 }) },
    fetchImpl: async (_url, options) => options.method === 'POST' ? Response.json(receipt('failed-paid'))
      : Response.json({ detail: [] }, { status: 422, headers: header ? { 'x-fal-billable-units': '0' } : {} }) });
  await meter.run(scope, () => meter.fetch(`https://queue.fal.run/${endpoint}`, { method: 'POST', body: JSON.stringify({ prompt: '台词' }) }));
  await meter.run(scope, () => meter.fetch(receipt('failed-paid').response_url));
  assert.equal(Object.values((await credits.reservation('alice', scope.taskId)).costItems)[0].status, 'uncertain');
  header = true; await meter.run(scope, () => meter.fetch(receipt('failed-paid').response_url));
  assert.equal((await credits.settleCost(scope)).chargedPoints, 0);
});

test('reference transfers retry before dispatch, and an account rejection never loops paid generation', async t => {
  const folder = await source(t); let transfers = 0, posts = 0;
  const service = createNarrationService({ FAL_KEY: 'test' }, { detect,
    upload: async file => { if (basename(file).startsWith('emotion') && transfers++ === 0) throw new Error('network'); return upload(file); },
    fetchImpl: async () => { posts++; return Response.json({}, { status: 402 }); },
  });
  const task = input(); task.narration = await service.prepare(task, folder);
  const advance = () => service.advance(task, folder, null, async () => {});
  await assert.rejects(advance(), { code: 'VIDEO_NARRATION_PENDING' }); assert.equal(posts, 0);
  await assert.rejects(advance(), { code: 'VIDEO_NARRATION_WAITING', recoveryAction: 'account' });
  await assert.rejects(advance(), { code: 'VIDEO_NARRATION_WAITING', recoveryAction: 'account' });
  assert.equal(posts, 1);
});
