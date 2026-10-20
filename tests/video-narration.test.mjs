import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createNarrationService, muxNarration } from '../services/video/narration.mjs';
import { createLipsyncService } from '../services/video/lipsync.mjs';
import { createProviderStorage } from '../services/video/provider-storage.mjs';
import { loadWorkspaceSettings } from '../services/runtime-settings.mjs';
import { createApiCostMeter } from '../services/credits/meter.mjs';
import { createCreditsLedger } from '../services/credits/store.mjs';

const pcm = (input, start, duration) => execFileSync('ffmpeg', ['-v', 'error', '-ss', String(start), '-i', input,
  '-t', String(duration), '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1']);
const rms = bytes => Math.sqrt(Array.from({ length: bytes.length / 4 }, (_, i) => bytes.readFloatLE(i * 4) ** 2).reduce((a, b) => a + b, 0) / (bytes.length / 4));
const falJob = id => ({ request_id: id,
  status_url: `https://queue.fal.run/fal-ai/index-tts-2/requests/${id}/status`,
  response_url: `https://queue.fal.run/fal-ai/index-tts-2/requests/${id}` });

test('billing rejection before a paid call is reported without claiming an uncertain TTS or lip-sync submission', async () => {
  const fetchImpl = async () => { throw Object.assign(new Error('积分不足，未发送付费请求。'), { providerNotDispatched: true }); };
  const narration = createNarrationService({ FAL_KEY: 'test' }, { fetchImpl, upload: async () => 'https://fal.media/voice.wav' });
  const task = { video: { audio: false }, narration: { provider: 'fal', ready: false, segments: [{ start: 0, end: 1, text: '你好' }] } };
  await assert.rejects(narration.advance(task, 'unused', () => '', async () => {}), { code: 'VIDEO_NARRATION_FAILED', message: '积分不足，未发送付费请求。' });
  const lipsync = createLipsyncService({ FAL_KEY: 'test' }, fetchImpl);
  await assert.rejects(lipsync.submit('https://fal.media/video.mp4', 'https://fal.media/voice.wav'), { code: 'VIDEO_LIPSYNC_FAILED', message: '积分不足，未发送付费请求。' });
});

