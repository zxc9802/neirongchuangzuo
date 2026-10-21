import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { languageRoute, normalizeLanguage, targetLanguage } from '../services/video/languages.mjs';
import { createHeygenLipsyncService } from '../services/video/heygen.mjs';
import { createLocalizationService, MULTILINGUAL_MODEL, TRANSLATION_MODEL, TRANSLATION_FALLBACK } from '../services/video/localization.mjs';
import { loadWorkspaceSettings } from '../services/runtime-settings.mjs';

test('only a confidently different language and an English/Malay target enables localization', () => {
  for (const source of ['zh', 'en', 'ms']) for (const target of ['zh', 'en', 'ms']) {
    assert.equal(languageRoute({ language: source, languageConfidence: .99, text: 'speech' }, target).translate,
      target !== 'zh' && source !== target, `${source} -> ${target}`);
  }
  for (const [value, expected] of [['eng', 'en'], ['EN-US', 'en'], ['msa', 'ms'], ['may', 'ms'], ['ms-MY', 'ms'], ['zho', 'zh'], ['cmn', 'zh']]) {
    assert.equal(normalizeLanguage(value), expected);
  }
  assert.equal(languageRoute({}, 'zh').translate, false);
  for (const speech of [{}, { language: 'und', text: 'speech' }, { language: 'en', text: '' }, { language: 'en', text: 'speech', languageConfidence: .4 }]) {
    assert.throws(() => languageRoute(speech, 'en'), { code: 'VIDEO_LANGUAGE_UNCERTAIN' });
  }
  assert.throws(() => targetLanguage('id'), { code: 'VIDEO_LANGUAGE_INVALID' });
});

test('HeyGen uses the official precision endpoint, keeps duration and polls the saved job', async () => {
  const calls = [];
  const service = createHeygenLipsyncService({ VIDEO_HEYGEN_API_KEY: 'private-key', HEYGEN_API_KEY: 'other-account' }, async (url, options) => {
    calls.push({ url, ...options });
    return Response.json({ data: options.method === 'POST' ? { lipsync_id: 'ls_123' }
      : calls.length === 2 ? { status: 'running' } : { status: 'completed', video_url: 'https://files.heygen.ai/test.mp4' } });
  });
  const job = await service.submit('https://fal.media/video.mp4', 'https://fal.media/audio.wav');
  assert.deepEqual(job, { id: 'ls_123', provider: 'heygen', model: 'precision' });
  assert.equal(await service.query(job), null); assert.equal(await service.query(job), 'https://files.heygen.ai/test.mp4');
  assert.equal(calls[0].url, 'https://api.heygen.com/v3/lipsyncs');
  assert.equal(calls[1].url, calls[0].url + '/ls_123');
  assert.equal(calls[0].headers['X-Api-Key'], 'private-key');
  const body = JSON.parse(calls[0].body);
  assert.equal(body.mode, 'precision'); assert.equal(body.enable_dynamic_duration, false);
  assert.equal(body.keep_the_same_format, true); assert.equal(body.fps_mode, 'passthrough');
  assert.equal(body.audio.url, 'https://fal.media/audio.wav');
});

test('HeyGen distinguishes rejected and uncertain paid submissions without disclosing provider details', async () => {
  for (const status of [402, 503]) {
    const service = createHeygenLipsyncService({ HEYGEN_API_KEY: 'private-key' }, async () => new Response('private provider body', { status }));
    await assert.rejects(service.submit('https://fal.media/v', 'https://fal.media/a'), cause =>
      (status === 402 ? cause.providerNotDispatched === true : cause.code === 'VIDEO_LIPSYNC_UNCERTAIN') && !cause.message.includes('private'));
  }
});

