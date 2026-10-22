import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import ts from 'typescript';
import * as media from '../src/lib/engine/ffmpeg.ts';
import * as stitch from '../src/lib/engine/speech-stitch.ts';
import * as publicContract from '../src/lib/public-contract.ts';

function load(relative, dependencies) {
  const source = fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  }}).outputText;
  const module = {exports: {}};
  new Function('require', 'module', 'exports', 'setTimeout', compiled)(name => {
    assert.ok(name in dependencies, `Unexpected dependency ${name}`);
    return dependencies[name];
  }, module, module.exports, callback => queueMicrotask(callback));
  return module.exports;
}

const endpoint = 'https://queue.fal.run/fal-ai/index-tts-2/text-to-speech';
const job = {request_id: 'test', status_url: 'https://queue.fal.run/fal-ai/index-tts-2/requests/test/status',
  response_url: 'https://queue.fal.run/fal-ai/index-tts-2/requests/test'};

async function harness(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fal-indextts-'));
  const cwd = process.cwd(); const fetch = globalThis.fetch;
  const calls = []; const downloads = [];
  try {
    process.chdir(dir);
    const fixture = path.join(dir, 'provider.mp3');
    await media.execMediaCommand('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
      'sine=frequency=440:sample_rate=24000:duration=0.3', fixture]);
    const {generateIndexTTS, generateChatterboxTTS} = load('../src/lib/engine/indextts.ts', {fs, path, crypto,
      './ffmpeg': media, './speech-stitch': stitch,
      './localized-speech': {generateLocalizedSpeech: async (text, language, options) => ({text, language, options})},
      '../server/safe-log': {logServerError() {}},
      '../server/outbound-url-policy': {providerUrlPolicy: provider => {
        assert.equal(provider, 'fal'); return {allowedHosts: ['fal.media']};
      }},
      './download-file': {downloadFileToDisk: async options => {
        downloads.push(options); fs.copyFileSync(fixture, options.outputPath);
      }},
    });
    let respond = url => Response.json(url === endpoint ? job :
      url === job.status_url ? {status: 'COMPLETED'} : {audio: {url: 'https://fal.media/audio.mp3'}});
    globalThis.fetch = async (url, init) => {calls.push({url, init}); return respond(url, init);};
    const options = {apiKey: 'fal-test', speakerAudioUrl: 'https://reference.example/voice.wav',
      outDir: path.join(dir, 'output')};
    await run({generate: extra => generateIndexTTS('测试配音。', {...options, ...extra}), options, calls, downloads,
      chatterbox: (text, language, extra) => generateChatterboxTTS(text, language, {...options, ...extra}),
      respond: fn => {respond = fn;}});
  } finally {
    globalThis.fetch = fetch; process.chdir(cwd); fs.rmSync(dir, {recursive: true, force: true});
  }
}

test('fal queue authenticates each request and normalizes MP3 output to actual PCM WAV', async () => {
  await harness(async h => {
    let polls = 0;
    h.respond(url => Response.json(url === endpoint ? job : url === job.status_url ?
      {status: ++polls === 1 ? 'IN_QUEUE' : 'COMPLETED'} : {audio: {url: 'https://fal.media/audio.mp3'}}));
    const result = await h.generate({emotionAudioUrl: 'https://reference.example/emotion.wav'});
    assert.deepEqual(h.calls.map(c => c.url), [endpoint, job.status_url, job.status_url, job.response_url]);
    assert.ok(h.calls.every(c => c.init.headers.Authorization === 'Key fal-test' && c.init.redirect === 'error'));
    assert.deepEqual(JSON.parse(h.calls[0].init.body), {prompt: '测试配音。', audio_url: h.options.speakerAudioUrl,
      emotional_audio_url: 'https://reference.example/emotion.wav', strength: 0.8, should_use_prompt_for_emotion: false});
    for (const file of [result.rawWavPath, result.finalWavPath]) {
      const data = fs.readFileSync(file);
      assert.equal(data.toString('ascii', 0, 4), 'RIFF'); assert.equal(data.toString('ascii', 8, 12), 'WAVE');
    }
    assert.ok(result.selectedDuration > 0);
    assert.ok(h.downloads[0].urlPolicy.allowedHosts.includes('storage.googleapis.com'));
    assert.equal(fs.existsSync(path.join(h.options.outDir, 'voice-provider.audio')), false);
  });
});

test('fal string audio results and neutral emotion without a reference are supported', async () => {
  await harness(async h => {
    h.respond(url => Response.json(url === endpoint ? job : url === job.status_url ?
      {status: 'COMPLETED'} : {audio: 'https://storage.googleapis.com/test/audio.mp3'}));
    const result = await h.generate();
    assert.deepEqual(JSON.parse(h.calls[0].init.body).emotional_strengths, {calm: 1});
    assert.equal(result.audioUrl, 'https://storage.googleapis.com/test/audio.mp3');
  });
});

