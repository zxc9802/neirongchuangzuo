import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import ts from 'typescript';
import * as media from '../src/lib/engine/ffmpeg.ts';
import * as stitch from '../src/lib/engine/speech-stitch.ts';

const models = {en: 'fal-ai/zonos2', ms: 'qwen-audio-3.0-tts-plus', convert: 'fal-ai/chatterbox/speech-to-speech'};
const qwenBase = 'https://dashscope-intl.aliyuncs.com';
const endpoint = model => model === models.ms ? `${qwenBase}/api/v1/services/audio/tts/SpeechSynthesizer` : `https://queue.fal.run/${model}`;
const source = fs.readFileSync(new URL('../src/lib/engine/localized-speech.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022, esModuleInterop: true}}).outputText;

async function harness(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'localized-speech-'));
  const cwd = process.cwd(), originalFetch = globalThis.fetch;
  const calls = [], downloads = [];
  let rejectDownload = false, handler;
  try {
    process.chdir(dir);
    const fixture = path.join(dir, 'fixture.wav');
    await media.execMediaCommand('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
      'sine=frequency=440:sample_rate=24000:duration=2', fixture]);
    const jobs = new Map();
    const respond = (url, init = {}) => {
      if (url.endsWith('/SpeechSynthesizer')) return Response.json({request_id: 'qwen-request',
        output: {finish_reason: 'stop', audio: {url: 'http://dashscope-result-sg.oss-ap-southeast-1.aliyuncs.com/native.wav?Signature=test'}},
        usage: {characters: JSON.parse(init.body).input.text.length}});
      if (init.method === 'POST') {
        const model = url.slice('https://queue.fal.run/'.length), id = `job-${jobs.size + 1}`;
        const root = `https://queue.fal.run/${model.split('/').slice(0, 2).join('/')}/requests/${id}`;
        const job = {request_id: id, response_url: root, status_url: root + '/status'};
        jobs.set(root, {model, job}); return Response.json(job);
      }
      const root = url.replace(/\/status$/, '');
      assert.ok(jobs.has(root), `Unexpected read ${url}`);
      return Response.json(url.endsWith('/status') ? {status: 'COMPLETED'} :
        {audio: {url: `https://fal.media/${jobs.get(root).job.request_id}.wav`}},
      {headers: {'x-fal-billable-units': jobs.get(root).model === models.ms ? '.1' : '1'}});
    };
    globalThis.fetch = async (url, init) => {
      calls.push({url, init, body: init.body ? JSON.parse(init.body) : undefined});
      return handler ? handler(url, init, respond) : respond(url, init);
    };
    const deps = {fs, path, crypto, './ffmpeg': media, './speech-stitch': stitch,
      '../server/outbound-url-policy': {providerUrlPolicy: () => ({allowedHosts: ['fal.media']})},
      './download-file': {downloadFileToDisk: async options => {
        downloads.push(options);
        if (typeof rejectDownload === 'function' ? rejectDownload(options) : rejectDownload) throw new Error('download interrupted');
        fs.copyFileSync(fixture, options.outputPath);
      }}};
    const module = {exports: {}};
    new Function('require', 'module', 'exports', 'setTimeout', compiled)(name => {
      assert.ok(name in deps, `Unexpected dependency ${name}`); return deps[name];
    }, module, module.exports, fn => queueMicrotask(fn));
    const options = {apiKey: 'fal-test', speakerAudioUrl: 'https://reference.example/person.wav',
      englishReferenceAudioUrl: 'https://reference.example/native-en.wav', qwenMalayVoiceId: 'native-ms',
      qwenTtsApiKey: 'singapore-test', qwenTtsBaseUrl: qwenBase,
      cacheScope: 'owner:voice', outDir: path.join(dir, 'output')};
    await run({calls, downloads, options, fixture,
      generate: (text, language, extra) => module.exports.generateLocalizedSpeech(text, language, {...options, ...extra}),
      respond: value => {handler = value;}, rejectDownload: value => {rejectDownload = value;}});
  } finally {
    globalThis.fetch = originalFetch; process.chdir(cwd); fs.rmSync(dir, {recursive: true, force: true});
  }
}

