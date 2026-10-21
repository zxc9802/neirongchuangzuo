import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTranscriptionService, TRANSCRIPTION_MODEL } from '../services/video/transcription.mjs';
import { createSpeechService, speechConfig, speechTimeline } from '../services/video/speech.mjs';
import { createApiCostMeter } from '../services/credits/meter.mjs';

const QUEUE = 'https://queue.fal.run/fal-ai/elevenlabs/requests/asr-1';
const RESULT = { text: '你好。[笑声]世界', language_code: 'zho', words: [
  { text: '你好', type: 'word', start: 1, end: 1.5 },
  { text: '。', type: 'word', start: 1.5, end: 1.5 },
  { text: '[笑声]', type: 'audio_event', start: 1.6, end: 1.7 },
  { text: '世界', type: 'word', start: 2, end: 2.5 },
] };
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'video-transcription-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const audio = join(root, 'source.wav'), checkpoint = join(root, 'source.asr.json');
  await copyFile(new URL('./fixtures/replica-speech.wav', import.meta.url), audio);
  const calls = [];
  const fetchImpl = async (value, options = {}) => {
    const url = String(value); calls.push({ url, ...options });
    if (url.startsWith('https://rest.fal.ai/storage/')) return Response.json({
      upload_url: 'https://upload.fal.media/audio.wav', file_url: 'https://fal.media/audio.wav',
    });
    if (url === 'https://upload.fal.media/audio.wav') {
      assert.equal(options.headers.Authorization, undefined);
      return new Response('');
    }
    assert.equal(options.headers.Authorization, 'Key fal-test');
    if (options.method === 'POST') {
      assert.equal(url, `https://queue.fal.run/${TRANSCRIPTION_MODEL}`);
      assert.deepEqual(JSON.parse(options.body), { audio_url: 'https://fal.media/audio.wav', tag_audio_events: false, diarize: false });
      return overrides.submit ? overrides.submit() : Response.json({
        request_id: 'asr-1', status_url: QUEUE + '/status', response_url: QUEUE,
      });
    }
    if (url === QUEUE + '/status') return overrides.status ? overrides.status() : Response.json({ status: 'COMPLETED' });
    assert.equal(url, QUEUE);
    return overrides.result ? overrides.result() : Response.json(RESULT, { headers: { 'x-fal-billable-units': '0.25' } });
  };
  const env = { FAL_KEY: 'fal-test', VIDEO_PYTHON_BIN: 'missing-vad-python' };
  return { audio, checkpoint, env, fetchImpl, calls, service: createTranscriptionService(env, fetchImpl) };
}

test('Scribe reuses fal key aliases and ignores old transcription credentials', () => {
  for (const name of ['FAL_KEY', 'FAL_API_KEY', 'VIDEO_FAL_KEY']) {
    const env = { [name]: 'fal', VIDEO_TRANSCRIPTION_API_KEY: 'old' };
    assert.equal(createTranscriptionService(env).enabled, true);
    assert.equal(speechConfig(env).key, 'fal');
  }
  assert.equal(speechConfig({ FAL_KEY: 'first', FAL_API_KEY: 'second', VIDEO_FAL_KEY: 'third' }).key, 'first');
  assert.equal(createTranscriptionService({ VIDEO_TRANSCRIPTION_API_KEY: 'old', INDEXTTS_302_API_KEY: 'old' }).enabled, false);
});

test('Scribe returns timestamps, caches results and does not resend after restart', async t => {
  const app = await fixture(t);
  assert.deepEqual(await app.service.transcribe(app.audio, app.checkpoint), RESULT);
  assert.deepEqual(await createTranscriptionService(app.env, app.fetchImpl).transcribe(app.audio, app.checkpoint), RESULT);
  assert.equal(app.calls.filter(call => call.url.endsWith(TRANSCRIPTION_MODEL)).length, 1);
  assert.equal(app.calls.filter(call => call.url === QUEUE).length, 1);
  assert.doesNotMatch(await readFile(app.checkpoint, 'utf8'), /fal-test/);
  await writeFile(app.audio, 'different upload');
  await app.service.transcribe(app.audio, app.checkpoint);
  assert.equal(app.calls.filter(call => call.url.endsWith(TRANSCRIPTION_MODEL)).length, 2);
});

test('pending and temporary query failures resume the same paid request', async t => {
  let statusCalls = 0;
  const app = await fixture(t, { status: () => ++statusCalls === 1 ? Response.json({ status: 'IN_QUEUE' })
    : statusCalls === 2 ? new Response('', { status: 503 }) : Response.json({ status: 'COMPLETED' }) });
  for (let i = 0; i < 2; i++) await assert.rejects(
    createTranscriptionService(app.env, app.fetchImpl).transcribe(app.audio, app.checkpoint), { code: 'VIDEO_TRANSCRIPTION_PENDING' });
  assert.deepEqual(await app.service.transcribe(app.audio, app.checkpoint), RESULT);
  assert.equal(app.calls.filter(call => call.url.endsWith(TRANSCRIPTION_MODEL)).length, 1);
});

test('an uncertain submission is never automatically repeated after restart', async t => {
  const app = await fixture(t, { submit: () => { throw new Error('network timeout with secret'); } });
  for (let i = 0; i < 2; i++) await assert.rejects(
    createTranscriptionService(app.env, app.fetchImpl).transcribe(app.audio, app.checkpoint),
    cause => cause.code === 'VIDEO_TRANSCRIPTION_UNCERTAIN' && !cause.message.includes('secret'));
  assert.equal(app.calls.filter(call => call.url.endsWith(TRANSCRIPTION_MODEL)).length, 1);
});