test('IndexTTS uses uploaded timbre and per-segment source emotion, at most three jobs, with timed silence and exact final audio mapping', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'replica-narration-'));
  t.after(async () => { await credits.close(); await rm(folder, { recursive: true, force: true }); });
  const source = join(folder, 'source.mp4'), wav = join(folder, 'fixture.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=black:s=160x240:r=30:d=6',
    '-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', '-c:v', 'libx264', '-c:a', 'aac', source]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=1', '-ar', '24000', wav]);
  const requests = [], events = [];
  const uploads = [];
  const credits = createCreditsLedger({ storageDir: join(folder, 'credits'), databaseUrl: null, costMode: true });
  await credits.ready;
  const scope = { userId: 'alice', taskId: 'pixverse-narration' }; await credits.reserveCost(scope);
  const meter = createApiCostMeter({ credits, prices: { fal: async () => ({ unit_price: 0.001, fx: 1 }) },
    fetchImpl: async (url, options) => {
      assert.equal(options.headers.Authorization, 'Key unit-test-key');
      if (options.method === 'POST') {
        assert.equal(String(url), 'https://queue.fal.run/fal-ai/index-tts-2/text-to-speech');
        const body = JSON.parse(options.body); requests.push(body); return Response.json(falJob(`speech-${requests.length}`));
      }
      events.push(String(url)); return Response.json(String(url).endsWith('/status') ? { status: 'COMPLETED' } : { audio: { url: 'https://v3.fal.media/unit.wav' } },
        { headers: { 'x-fal-billable-units': '10' } });
    },
  });
  const service = createNarrationService({ FAL_KEY: 'unit-test-key', INDEXTTS_302_API_KEY: 'legacy-key' }, {
    upload: async input => { uploads.push(input); return `https://fal.media/${basename(input)}`; }, fetchImpl: meter.fetch,
    download: async (_url, output) => writeFile(output, await readFile(wav)), detect: async () => [{ start: 0.1, end: 0.9 }],
  });
  const task = { duration: 6, actualDuration: 6, video: { audio: true }, speech: { segments: Array.from({ length: 5 }, (_, i) => ({ start: i + 0.25, end: i + 0.75, text: `第${i}句` })) } };
  task.narration = await service.prepare(task, folder);
  assert.equal(task.narration.provider, 'fal');
  const advance = () => meter.run(scope, () => service.advance(task, folder, kind => `https://workspace.example/${kind}`, async () => {}));
  await advance(); assert.equal(requests.length, 3); assert.equal(events.length, 0);
  await advance(); await advance(); assert.equal(requests.length, 5); assert.equal(task.narration.ready, false);
  await advance(); assert.equal(task.narration.ready, true);
  await advance(); assert.equal(requests.length, 5); assert.equal(events.length, 10);
  const settled = await credits.settleCost(scope);
  assert.equal(Object.keys(settled.costItems).length, 5);
  assert.equal(settled.settledUnits, 50_000); assert.equal(settled.chargedPoints, 7);
  assert.ok(Object.values(settled.costItems).every(item => item.metadata.model === 'fal-ai/index-tts-2/text-to-speech'));
  for (const [i, body] of requests.entries()) {
    assert.deepEqual(body, { audio_url: 'https://fal.media/reference.wav',
      emotional_audio_url: `https://fal.media/emotion-${i}.wav`, strength: 0.8, prompt: `第${i}句`, should_use_prompt_for_emotion: false });
  }
  assert.equal(uploads.filter(input => input.endsWith('reference.wav')).length, 1, 'The shared voice must be uploaded once and reused');
  assert.equal(uploads.length, 6);
  const output = join(folder, 'result.mp4'); await muxNarration(source, join(folder, 'narration.wav'), output, 6);
  for (let i = 0; i < 5; i++) {
    assert.ok(rms(pcm(output, i + 0.35, 0.1)) > 0.05);
    assert.ok(rms(pcm(output, i + 0.85, 0.1)) < 0.002);
  }
  assert.ok(rms(pcm(output, 5.2, 0.5)) < 0.002);
  const frames = input => execFileSync('ffmpeg', ['-v', 'error', '-i', input, '-map', '0:v', '-c', 'copy', '-f', 'hash', 'pipe:1']).toString();
  assert.equal(frames(output), frames(source));
  const tone = pcm(output, 0.35, 0.2), correlate = frequency => Math.abs(Array.from({ length: tone.length / 4 }, (_, i) => tone.readFloatLE(i * 4) * Math.sin(2 * Math.PI * frequency * i / 16000)).reduce((a, b) => a + b, 0));
  assert.ok(correlate(880) > correlate(220) * 20, 'Final audio must be new narration, not the input video audio');
});

test('an uncertain TTS submission is persisted and never automatically paid for again', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'replica-tts-uncertain-')); t.after(() => rm(folder, { recursive: true, force: true }));
  let posts = 0;
  const service = createNarrationService({ FAL_KEY: 'test' }, { upload: async () => 'https://fal.media/reference.wav', fetchImpl: async () => { posts++; throw new Error('Lost response'); } });
  const task = { video: { audio: false }, narration: { provider: 'fal', ready: false, segments: [{ start: 0, end: 1, text: '你好' }] } };
  const advance = () => service.advance(task, folder, kind => `https://workspace.example/${kind}`, async () => {});
  await assert.rejects(advance(), { code: 'VIDEO_NARRATION_UNCERTAIN' });
  assert.equal(task.narration.segments[0].status, 'submitting');
  await assert.rejects(advance(), { code: 'VIDEO_NARRATION_UNCERTAIN' }); assert.equal(posts, 1);
});