for (const language of ['en', 'ms']) for (const [toneProfile, rate] of [['low', 1], ['half', 0.5], ['slow', 0.8], ['high', 1.2], ['fast', 1.5]]) test(`${language} uses the chosen native model then the selected own voice; ${rate}x applies once`, async () => {
  await harness(async h => {
    const text = language === 'en' ? 'Hey, good morning! Let us meet later. Sound good?' : 'Hai, selamat pagi! Jom kita makan bersama.';
    const result = await h.generate(text, language, {toneProfile});
    const posts = h.calls.filter(c => c.init.method === 'POST');
    assert.deepEqual(posts.map(c => c.url), [endpoint(models[language]), endpoint(models.convert)]);
    if (language === 'en') {
      assert.equal(posts[0].body.reference_audio_url, h.options.englishReferenceAudioUrl);
      assert.equal(posts[0].body.text, text); assert.equal(posts[0].body.accurate_mode, false);
    } else {
      assert.deepEqual(posts[0].body, {model: models.ms, input: {text, voice: 'native-ms', format: 'wav',
        sample_rate: 24000, rate: 1, language_hints: ['ms']}});
      assert.equal(h.downloads[0].url, 'https://dashscope-result-sg.oss-ap-southeast-1.aliyuncs.com/native.wav?Signature=test');
      assert.deepEqual(h.downloads[0].urlPolicy.allowedHosts, ['dashscope-result-sg.oss-ap-southeast-1.aliyuncs.com']);
      assert.equal(h.downloads[0].headers, undefined);
    }
    assert.equal(result.rate, rate);
    assert.ok(Math.abs(result.rawDuration / result.selectedDuration - rate) < .04);
    if (rate === 1) assert.deepEqual(fs.readFileSync(result.rawWavPath), fs.readFileSync(result.finalWavPath));
    assert.equal(posts[1].body.target_voice_audio_url, h.options.speakerAudioUrl);
    assert.match(posts[1].body.source_audio_url, language === 'en' ? /^https:\/\/fal\.media\// : /^data:audio\/wav;base64,UklGR/);
    assert.ok(h.calls.every(c => c.init.redirect === 'error' && c.init.headers.Authorization ===
      (c.url === endpoint(models.ms) ? 'Bearer singapore-test' : 'Key fal-test')));
    assert.equal(fs.readFileSync(result.finalWavPath).toString('ascii', 0, 4), 'RIFF');
    const cached = await h.generate(text, language, {toneProfile});
    assert.equal(cached.fromCache, true); assert.equal(cached.rate, result.rate);
    assert.equal(h.calls.filter(c => c.init.method === 'POST').length, 2);
  });
});

test('long English scripts retain every word while packing sentences into passages', async () => {
  await harness(async h => {
    const text = 'We are taking a walk today and meeting our friends later. '.repeat(20).trim();
    await h.generate(text, 'en');
    const sources = h.calls.filter(c => c.url === endpoint(models.en));
    assert.ok(sources.length > 1 && sources.length < 20);
    assert.ok(sources.every(c => c.body.text.length <= 600));
    assert.equal(sources.map(c => c.body.text).join(' '), text);
    assert.equal(h.calls.filter(c => c.url === endpoint(models.convert)).length, sources.length);
  });
});

test('cache separates languages, owners, native reference identities and speeds', async () => {
  await harness(async h => {
    await h.generate('Hotel.', 'en');
    await h.generate('Hotel.', 'ms', {outDir: h.options.outDir + '-ms'});
    await h.generate('Hotel.', 'en', {cacheScope: 'other-owner:voice', outDir: h.options.outDir + '-owner'});
    await h.generate('Hotel.', 'en', {englishReferenceAudioUrl: 'https://reference.example/other.wav', outDir: h.options.outDir + '-reference'});
    await h.generate('Hotel.', 'en', {toneProfile: 'fast', outDir: h.options.outDir + '-fast'});
    assert.equal(h.calls.filter(c => c.init.method === 'POST').length, 10);
  });
});

test('configured private English WAV is sent inline without hosting it publicly', async () => {
  await harness(async h => {
    await h.generate('Hello.', 'en', {englishReferenceAudioUrl: '', englishReferenceAudioPath: h.fixture});
    assert.match(h.calls[0].body.reference_audio_url, /^data:audio\/wav;base64,UklGR/);
  });
});

test('download recovery reuses both paid jobs and preserves their billing evidence', async () => {
  await harness(async h => {
    h.rejectDownload(true);
    await assert.rejects(h.generate('Hello.', 'en'), /download interrupted/);
    h.rejectDownload(false);
    assert.ok((await h.generate('Hello.', 'en')).selectedDuration > 0);
    assert.equal(h.calls.filter(c => c.init.method === 'POST').length, 2);
    const group = path.join(h.options.outDir, 'localized-speech');
    const receipts = fs.readdirSync(group).filter(hash => hash !== 'input.json').flatMap(hash => ['source', 'conversion'].map(name =>
      JSON.parse(fs.readFileSync(path.join(group, hash, '1', `${name}.json`), 'utf8'))));
    assert.ok(receipts.every(r => r.id && r.billableUnits && r.result.audio.url));
  });
});

test('uncertain conversion submission cannot repeat either paid POST on recovery', async () => {
  await harness(async h => {
    h.respond((url, init, respond) => {
      if (url === endpoint(models.convert)) throw new TypeError('response lost');
      return respond(url, init);
    });
    await assert.rejects(h.generate('Hello.', 'en'), /response lost/);
    await assert.rejects(h.generate('Hello.', 'en'), /提交尚未确认/);
    assert.equal(h.calls.filter(c => c.init.method === 'POST').length, 2);
  });
});

test('renewed private COS signatures recover the same accepted jobs without resubmission', async () => {
  await harness(async h => {
    const speaker = 'https://bucket.cos.ap-test.myqcloud.com/uploads/users/owner/voices/voice.wav';
    const reference = 'https://bucket.cos.ap-test.myqcloud.com/uploads/users/system/voices/native.wav';
    h.rejectDownload(true);
    await assert.rejects(h.generate('Hello.', 'en', {
      speakerAudioUrl: speaker + '?q-signature=first', englishReferenceAudioUrl: reference + '?q-signature=first',
    }), /download interrupted/);
    h.rejectDownload(false);
    await h.generate('Hello.', 'en', {
      speakerAudioUrl: speaker + '?q-signature=renewed', englishReferenceAudioUrl: reference + '?q-signature=renewed',
    });
    assert.equal(h.calls.filter(c => c.init.method === 'POST').length, 2);
  });
});

test('transient reads retry accepted jobs; foreign or mismatched jobs receive no credentials', async () => {
  await harness(async h => {
    let transient = true;
    h.respond((url, init, respond) => {
      if (transient && url.endsWith('/status')) {transient = false; throw new TypeError('temporary');}
      return respond(url, init);
    });
    await h.generate('Hello.', 'en');
    assert.equal(h.calls.filter(c => c.init.method === 'POST').length, 2);
    for (const bad of ['https://other.example/status', 'https://queue.fal.run/fal-ai/minimax/requests/job-3/status']) {
      const before = h.calls.length;
      h.respond((url, init, respond) => {
        const response = respond(url, init);
        return init.method === 'POST' ? response.json().then(job => Response.json({...job, status_url: bad})) : response;
      });
      await assert.rejects(h.generate('Different text ' + before, 'en', {outDir: h.options.outDir + '-foreign-' + before}), /任务地址无效/);
      assert.equal(h.calls.length, before + 1);
    }
  });
});

test('changing an existing task input cannot submit another paid chain', async () => {
  await harness(async h => {
    await h.generate('Hello.', 'en');
    await assert.rejects(h.generate('Changed text.', 'en'), /参数已变化/);
    await assert.rejects(h.generate('Hello.', 'en', {englishReferenceAudioUrl: 'https://reference.example/changed.wav'}), /参数已变化/);
    assert.equal(h.calls.filter(c => c.init.method === 'POST').length, 2);
  });
});

test('missing language setup fails before charging and never falls back to Chinese', async () => {
  await harness(async h => {
    await assert.rejects(h.generate('Hello.', 'en', {englishReferenceAudioUrl: ''}), /ZONOS2_REFERENCE/);
    await assert.rejects(h.generate('Hai.', 'ms', {qwenMalayVoiceId: ''}), /QWEN_MALAY/);
    await assert.rejects(h.generate('Hai.', 'ms', {qwenTtsApiKey: ''}), /QWEN_TTS_API_KEY/);
    h.respond(() => new Response('denied', {status: 401}));
    await assert.rejects(h.generate('Hai.', 'ms', {fallback: {apiKey: 'other', speakerId: 'speaker'}}), /401/);
    assert.deepEqual(h.calls.map(c => c.url), [endpoint(models.ms)]);
  });
});

test('Qwen download recovery reuses the original paid synthesis and keeps character usage', async () => {
  await harness(async h => {
    h.rejectDownload(true);
    await assert.rejects(h.generate('Selamat pagi.', 'ms'), /download interrupted/);
    h.rejectDownload(false);
    await h.generate('Selamat pagi.', 'ms');
    assert.equal(h.calls.filter(c => c.url === endpoint(models.ms)).length, 1);
    assert.equal(h.calls.filter(c => c.url === endpoint(models.convert)).length, 1);
    const group = path.join(h.options.outDir, 'localized-speech');
    const hash = fs.readdirSync(group).find(name => name !== 'input.json');
    const receipt = JSON.parse(fs.readFileSync(path.join(group, hash, '1/source.json'), 'utf8'));
    assert.equal(receipt.id, 'qwen-request');
    assert.equal(receipt.usage.characters, 'Selamat pagi.'.length);
    assert.equal(receipt.endpoint, qwenBase);
    assert.ok(!JSON.stringify(receipt).includes('singapore-test'));
  });
});

test('Qwen WAV survives a conversion interruption and an expired remote source URL', async () => {
  await harness(async h => {
    h.rejectDownload(options => options.url.startsWith('https://fal.media/'));
    await assert.rejects(h.generate('Selamat pagi.', 'ms'), /download interrupted/);
    h.rejectDownload(false);
    await h.generate('Selamat pagi.', 'ms');
    assert.equal(h.calls.filter(c => c.init.method === 'POST').length, 2);
    assert.equal(h.downloads.filter(d => d.url.includes('aliyuncs.com')).length, 1);
  });
});

test('uncertain Qwen submission cannot repeat a paid POST or invoke conversion', async () => {
  await harness(async h => {
    h.respond(() => {throw new TypeError('response lost');});
    await assert.rejects(h.generate('Selamat pagi.', 'ms'), /response lost/);
    await assert.rejects(h.generate('Selamat pagi.', 'ms'), /提交尚未确认/);
    assert.equal(h.calls.length, 1);
  });
});

test('Qwen regional hosts are validated before sending credentials and separate cached voices', async () => {
  await harness(async h => {
    for (const base of ['https://example.com', 'http://dashscope-intl.aliyuncs.com',
      'https://dashscope-intl.aliyuncs.com/api/v1', 'https://user@dashscope-intl.aliyuncs.com']) {
      await assert.rejects(h.generate('Hai.', 'ms', {qwenTtsBaseUrl: base}), /QWEN_TTS_BASE_URL/);
    }
    assert.equal(h.calls.length, 0);
    await h.generate('Hai.', 'ms');
    await h.generate('Hai.', 'ms', {qwenTtsBaseUrl: 'https://llm-example.cn-beijing.maas.aliyuncs.com',
      outDir: h.options.outDir + '-beijing'});
    assert.equal(h.calls.filter(c => c.init.method === 'POST').length, 4);
  });
});

test('Qwen rejects foreign media without download, conversion or another synthesis', async () => {
  await harness(async h => {
    h.respond(() => Response.json({request_id: 'bad-media', output: {finish_reason: 'stop',
      audio: {url: 'http://example.com/audio.wav'}}, usage: {characters: 4}}));
    await assert.rejects(h.generate('Hai.', 'ms'), /音频地址无效/);
    await assert.rejects(h.generate('Hai.', 'ms'), /音频地址无效/);
    assert.equal(h.calls.length, 1);
    assert.equal(h.downloads.length, 0);
  });
});