test('the replica-specific local Key overrides an unrelated global account and stays out of production config', async t => {
  const root = await mkdtemp(join(tmpdir(), 'heygen-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '.env.local'), 'VIDEO_HEYGEN_API_KEY=replica-key\n');
  const env = loadWorkspaceSettings({ root, env: { HEYGEN_API_KEY: 'other-account' } });
  const service = createHeygenLipsyncService(env, async (_url, options) => {
    assert.equal(options.headers['X-Api-Key'], 'replica-key');
    return Response.json({ data: { lipsync_id: 'ls_test' } });
  });
  await service.submit('https://fal.media/v', 'https://fal.media/a');
  assert.deepEqual(loadWorkspaceSettings({ root, env: { NODE_ENV: 'production' } }), { NODE_ENV: 'production' });
});

const SOURCE = { language: 'zh', languageConfidence: .99, text: '欢迎大家', segments: [{ start: 0, end: 4, text: '欢迎大家' }] };
async function fixture(t, language, overrides = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'localization-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const text = language === 'ms' ? 'Selamat datang semua.' : 'Welcome everyone.';
  const calls = [], queue = 'https://queue.fal.run/fal-ai/chatterbox/requests/tts-1';
  const fallbackQueue = `https://queue.fal.run/${TRANSLATION_FALLBACK}/requests/translation-1`;
  let saved;
  const task = { speech: structuredClone(SOURCE), targetLanguage: language, video: { duration: 5 } };
  const save = async () => { saved = JSON.stringify(task); };
  const service = createLocalizationService({ OPENLUX_API_KEY: 'translation-key', OPENLUX_CHAT_MODEL: 'unrelated-chat-model', FAL_KEY: 'tts-key' }, {
    upload: async () => 'https://fal.media/reference.wav',
    download: async (_url, output) => copyFile(new URL('./fixtures/replica-speech.wav', import.meta.url), output),
    detect: async () => [{ start: .2, end: 2.2 }],
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      if (url.endsWith('/chat/completions')) return overrides.translate ? overrides.translate()
        : Response.json({ choices: [{ message: { content: JSON.stringify({ language, segments: [{ text }] }) } }] });
      if (url === `https://queue.fal.run/${TRANSLATION_FALLBACK}`) return overrides.fallbackSubmit ? overrides.fallbackSubmit()
        : Response.json({ request_id: 'translation-1', status_url: fallbackQueue + '/status', response_url: fallbackQueue });
      if (url === fallbackQueue + '/status') return overrides.fallbackStatus ? overrides.fallbackStatus() : Response.json({ status: 'COMPLETED' });
      if (url === fallbackQueue) return overrides.fallbackResult ? overrides.fallbackResult()
        : Response.json({ output: JSON.stringify({ language, segments: [{ text }] }), partial: false, usage: { cost: .0000232 } });
      if (options.method === 'POST') return overrides.submit ? overrides.submit() : Response.json({ request_id: 'tts-1', status_url: queue + '/status', response_url: queue });
      if (url.endsWith('/status')) return Response.json({ status: 'COMPLETED' });
      return Response.json({ audio: { url: 'https://fal.media/speech.wav' } });
    },
  });
  return { service, task, folder, save, calls, text, saved: () => JSON.parse(saved) };
}

for (const language of ['en', 'ms']) test(`${language} translation and reference-voice synthesis resume without duplicate paid calls`, async t => {
  const app = await fixture(t, language);
  await app.service.advance(app.task, app.folder, app.save);
  assert.equal(app.task.localization.ready, false);
  const restored = app.saved();
  await app.service.advance(restored, app.folder, app.save);
  await app.service.advance(restored, app.folder, app.save);
  assert.equal(restored.localization.ready, true); assert.equal(restored.localization.text, app.text);
  const posts = app.calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 2); assert.equal(posts[1].url, 'https://queue.fal.run/' + MULTILINGUAL_MODEL);
  assert.equal(JSON.parse(posts[0].body).model, TRANSLATION_MODEL);
  assert.equal(restored.localization.translationProvider, 'openlux');
  assert.equal(restored.localization.translationFallback, undefined);
  const body = JSON.parse(posts[1].body);
  assert.equal(body.voice, 'https://fal.media/reference.wav'); assert.equal(body.custom_audio_language, language === 'ms' ? 'malay' : 'english');
  assert.equal(body.cfg_scale, 0);
  const wav = await readFile(join(app.folder, 'localized-voice.wav'));
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(app.folder, 'localized-voice.wav')], { encoding: 'utf8' })), 5);
  assert.equal(restored.localization.segments[0].end, 2);
  assert.doesNotMatch(JSON.stringify(restored), /translation-key|tts-key/);
});