test('lip-sync receives the generated video and IndexTTS audio, polls the same queue, and rejects foreign credential destinations', async () => {
  const calls = [];
  const service = createLipsyncService({ FAL_KEY: 'test' }, async (url, options) => {
    calls.push({ url, options });
    return Response.json(options.method === 'POST' ? { request_id: 'mouth', status_url: 'https://queue.fal.run/veed/lipsync/requests/mouth/status', response_url: 'https://queue.fal.run/veed/lipsync/requests/mouth' }
      : String(url).endsWith('/status') ? { status: 'COMPLETED' } : { video: { url: 'https://fal.media/mouth.mp4' } });
  });
  const job = await service.submit('https://workspace.example/generated', 'https://workspace.example/narration');
  assert.deepEqual(JSON.parse(calls[0].options.body), { video_url: 'https://workspace.example/generated', audio_url: 'https://workspace.example/narration' });
  assert.equal(await service.query(job), 'https://fal.media/mouth.mp4'); assert.equal(calls.length, 3);
  await assert.rejects(service.query({ statusUrl: 'https://attacker.example/steal' }), { code: 'VIDEO_LIPSYNC_FAILED' }); assert.equal(calls.length, 3);
});

test('legacy 302 TTS jobs retain their ID and provider across transient query failures and never resubmit', async () => {
  const saved = JSON.stringify({ actualDuration: 4, narration: { ready: false,
    segments: [{ id: 'already-paid-speech', status: 'pending', start: 1, end: 2, text: '你好' }] } });
  const task = JSON.parse(saved); let gets = 0;
  const service = createNarrationService({ INDEXTTS_API_KEY: 'test', FAL_KEY: 'new-key' }, { fetchImpl: async (url, options) => {
    assert.equal(new URL(url).origin, 'https://api.302.ai'); assert.equal(options.headers.Authorization, 'Bearer test');
    assert.equal(options.method, 'GET'); assert.equal(new URL(url).searchParams.get('task_id'), 'already-paid-speech');
    if (++gets === 1) throw new Error('Temporary gateway outage'); return Response.json({ state: 'PENDING' });
  } });
  const advance = () => service.advance(task, '/unused', () => assert.fail('No new paid submission'), async () => {});
  await assert.rejects(advance(), { code: 'VIDEO_NARRATION_PENDING' }); await advance();
  assert.equal(gets, 2); assert.equal(task.narration.segments[0].id, 'already-paid-speech'); assert.equal(task.narration.ready, false);
});

test('confirmed reference-download timeout retries at most five times and keeps failed job IDs', async () => {
  const task = { video: { audio: true }, narration: { ready: false, segments: [{ id: 'failed-0', status: 'pending', start: 0, end: 1, text: '你好' }] } };
  let posts = 0;
  const service = createNarrationService({ INDEXTTS_API_KEY: 'test' }, { upload: async () => 'https://fal.media/reference.wav', fetchImpl: async (_url, options) => {
    if (options.method === 'POST') return Response.json({ task_id: `failed-${++posts}` });
    return Response.json({ state: 'FAILURE', error: { detail: 'Failed to download reference file: Read timed out.' } });
  } });
  const advance = () => service.advance(task, '/unused', kind => `https://workspace.example/${kind}`, async () => {});
  for (let i = 0; i < 5; i++) { await advance(); await advance(); }
  await assert.rejects(advance(), { code: 'VIDEO_NARRATION_FAILED' });
  assert.equal(posts, 5); assert.equal(task.narration.segments[0].downloadRetries, 5);
  assert.deepEqual(task.narration.segments[0].previousIds, ['failed-0', 'failed-1', 'failed-2', 'failed-3', 'failed-4']);
});