for (const status of [401, 402, 403, 422]) test(`Scribe HTTP ${status} is actionable without leaking upstream details`, async t => {
  const app = await fixture(t, { submit: () => new Response('private credentials', { status }) });
  for (let i = 0; i < 2; i++) await assert.rejects(app.service.transcribe(app.audio, app.checkpoint),
    cause => cause.code === 'VIDEO_TRANSCRIPTION_FAILED' && cause.message.includes(`HTTP ${status}`) && !cause.message.includes('private'));
  assert.equal(app.calls.filter(call => call.url.endsWith(TRANSCRIPTION_MODEL)).length, 1);
});

test('Scribe never forwards credentials to foreign or unrelated queue URLs', async t => {
  const app = await fixture(t, { submit: () => Response.json({
    request_id: 'asr-1', status_url: 'https://evil.example/status', response_url: QUEUE,
  }) });
  await assert.rejects(app.service.transcribe(app.audio, app.checkpoint), /任务地址/);
  assert.equal(app.calls.some(call => call.url.includes('evil.example')), false);
  await assert.rejects(app.service.transcribe(app.audio, app.checkpoint), { code: 'VIDEO_TRANSCRIPTION_UNCERTAIN' });
});

test('Scribe word timing reaches narration without reading audio-event labels aloud', async t => {
  const app = await fixture(t);
  const service = createSpeechService(app.env, app.fetchImpl);
  const diagnosticPath = join(app.audio + '.diagnostic.json');
  const speech = await service.analyze(app.audio, 5, { diagnosticsPath: diagnosticPath });
  assert.equal(speech.engine, 'silero-vad+scribe-v2');
  assert.equal(speech.language, 'zh');
  assert.equal(speech.text, '你好。世界');
  assert.equal(speech.start, 1); assert.equal(speech.end, 2.5);
  const diagnostic = JSON.parse(await readFile(diagnosticPath, 'utf8'));
  assert.deepEqual(diagnostic.asr.words.map(word => [word.word, word.start, word.end]), [['你好', 1, 1.5], ['。', 1.5, 1.5], ['世界', 2, 2.5]]);
  await assert.rejects(readFile(app.audio + '.asr.wav'), { code: 'ENOENT' });
});

for (const [code, language, text] of [['eng', 'en', 'Hello world'], ['msa', 'ms', 'Selamat datang']]) {
  test(`Scribe preserves ${language} word spacing and language confidence`, async t => {
    const [first, second] = text.split(' ');
    const app = await fixture(t, { result: () => Response.json({ text, language_code: code, language_probability: .99,
      words: [{ text: first, type: 'word', start: 1, end: 1.5 }, { text: ' ', type: 'spacing', start: 1.5, end: 1.5 },
        { text: second, type: 'word', start: 2, end: 2.5 }] }) });
    const speech = await createSpeechService(app.env, app.fetchImpl).analyze(app.audio, 5);
    assert.equal(speech.text, text); assert.equal(speech.language, language); assert.equal(speech.languageConfidence, .99);
  });
}

test('Scribe zero-duration final characters stay before the original speech pause', () => {
  const timeline = speechTimeline({ words: [
    { word: '吃', start: 3.58, end: 3.74 }, { word: '的', start: 3.74, end: 3.74 },
    { word: '。', start: 3.74, end: 3.74 },
    { word: '因', start: 4.52, end: 4.64 }, { word: '为', start: 4.64, end: 4.64 },
    { word: '味', start: 5.54, end: 5.7 }, { word: '道', start: 5.7, end: 5.86 },
  ] }, [{ start: 3.5, end: 3.968 }, { start: 4.448, end: 5.184 }, { start: 5.504, end: 6.4 }], 7);
  assert.deepEqual(timeline.segments.map(segment => segment.text), ['吃的', '因为', '味道']);
  assert.deepEqual(timeline.segments[0].words, [{ word: '吃的', start: 3.58, end: 3.74 }]);
  assert.equal(timeline.text, '吃的因为味道');
});

test('Scribe requests use the existing actual-cost receipt accounting once', async t => {
  const app = await fixture(t);
  let item, prepared = 0, settled;
  const credits = { costMode: true,
    prepareCostCall: async data => { prepared++; item = data; },
    finishCostCall: async data => { item = { ...item, ...data }; if (data.costCny !== undefined) settled = data.costCny; return {}; },
    reservation: async () => ({ costItems: { [item.receiptId]: { ...item, status: settled === undefined ? 'pending' : 'completed' } } }),
  };
  const meter = createApiCostMeter({ credits, fetchImpl: app.fetchImpl, prices: { fal: async model => {
    assert.equal(model, TRANSCRIPTION_MODEL); return { unit_price: .008, fx: 7 };
  } } });
  const service = createTranscriptionService(app.env, meter.fetch);
  await meter.run({ userId: 'alice', taskId: 'replica' }, () => service.transcribe(app.audio, app.checkpoint));
  assert.equal(prepared, 1); assert.equal(settled, .25 * .008 * 7);
  await meter.run({ userId: 'alice', taskId: 'replica' }, () => service.transcribe(app.audio, app.checkpoint));
  assert.equal(prepared, 1);
});