test('matching language cannot submit localization even if called directly', async t => {
  const app = await fixture(t, 'en'); app.task.speech.language = 'eng';
  await assert.rejects(app.service.advance(app.task, app.folder, app.save), /无需翻译/);
  assert.equal(app.calls.length, 0);
});

test('Malay mislabelled as Indonesian is classified before routing and reuses the saved decision', async t => {
  const app = await fixture(t, 'ms');
  Object.assign(app.task.speech, { language: 'ind', languageConfidence: .65, text: 'Kalau mak ayah nak datang, saya cadangkan awak tunggu.' });
  await app.service.detectLanguage(app.task, app.save);
  await app.service.detectLanguage(app.task, app.save);
  assert.equal(languageRoute(app.task.speech, 'ms').translate, false);
  assert.equal(app.task.speech.languageConfidence, .65, 'Keep the original ASR evidence');
  assert.equal(app.task.languageDetection.asrLanguage, 'ind');
  assert.equal(app.calls.length, 1);
  await assert.rejects(app.service.advance(app.task, app.folder, app.save), /无需翻译/);
  assert.equal(app.calls.length, 1, 'No translation or TTS for matching Malay');
});

test('indistinguishable Malay/Indonesian pauses rather than guessing or resubmitting', async t => {
  const app = await fixture(t, 'ms', { translate: () => Response.json({ choices: [{ message: { content: '{"language":"unknown"}' } }] }) });
  Object.assign(app.task.speech, { language: 'ind', languageConfidence: .65 });
  for (let i = 0; i < 2; i++) await assert.rejects(app.service.detectLanguage(app.task, app.save), { code: 'VIDEO_LANGUAGE_UNCERTAIN' });
  assert.equal(app.calls.length, 1);
});

test('uncertain TTS submission is saved and never automatically submitted twice', async t => {
  const app = await fixture(t, 'ms', { submit: () => { throw new Error('timeout'); } });
  for (let i = 0; i < 2; i++) await assert.rejects(app.service.advance(app.task, app.folder, app.save), { code: 'VIDEO_LOCALIZATION_UNCERTAIN' });
  assert.equal(app.calls.filter(call => call.method === 'POST').length, 2);
});

for (const primaryFailure of ['http', 'timeout', 'invalid']) test(`primary ${primaryFailure} switches to the same model through fal once and resumes the saved job`, async t => {
  const app = await fixture(t, 'ms', { translate: () => {
    if (primaryFailure === 'timeout') throw new Error('private provider timeout');
    return primaryFailure === 'http' ? new Response('private provider error', { status: 503 })
      : Response.json({ choices: [{ message: { content: '{"language":"ms","segments":[null]}' } }] });
  } });
  await app.service.advance(app.task, app.folder, app.save);
  assert.equal(app.task.localization.translationFallback.id, 'translation-1');
  assert.equal(app.task.localization.segments, undefined, 'No TTS until fallback translation completes');
  const restored = app.saved();
  await app.service.advance(restored, app.folder, app.save);
  await app.service.advance(restored, app.folder, app.save);
  await app.service.advance(restored, app.folder, app.save);
  assert.equal(restored.localization.ready, true);
  assert.equal(restored.localization.translationProvider, 'fal-openrouter');
  const posts = app.calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 3, 'One primary, one fallback, one TTS');
  assert.equal(posts[1].url, `https://queue.fal.run/${TRANSLATION_FALLBACK}`);
  assert.equal(posts[1].headers.Authorization, 'Key tts-key');
  const body = JSON.parse(posts[1].body), primary = JSON.parse(posts[0].body);
  assert.equal(body.model, 'openai/gpt-6-luna');
  assert.equal(body.system_prompt, primary.messages[0].content);
  assert.equal(body.prompt, primary.messages[1].content);
  assert.equal(body.reasoning, false);
  assert.doesNotMatch(JSON.stringify(restored), /translation-key|tts-key|private provider/);
});