test('a confirmed reference SSL download failure retries rather than blaming the uploaded voice', async () => {
  const task = { video: { audio: true }, narration: { ready: false,
    segments: [{ id: 'failed-tls', status: 'pending', start: 0, end: 1, text: '你好' }] } };
  const service = createNarrationService({ INDEXTTS_API_KEY: 'test' }, { fetchImpl: async () => Response.json({
    state: 'FAILURE', error: { message: 'Synthesis failed', detail: "Failed to download file from https://workspace.example/voice (Caused by SSLError(SSLEOFError(8, '[SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol (_ssl.c:1007)')))" },
  }) });
  await service.advance(task, '/unused', () => assert.fail('No submission while inspecting a failed job'), async () => {});
  assert.equal(task.narration.segments[0].downloadRetries, 1);
  assert.deepEqual(task.narration.segments[0].previousIds, ['failed-tls']);
  assert.equal(task.narration.segments[0].id, undefined);
});

test('provider inputs are uploaded with expiry and storage credentials never reach file hosts', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'replica-storage-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const input = join(folder, 'reference.wav'); await writeFile(input, 'REFERENCE_AUDIO');
  const calls = [];
  const storage = createProviderStorage({ FAL_KEY: 'test-key' }, async (url, options) => {
    calls.push({ url, options });
    return options.method === 'POST' ? Response.json({ upload_url: 'https://v3-uploads.fal.media/upload', file_url: 'https://v3.fal.media/reference.wav' }) : new Response('', { status: 200 });
  });
  assert.equal(await storage.upload(input, 'audio/wav'), 'https://v3.fal.media/reference.wav');
  assert.equal(calls[0].options.headers.Authorization, 'Key test-key');
  assert.equal(JSON.parse(calls[0].options.headers['X-Fal-Object-Lifecycle']).expiration_duration_seconds, 259200);
  assert.equal(calls[1].options.headers.Authorization, undefined);
  assert.equal(calls[1].options.body.toString(), 'REFERENCE_AUDIO');
  let puts = 0;
  const invalid = createProviderStorage({ FAL_KEY: 'test-key' }, async (_url, options) => {
    if (options.method === 'PUT') puts++;
    return Response.json({ upload_url: 'https://attacker.example/upload', file_url: 'https://v3.fal.media/reference.wav' });
  });
  await assert.rejects(invalid.upload(input, 'audio/wav'), { code: 'VIDEO_NARRATION_PENDING' }); assert.equal(puts, 0);
});

test('an input transfer failure is retriable and occurs before paid synthesis submission', async () => {
  const task = { video: { audio: false }, narration: { provider: 'fal', ready: false, segments: [{ start: 0, end: 1, text: '你好' }] } };
  let posts = 0;
  const service = createNarrationService({ FAL_KEY: 'test' }, {
    upload: async () => { const error = new Error('Transfer outage'); error.code = 'VIDEO_NARRATION_PENDING'; throw error; },
    fetchImpl: async () => { posts++; return Response.json({ task_id: 'unexpected' }); },
  });
  await assert.rejects(service.advance(task, '/unused', () => {}, async () => {}), { code: 'VIDEO_NARRATION_PENDING' });
  assert.equal(posts, 0); assert.equal(task.narration.segments[0].status, undefined);
});

test('new narration requires fal credentials and accepts the same aliases as lip-sync', () => {
  assert.equal(createNarrationService({ INDEXTTS_API_KEY: 'old' }).enabled, false);
  for (const name of ['FAL_KEY', 'FAL_API_KEY', 'VIDEO_FAL_KEY']) assert.equal(createNarrationService({ [name]: 'test' }).enabled, true);
});

test('replica fal credentials load locally, environment overrides them, and production ignores local files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'replica-fal-env-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '.env.local'), 'VIDEO_FAL_KEY=local-key\n');
  const local = loadWorkspaceSettings({ root, env: {} });
  assert.equal(createNarrationService(local).enabled, true); assert.equal(createLipsyncService(local).enabled, true);
  assert.equal(loadWorkspaceSettings({ root, env: { VIDEO_FAL_KEY: 'env-key' } }).VIDEO_FAL_KEY, 'env-key');
  assert.equal(createNarrationService(loadWorkspaceSettings({ root, env: { NODE_ENV: 'production' } })).enabled, false);
});

