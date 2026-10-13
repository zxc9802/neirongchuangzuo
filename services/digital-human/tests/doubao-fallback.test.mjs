import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import ts from 'typescript';
import * as media from '../src/lib/engine/ffmpeg.ts';
import * as stitch from '../src/lib/engine/speech-stitch.ts';

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

function response(messages, complete = true) {
  const pcm = Buffer.alloc(24000);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.sin(i * 2 * Math.PI * 440 / 24000) * 8000, i * 2);
  const lines = messages || [{code: 0, data: pcm.subarray(0, 12000).toString('base64')},
    {code: 0, data: pcm.subarray(12000).toString('base64')}];
  if (complete) lines.push({code: 20000000});
  const bytes = new TextEncoder().encode(lines.map(line => JSON.stringify(line)).join('\n'));
  return new Response(new ReadableStream({start(controller) {
    // JSON and base64 may cross HTTP chunk boundaries, including the final line without a newline.
    for (let i = 0; i < bytes.length; i += 137) controller.enqueue(bytes.subarray(i, i + 137));
    controller.close();
  }}));
}

async function harness(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-fallback-'));
  const originalCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  const posts = []; const logs = []; let failPrimary = true;
  let fallbackResponse = () => response();
  try {
    process.chdir(dir);
    const fixture = path.join(dir, 'primary.wav');
    await media.execMediaCommand('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
      'sine=frequency=880:sample_rate=24000:duration=0.3', '-c:a', 'pcm_s16le', fixture]);
    const doubao = fs.existsSync(new URL('../src/lib/engine/doubao-tts.ts', import.meta.url))
      ? load('../src/lib/engine/doubao-tts.ts', {fs, path, crypto, './ffmpeg': media, './speech-stitch': stitch}) : {};
    const primary = load('../src/lib/engine/indextts.ts', {fs, path, crypto,
      './ffmpeg': media, './speech-stitch': stitch, './doubao-tts': doubao,
      '../server/safe-log': {logServerError() {}},
      '../server/outbound-url-policy': {providerUrlPolicy: () => ({})},
      './download-file': {downloadFileToDisk: async ({outputPath}) => fs.copyFileSync(fixture, outputPath)},
    });
    globalThis.fetch = async (url, init) => {
      if (init?.method === 'POST') {
        const payload = JSON.parse(init.body); posts.push({url: String(url), payload, init});
        if (String(url).includes('openspeech.bytedance.com')) return fallbackResponse();
        if (failPrimary && payload.text.includes('失败')) return Response.json({error: '服务器繁忙'}, {status: 500});
        return Response.json({task_id: String(posts.length)});
      }
      return Response.json({state: 'SUCCESS', audio_url: 'https://audio.example.test/test.wav'});
    };
    const options = {apiKey: 'primary-test', speakerAudioUrl: 'https://speaker.example.test/a.wav',
      cacheScope: `test:${dir}`, outDir: path.join(dir, 'job'), onLog: message => logs.push(message),
      fallback: {apiKey: 'doubao-test', speakerId: 'S_test'}, onFallback: () => logs.push('fallback')};
    await run({generate: primary.generateIndexTTS, generateDoubao: doubao.generateDoubaoTTS,
      options, posts, logs, dir, primarySuccess: () => {failPrimary = false;},
      respond: factory => {fallbackResponse = factory;}});
  } finally {
    globalThis.fetch = originalFetch;
    process.chdir(originalCwd);
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

test('primary success never calls the fallback or changes the existing voice', async () => {
  await harness(async h => {
    h.primarySuccess();
    const result = await h.generate('主模型成功。', h.options);
    assert.equal(h.posts.length, 1);
    assert.equal(h.logs.includes('fallback'), false);
    assert.ok(result.selectedDuration > 0);
  });
});

for (const toneProfile of [undefined, 'low', 'high']) {
  test(`a failed IndexTTS sentence switches the entire script to Doubao at 1.2x (${toneProfile || 'default'})`, async () => {
    await harness(async h => {
      const text = '第一句话成功。第二句话失败。第三句话成功。';
      const result = await h.generate(text, {...h.options, toneProfile});
      const fallback = h.posts.filter(p => p.url.includes('openspeech.bytedance.com'));
      assert.equal(fallback.length, 3);
      assert.equal(fallback.map(p => p.payload.req_params.text).join(''), text);
      assert.equal(fallback[0].payload.req_params.speaker, 'S_test');
      assert.equal(fallback[0].payload.req_params.model, 'seed-tts-2.0-expressive');
      assert.equal(fallback[0].init.headers['X-Api-Resource-Id'], 'seed-icl-2.0');
      assert.equal(fallback[0].init.headers['X-Api-Key'], 'doubao-test');
      assert.equal(fallback[0].init.redirect, 'error');
      assert.equal(result.finalWavPath, path.join(h.options.outDir, 'voice-track.wav'));
      assert.ok(Math.abs(result.rawDuration - 1.86) < 0.04, 'must use only the complete fallback track');
      assert.equal(result.rate, 1.2);
      assert.ok(Math.abs(result.selectedDuration - result.rawDuration / 1.2) < 0.08);
      assert.equal(h.logs.filter(m => m === 'fallback').length, 1);
    });
  });
}

test('missing fallback credentials or voice mapping preserves the original error', async () => {
  await harness(async h => {
    await assert.rejects(h.generate('失败。', {...h.options, fallback: undefined}), /500/);
    await assert.rejects(h.generate('失败。', {...h.options, fallback: {apiKey: 'test', speakerId: ''}}), /500/);
    assert.ok(h.posts.every(p => !p.url.includes('openspeech.bytedance.com')));
  });
});

test('long Doubao narration resets synthesis at sentence boundaries and speeds the joined track only once', async () => {
  await harness(async h => {
    const text = '你想想，公司里是不是有那么一两个销冠或者技术骨干，业绩全靠他们撑着？但他们一旦离职，经验带不走，甚至客户跟着走。你的企业，也才能真正不再被某个人绑架，实现系统自运转！';
    const result = await h.generateDoubao(text, {...h.options.fallback, outDir: h.options.outDir});
    const requests = h.posts.map(p => p.payload.req_params);
    assert.deepEqual(requests.map(p => p.text), stitch.splitSpeechText(text));
    assert.equal(requests.map(p => p.text).join(''), text, 'no words may be lost or repeated at joins');
    assert.ok(requests.every(p => p.speaker === 'S_test' && p.model === 'seed-tts-2.0-expressive'));
    const expectedRaw = requests.length * 0.5 + (requests.length - 1) * 0.18;
    assert.ok(Math.abs(result.rawDuration - expectedRaw) < 0.04, 'keep every complete sentence and its pause');
    assert.ok(Math.abs(result.selectedDuration - expectedRaw / 1.2) < 0.08, 'apply 1.2x to the whole joined track once');
  });
});

test('a failed later Doubao sentence never delivers just the opening sentence', async () => {
  await harness(async h => {
    let calls = 0;
    h.respond(() => ++calls === 1 ? response() : response(undefined, false));
    await assert.rejects(h.generateDoubao('第一句话。第二句话。', {
      ...h.options.fallback, outDir: h.options.outDir,
    }), /豆包配音未完整生成/);
    assert.equal(calls, 2);
    assert.equal(fs.existsSync(path.join(h.options.outDir, 'voice-track.wav')), false);
    assert.deepEqual(fs.readdirSync(h.options.outDir), [], 'discard incomplete temporary segments');
  });
});

test('task cancellation stops fallback before an additional paid request', async () => {
  await harness(async h => {
    await assert.rejects(h.generate('失败。', {...h.options, checkActive() {throw new Error('任务已删除');}}), /任务已删除/);
    assert.ok(h.posts.every(p => !p.url.includes('openspeech.bytedance.com')));
  });
});

test('empty, truncated and error-after-audio streams cannot publish partial fallback audio', async () => {
  await harness(async h => {
    const cases = [() => response([], true), () => response(undefined, false),
      () => response([{code: 0, data: Buffer.alloc(24000).toString('base64')},
        {code: 55000000, message: 'service busy'}], false),
      () => Response.json({error: 'busy'}, {status: 503})];
    for (let i = 0; i < cases.length; i++) {
      h.respond(cases[i]);
      const outDir = path.join(h.dir, `failed-${i}`);
      await assert.rejects(h.generate('失败。', {...h.options, outDir}), /豆包/);
      assert.equal(fs.existsSync(path.join(outDir, 'tts-doubao', 'voice-track.wav')), false);
    }
  });
});

test('cancellation while Doubao streams stops reading and publishes no audio', async () => {
  await harness(async h => {
    let checks = 0;
    const outDir = path.join(h.dir, 'cancelled');
    await assert.rejects(h.generate('失败。', {...h.options, outDir,
      checkActive() {if (++checks > 3) throw new Error('任务已删除');}}), /任务已删除/);
    assert.equal(h.posts.filter(p => p.url.includes('openspeech.bytedance.com')).length, 1);
    assert.equal(fs.existsSync(path.join(outDir, 'tts-doubao', 'voice-track.wav')), false);
  });
});
