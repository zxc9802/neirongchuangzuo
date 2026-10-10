import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createNarrationService, muxNarration } from '../services/video/narration.mjs';
import { createLipsyncService } from '../services/video/lipsync.mjs';
import { createProviderStorage } from '../services/video/provider-storage.mjs';

const pcm = (input, start, duration) => execFileSync('ffmpeg', ['-v', 'error', '-ss', String(start), '-i', input,
  '-t', String(duration), '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1']);
const rms = bytes => Math.sqrt(Array.from({ length: bytes.length / 4 }, (_, i) => bytes.readFloatLE(i * 4) ** 2).reduce((a, b) => a + b, 0) / (bytes.length / 4));

test('IndexTTS uses uploaded timbre and per-segment source emotion, at most three jobs, with timed silence and exact final audio mapping', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'replica-narration-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const source = join(folder, 'source.mp4'), wav = join(folder, 'fixture.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=black:s=160x240:r=30:d=6',
    '-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', '-c:v', 'libx264', '-c:a', 'aac', source]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=1', '-ar', '24000', wav]);
  const requests = [], events = [];
  const uploads = [];
  const service = createNarrationService({ INDEXTTS_302_API_KEY: 'unit-test-key' }, {
    upload: async input => { uploads.push(input); return `https://fal.media/${basename(input)}`; },
    fetchImpl: async (url, options) => {
      if (options.method === 'POST') { const body = JSON.parse(options.body); requests.push(body); return Response.json({ task_id: `speech-${requests.length}` }); }
      events.push(String(url)); return Response.json({ state: 'SUCCESS', audio_url: 'https://file.302.ai/unit.wav' });
    },
    download: async (_url, output) => writeFile(output, await readFile(wav)), detect: async () => [{ start: 0.1, end: 0.9 }],
  });
  const task = { duration: 6, actualDuration: 6, video: { audio: true }, speech: { segments: Array.from({ length: 5 }, (_, i) => ({ start: i + 0.25, end: i + 0.75, text: `第${i}句` })) } };
  task.narration = await service.prepare(task, folder);
  const advance = () => service.advance(task, folder, kind => `https://workspace.example/${kind}`, async () => {});
  await advance(); assert.equal(requests.length, 3); assert.equal(events.length, 0);
  await advance(); await advance(); assert.equal(requests.length, 5); assert.equal(task.narration.ready, false);
  await advance(); assert.equal(task.narration.ready, true);
  await advance(); assert.equal(requests.length, 5); assert.equal(events.length, 5);
  for (const [i, body] of requests.entries()) {
    assert.equal(body.speaker_audio_url, 'https://fal.media/reference.wav');
    assert.equal(body.emotion_audio_url, `https://fal.media/emotion-${i}.wav`); assert.equal(body.emotion_alpha, 0.8);
    assert.equal(body.text, `第${i}句`);
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
  const service = createNarrationService({ INDEXTTS_API_KEY: 'test' }, { upload: async () => 'https://fal.media/reference.wav', fetchImpl: async () => { posts++; throw new Error('Lost response'); } });
  const task = { video: { audio: false }, narration: { ready: false, segments: [{ start: 0, end: 1, text: '你好' }] } };
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

test('reloaded pending TTS jobs retain their ID across transient query failures and never resubmit', async () => {
  const saved = JSON.stringify({ actualDuration: 4, narration: { ready: false,
    segments: [{ id: 'already-paid-speech', status: 'pending', start: 1, end: 2, text: '你好' }] } });
  const task = JSON.parse(saved); let gets = 0;
  const service = createNarrationService({ INDEXTTS_API_KEY: 'test' }, { fetchImpl: async (url, options) => {
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
  const task = { video: { audio: false }, narration: { ready: false, segments: [{ start: 0, end: 1, text: '你好' }] } };
  let posts = 0;
  const service = createNarrationService({ INDEXTTS_API_KEY: 'test' }, {
    upload: async () => { const error = new Error('Transfer outage'); error.code = 'VIDEO_NARRATION_PENDING'; throw error; },
    fetchImpl: async () => { posts++; return Response.json({ task_id: 'unexpected' }); },
  });
  await assert.rejects(service.advance(task, '/unused', () => {}, async () => {}), { code: 'VIDEO_NARRATION_PENDING' });
  assert.equal(posts, 0); assert.equal(task.narration.segments[0].status, undefined);
});
