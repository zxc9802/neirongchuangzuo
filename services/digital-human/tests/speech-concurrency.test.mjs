import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import ts from 'typescript';
import * as media from '../src/lib/engine/ffmpeg.ts';
import * as stitch from '../src/lib/engine/speech-stitch.ts';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function harness(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-concurrency-'));
  const cwd = process.cwd(); const originalFetch = globalThis.fetch;
  const requests = []; let active = 0; let maximum = 0; let failText = ''; let autoComplete = false;
  try {
    process.chdir(dir);
    const fixture = path.join(dir, 'fixture.wav');
    await media.execMediaCommand('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
      'sine=frequency=440:sample_rate=22050:duration=0.4', '-c:a', 'pcm_s16le', fixture]);
    const joins = [];
    const deps = {fs, path, crypto, './ffmpeg': media,
      '../server/safe-log': {logServerError() {}},
      '../server/outbound-url-policy': {providerUrlPolicy: () => ({})},
      './download-file': {downloadFileToDisk: async ({outputPath}) => fs.copyFileSync(fixture, outputPath)},
      './speech-stitch': {...stitch, stitchSpeechSegments: async (parts, output) => {
        joins.push(parts.map(part => part.text));
        return stitch.stitchSpeechSegments(parts, output);
      }},
    };
    const source = fs.readFileSync(new URL('../src/lib/engine/indextts.ts', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, {compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop:true,
    }}).outputText;
    globalThis.fetch = async (url, init) => {
      if (init?.method === 'POST') {
        const payload = JSON.parse(init.body);
        const id = String(requests.length);
        let release;
        const ready = new Promise(resolve => {release = resolve;});
        requests.push({id, payload, ready, release});
        active++; maximum = Math.max(maximum, active);
        if (autoComplete) release();
        return Response.json({task_id:id});
      }
      const request = requests[Number(new URL(url).searchParams.get('task_id'))];
      await request.ready;
      active--;
      if (request.payload.text === failText) return Response.json({state:'FAILURE'});
      return Response.json({state:'SUCCESS', audio_url:`https://audio.example.test/${request.id}`});
    };
    const module = {exports:{}};
    new Function('require', 'module', 'exports', 'setTimeout', compiled)(name => {
      assert.ok(name in deps, `Unexpected dependency ${name}`); return deps[name];
    }, module, module.exports, callback => queueMicrotask(callback));
    const options = {apiKey:'test', speakerAudioUrl:'https://speaker.example.test/a.wav',
      emotionAudioUrl:'https://speaker.example.test/emotion.wav', emotionIntensity:0.8,
      cacheScope:'owner:voice', outDir:path.join(dir,'job')};
    await run({generate:module.exports.generateIndexTTS, options, requests, joins,
      active:()=>active, maximum:()=>maximum,
      fail:text=>{failText=text;}, automatic:()=>{autoComplete=true; [...requests].reverse().forEach(r=>r.release());}, dir});
  } finally {
    globalThis.fetch = originalFetch; process.chdir(cwd); fs.rmSync(dir,{recursive:true,force:true});
  }
}

test('sentence synthesis overlaps three requests across jobs and preserves order when completions reverse', async () => {
  await harness(async h => {
    const first = '第一句话。第二句话。第三句话。第四句话。';
    const second = '另一篇第一句。另一篇第二句。另一篇第三句。';
    const running = Promise.all([
      h.generate(first,h.options), h.generate(second,{...h.options,outDir:path.join(h.dir,'other-job')}),
    ]);
    let observed;
    try { await sleep(30); observed=h.requests.length; }
    finally {h.automatic();}
    await running;
    assert.equal(observed,3,'three requests must be in flight before the first finishes');
    assert.equal(h.maximum(),3,'the limit must apply across concurrent jobs');
    assert.ok(h.requests.every(({payload}) => payload.emotion_audio_url === h.options.emotionAudioUrl && payload.emotion_alpha === 0.8 && !('emotion_vector' in payload)), 'every segment must use the same emotion recording and strength');
    assert.deepEqual(h.joins.map(parts=>parts.join('')).sort(),[first,second].sort());
    assert.ok(fs.statSync(path.join(h.options.outDir,'voice-track.wav')).size>44);
  });
});

test('failed parallel generation drains in-flight work and does not submit or publish later sentences', async () => {
  await harness(async h => {
    h.fail('第一句话。');
    const running=h.generate('第一句话。第二句话。第三句话。第四句话。第五句话。',h.options);
    const rejection=assert.rejects(running,/合成失败/);
    await sleep(30);
    h.requests[0].release();
    await sleep(20);
    h.requests.forEach(request=>request.release());
    await rejection;
    assert.equal(h.requests.length,3,'a failed wave must not launch later paid requests');
    assert.equal(h.active(),0,'parent must not return while child writes are still running');
    assert.equal(fs.existsSync(path.join(h.options.outDir,'voice-track.wav')),false);
    assert.equal(h.joins.length,0);
  });
});

test('renewed COS signatures reuse speech cache while another reference or owner does not', async () => {
  await harness(async h => {
    h.automatic();
    const reference='https://studio-123.cos.ap-singapore.myqcloud.com/voices/one.wav';
    const options={...h.options,speakerAudioUrl:`${reference}?q-signature=first&q-sign-time=1%3B2`};
    const first=await h.generate('同一篇文案。',options);
    assert.equal(first.fromCache,false);
    const renewed=await h.generate('同一篇文案。',{...options,
      speakerAudioUrl:`${reference}?q-signature=renewed&q-sign-time=3%3B4`,outDir:path.join(h.dir,'renewed')});
    assert.equal(renewed.fromCache,true,'expiring authorization must not change media identity');
    assert.equal(h.requests.length,1);
    await h.generate('同一篇文案。',{...options,cacheScope:'another-owner:voice',outDir:path.join(h.dir,'owner')});
    await h.generate('同一篇文案。',{...options,speakerAudioUrl:reference.replace('one.wav','two.wav'),outDir:path.join(h.dir,'reference')});
    assert.equal(h.requests.length,3,'different owners and source files must not share a cached voice');
  });
});