test('pending fallback survives repeated polling and a primary attempt interrupted by restart is not resent', async t => {
  let pending = true;
  const app = await fixture(t, 'en', { fallbackStatus: () => Response.json({ status: pending ? 'IN_PROGRESS' : 'COMPLETED' }) });
  app.task.localization = { translating: true };
  for (let i = 0; i < 3; i++) await app.service.advance(app.task, app.folder, app.save);
  assert.equal(app.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(app.calls.some(call => call.url.endsWith('/chat/completions')), false);
  assert.equal(app.task.localization.segments, undefined);
  pending = false;
  await app.service.advance(app.task, app.folder, app.save);
  assert.equal(app.task.localization.text, 'Welcome everyone.');
});

test('uncertain fallback submission is not repeated and foreign queue URLs never receive credentials', async t => {
  for (const foreign of [false, true]) {
    const app = await fixture(t, 'en', { translate: () => new Response('', { status: 503 }), fallbackSubmit: () => {
      if (!foreign) throw new Error('timeout');
      return Response.json({ request_id: 'translation-1', status_url: 'https://other.example/status', response_url: 'https://other.example/result' });
    } });
    for (let i = 0; i < 2; i++) await assert.rejects(app.service.advance(app.task, app.folder, app.save), { code: 'VIDEO_LOCALIZATION_UNCERTAIN' });
    assert.equal(app.calls.length, 2);
    assert.equal(app.calls.every(call => !call.url.includes('other.example')), true);
  }
});

test('credit and account checks cannot be bypassed by translation fallback', async t => {
  for (const cause of [Object.assign(new Error('blocked'), { providerNotDispatched: true }), Object.assign(new Error('blocked'), { code: 'INSUFFICIENT_POINTS' })]) {
    const app = await fixture(t, 'en', { translate: () => { throw cause; } });
    await assert.rejects(app.service.advance(app.task, app.folder, app.save), error => error === cause);
    assert.equal(app.calls.length, 1);
    assert.equal(app.task.localization.translationFallback, undefined);
    assert.equal(app.task.localization.translating, cause.providerNotDispatched ? undefined : true);
  }
});

test('failed or invalid fallback stops before TTS and a failed ready track cannot be reused', async t => {
  for (const outcome of ['invalid', 'error', 'partial', 'failed', 'rejected-result']) {
    const app = await fixture(t, 'en', { translate: () => new Response('', { status: 503 }),
      fallbackStatus: () => Response.json({ status: outcome === 'failed' ? 'FAILED' : 'COMPLETED' }),
      fallbackResult: () => outcome === 'rejected-result' ? new Response('{}', { status: 422 }) : Response.json({ output: JSON.stringify({ language: 'en', segments: [{ text: outcome === 'invalid' ? '中文' : 'Welcome everyone.' }] }),
        error: outcome === 'error' ? 'provider error' : null, partial: outcome === 'partial' }),
    });
    await app.service.advance(app.task, app.folder, app.save);
    await assert.rejects(app.service.advance(app.task, app.folder, app.save), { code: 'VIDEO_LOCALIZATION_FAILED' });
    app.task.localization.ready = true;
    await assert.rejects(app.service.advance(app.task, app.folder, app.save), { code: 'VIDEO_LOCALIZATION_FAILED' });
    assert.equal(app.calls.filter(call => call.method === 'POST').length, 2);
  }
});