test('fal errors and untrusted task URLs fail without resubmission, credential forwarding or partial audio', async () => {
  await harness(async h => {
    const cases = [
      {create: () => Response.json({error: 'unauthorized'}, {status: 401}), error: /401/, calls: 1},
      {create: () => Response.json({request_id: 'test'}), error: /未自动重新提交/, calls: 1},
      ...['https://other.example/fal-ai/index-tts-2/requests/test',
        'https://queue.fal.run/fal-ai/other-model/requests/test',
        'https://user:secret@queue.fal.run/fal-ai/index-tts-2/requests/test'].map(status_url =>
        ({create: () => Response.json({...job, status_url}), error: /地址无效/, calls: 1})),
      {poll: {status: 'FAILED', error: 'generation failed'}, error: /generation failed/, calls: 2},
      {result: {error: 'result failed'}, error: /result failed/, calls: 3},
    ];
    for (const scenario of cases) {
      h.calls.length = 0;
      h.respond(url => url === endpoint ? (scenario.create?.() || Response.json(job)) : Response.json(
        url === job.status_url ? (scenario.poll || {status: 'COMPLETED'}) : scenario.result));
      await assert.rejects(h.generate(), scenario.error);
      assert.equal(h.calls.length, scenario.calls);
      assert.equal(h.calls.filter(c => c.init.method === 'POST').length, 1);
      assert.equal(fs.existsSync(path.join(h.options.outDir, 'voice-track.wav')), false);
    }
    assert.equal(h.downloads.length, 0);
  });
});

test('digital-human readiness uses the same fal key precedence as replica, never the old 302 key', async () => {
  const names = ['FAL_KEY', 'FAL_API_KEY', 'VIDEO_FAL_KEY', 'INDEXTTS_302_API_KEY'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (let i = 0; i < names.length; i++) {
      for (let j = 0; j < names.length; j++) {
        if (j < i) delete process.env[names[j]]; else process.env[names[j]] = `test-${j}`;
      }
      const config = load('../src/lib/config.ts', {path, './lipsync-provider': {resolveLipsyncProvider: () => 'heygen'}});
      assert.equal(config.getAppConfig().indexttsFalApiKey, i < 3 ? `test-${i}` : '');
      assert.equal(config.getAppConfig().falApiKey, i < 3 ? `test-${i}` : '');
      assert.equal(config.getAppConfig().indexttsApiKey, 'test-3');
      const route = load('../src/app/api/digital-human/status/route.ts', {
        'next/server': {NextResponse: Response}, '@/lib/config': config,
        '@/lib/public-contract': publicContract,
        '@/lib/access-control': {resolveAccessContext: async () => ({isolated: false})},
      });
      const result = await (await route.GET({})).json();
      assert.equal(result.ttsReady, i < 3);
      assert.deepEqual(result.engines, [
        {id: 'b', label: 'qy-标准', available: i < 3},
        {id: 'd', label: 'qy-旗舰', available: i < 3},
        {id: 'e', label: 'qy-至臻', available: i < 3},
      ]);
    }
  } finally {
    for (const name of names) {if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];}
  }
});

test('temporary polling and result failures reuse the accepted TTS job', async () => {
  await harness(async h => {
    let polls = 0, results = 0;
    h.respond(url => {
      if (url === endpoint) return Response.json(job);
      if (url === job.status_url) {
        if (++polls === 1) throw new TypeError('fetch failed');
        if (polls === 2) return new Response('rate limited', {status: 429});
        if (polls === 3) return new Response('gateway timeout', {status: 504});
        return Response.json({status: 'COMPLETED'});
      }
      if (++results === 1) return new Response('unavailable', {status: 503});
      if (results === 2) throw new TypeError('connection reset');
      return Response.json({audio: {url: 'https://fal.media/audio.mp3'}});
    });
    assert.ok((await h.generate()).selectedDuration > 0);
    assert.equal(h.calls.filter(c => c.init.method === 'POST').length, 1);
    assert.equal(results, 3);
  });
});

test('definitive TTS query rejection stops without replaying synthesis', async () => {
  await harness(async h => {
    h.respond(url => url === endpoint ? Response.json(job) : new Response('denied', {status: 403}));
    await assert.rejects(h.generate(), /403/);
    assert.equal(h.calls.length, 2);
    assert.equal(h.downloads.length, 0);
  });
});

test('English/Malay entry delegates to the localized fal chain with the selected voice and references', async () => {
  await harness(async h => {
    for (const language of ['en', 'ms']) {
      const result = await h.chatterbox('Hotel.', language, {englishReferenceAudioUrl: 'https://reference.example/native.wav', qwenMalayVoiceId: 'native-ms'});
      assert.equal(result.text, 'Hotel.'); assert.equal(result.language, language);
      assert.equal(result.options.speakerAudioUrl, h.options.speakerAudioUrl);
      assert.equal(result.options.qwenMalayVoiceId, 'native-ms');
      assert.equal(result.options.englishReferenceAudioUrl, 'https://reference.example/native.wav');
    }
    assert.equal(h.calls.length, 0);
  });
});