test('fal queue receipts survive reload, polling errors and output download errors without another submission', async () => {
  let posts = 0, polls = 0, downloads = 0;
  const service = createNarrationService({ FAL_KEY: 'test' }, {
    upload: async () => 'https://fal.media/reference.wav',
    fetchImpl: async (url, options) => {
      if (options.method === 'POST') { posts++; return Response.json(falJob('paid')); }
      if (String(url).endsWith('/status')) {
        if (++polls === 1) throw new Error('Gateway outage');
        return Response.json({ status: polls === 2 ? 'IN_QUEUE' : 'COMPLETED' });
      }
      return Response.json({ audio: 'https://storage.googleapis.com/falserverless/result.mp3' });
    },
    download: async url => { assert.equal(url, 'https://storage.googleapis.com/falserverless/result.mp3'); if (++downloads === 1) throw new Error('Download outage'); },
    detect: async () => [{ start: 0.1, end: 0.9 }],
  });
  let task = { video: { audio: false }, narration: { provider: 'fal', ready: false, segments: [{ start: 0, end: 1, text: '你好' }] } };
  const advance = () => service.advance(task, '/unused', () => {}, async () => {});
  await advance(); task = JSON.parse(JSON.stringify(task));
  assert.equal(task.narration.segments[0].id, 'paid');
  await assert.rejects(advance(), { code: 'VIDEO_NARRATION_PENDING' }); await advance();
  await assert.rejects(advance(), { code: 'VIDEO_NARRATION_PENDING' }); await advance();
  assert.equal(posts, 1); assert.equal(downloads, 2); assert.equal(task.narration.segments[0].status, 'ready');
});

test('fal credentials never reach a foreign queue URL and untrusted output hosts are rejected', async () => {
  for (const invalid of ['queue', 'audio']) {
    let calls = 0, downloads = 0;
    const job = falJob('paid');
    const task = { narration: { provider: 'fal', ready: false, segments: [{ id: 'paid', status: 'pending',
      falQueue: { status: invalid === 'queue' ? 'https://attacker.example/status' : job.status_url, result: job.response_url } }] } };
    const service = createNarrationService({ FAL_KEY: 'test' }, {
      fetchImpl: async url => { calls++; return Response.json(String(url).endsWith('/status') ? { status: 'COMPLETED' } : { audio: { url: 'https://attacker.example/audio.wav' } }); },
      download: async () => { downloads++; },
    });
    await assert.rejects(service.advance(task, '/unused', () => {}, async () => {}), { code: 'VIDEO_NARRATION_FAILED' });
    assert.equal(calls, invalid === 'queue' ? 0 : 2); assert.equal(downloads, 0);
  }
});

test('fal terminal errors fail clearly and a missing receipt never triggers a second paid submission', async () => {
  for (const mode of ['failed', 'incomplete', 'rejected']) {
    let posts = 0;
    const task = { video: { audio: false }, narration: { provider: 'fal', ready: false, segments: [{ start: 0, end: 1, text: '你好' }] } };
    const service = createNarrationService({ FAL_KEY: 'test' }, {
      upload: async () => 'https://fal.media/reference.wav',
      fetchImpl: async (_url, options) => {
        if (options.method === 'POST') { posts++; return Response.json(mode === 'incomplete' ? { request_id: 'paid' } : falJob('paid'), { status: mode === 'rejected' ? 403 : 200 }); }
        return Response.json({ status: 'COMPLETED', error: 'Synthesis failed' });
      },
    });
    const advance = () => service.advance(task, '/unused', () => {}, async () => {});
    if (mode === 'failed') await advance();
    await assert.rejects(advance(), { code: mode === 'incomplete' ? 'VIDEO_NARRATION_UNCERTAIN' : 'VIDEO_NARRATION_FAILED' });
    await assert.rejects(advance()); assert.equal(posts, 1);
  }
});
