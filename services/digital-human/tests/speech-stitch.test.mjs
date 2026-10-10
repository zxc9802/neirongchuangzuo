import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import ts from "typescript";
import * as media from "../src/lib/engine/ffmpeg.ts";

async function stitchModule() { return import("../src/lib/engine/speech-stitch.ts"); }

function fixture(file, frequency, internalPause = false) {
  const expression = internalPause
    ? `if(between(t,0.4,0.8)+between(t,1.0,1.4),0.2*sin(2*PI*${frequency}*t),0)`
    : `if(between(t,0.7,1.3),0.2*sin(2*PI*${frequency}*t),0)`;
  const result = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i",
    `aevalsrc=${expression.replaceAll(",", "\\,")}:s=22050:d=2`, "-c:a", "pcm_s16le", file], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function decode(file) {
  const result = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", "22050", "-f", "s16le", "-"], { maxBuffer: 10 * 1024 * 1024 });
  assert.equal(result.status, 0, String(result.stderr));
  const samples = new Int16Array(result.stdout.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = result.stdout.readInt16LE(i * 2);
  return samples;
}

function pauses(samples) {
  const result = []; let start = -1;
  for (let i = 0; i <= samples.length; i++) {
    if (i < samples.length && Math.abs(samples[i]) <= 2) { if (start < 0) start = i; }
    else if (start >= 0) {
      if ((i - start) / 22050 > 0.05) result.push({ start: start / 22050, duration: (i - start) / 22050 });
      start = -1;
    }
  }
  return result;
}

function power(samples, offset, frequency) {
  let real = 0; let imaginary = 0;
  for (let i = 0; i < 2205; i++) {
    const sample = samples[Math.round(offset * 22050) + i];
    real += sample * Math.cos(2 * Math.PI * frequency * i / 22050);
    imaginary += sample * Math.sin(2 * Math.PI * frequency * i / 22050);
  }
  return real * real + imaginary * imaginary;
}

test("speech splits at sentence and clause boundaries without losing text or splitting numbers", async () => {
  const { splitSpeechText } = await stitchModule();
  const text = '每月1800元，价格是3.5万元。房间有厨房！\n欢迎了解。';
  const parts = splitSpeechText(text);
  assert.deepEqual(parts, ['每月1800元，价格是3.5万元。', '房间有厨房！', '欢迎了解。']);
  const long = '房间通透明亮，'.repeat(15) + '床品温馨舒适。';
  const split = splitSpeechText(long);
  assert.ok(split.length > 1);
  assert.equal(split.join(''), long);
  assert.ok(split.every(part => Array.from(part).length <= 50));
  assert.ok(split.slice(0, -1).every(part => part.endsWith('，')));
  const unpunctuated = '房间通透明亮床品温馨舒适'.repeat(12);
  assert.equal(splitSpeechText(unpunctuated).join(''), unpunctuated);
});

test("real audio stitching trims only segment edges and preserves speech order and internal pauses", async () => {
  const { stitchSpeechSegments } = await stitchModule();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speech stitch ' test-"));
  try {
    const first = path.join(dir, 'first.wav'); const second = path.join(dir, 'second.wav');
    const output = path.join(dir, 'joined.wav');
    fixture(first, 440, true); fixture(second, 880);
    await stitchSpeechSegments([{ text: '房间通透明亮。', audioPath: first },
      { text: '床品温馨舒适。', audioPath: second }], output);
    const samples = decode(output); const duration = samples.length / 22050;
    assert.ok(duration > 1.8 && duration < 2.1, `excess edge silence must be removed: ${duration}`);
    const gaps = pauses(samples);
    assert.equal(gaps.length, 2, JSON.stringify(gaps));
    assert.ok(gaps.some(gap => Math.abs(gap.duration - 0.2) < 0.02), 'a pause within a spoken sentence must stay intact');
    assert.ok(gaps.every(gap => gap.duration < 0.35), 'join must not stack provider padding');
    assert.ok(power(samples, 0.15, 440) > power(samples, 0.15, 880) * 10);
    assert.ok(power(samples, duration - 0.25, 880) > power(samples, duration - 0.25, 440) * 10);
    assert.equal((await media.probeMedia(output)).sampleRate, 22050);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("IndexTTS actually submits sentence requests, stitches all parts, ignores old cache and reuses new cache", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-pipeline-'));
  const oldCwd = process.cwd(); const oldFetch = globalThis.fetch;
  const calls = []; let failSecond = false;
  try {
    process.chdir(dir);
    const first = path.join(dir, 'first.wav'); const second = path.join(dir, 'second.wav');
    fixture(first, 440); fixture(second, 880);
    const source = fs.readFileSync(new URL('../src/lib/engine/indextts.ts', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } }).outputText;
    const deps = { fs, path, crypto, './ffmpeg': media,
      '../server/safe-log': { logServerError() {} },
      '../server/outbound-url-policy': { providerUrlPolicy: () => ({}) },
      './download-file': { downloadFileToDisk: async ({ url, outputPath }) => {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.copyFileSync(url.endsWith('/1') ? first : second, outputPath);
      } },
    };
    // Only the new implementation needs this dependency; the old path can still run and fail the assertion.
    if (fs.existsSync(new URL('../src/lib/engine/speech-stitch.ts', import.meta.url))) deps['./speech-stitch'] = await stitchModule();
    globalThis.fetch = async (url, init) => {
      if (init?.method === 'POST') {
        calls.push(JSON.parse(init.body));
        if (failSecond && calls.length === 2) return Response.json({ error: 'failed' }, { status: 503 });
        return Response.json({ task_id: String(calls.length) });
      }
      return Response.json({ state: 'SUCCESS', audio_url: `https://audio.example.test/${new URL(url).searchParams.get('task_id')}` });
    };
    const module = { exports: {} };
    new Function('require', 'module', 'exports', 'setTimeout', compiled)(name => {
      assert.ok(name in deps, `Unexpected dependency ${name}`); return deps[name];
    }, module, module.exports, callback => { callback(); });
    const text = '房间通透明亮。床品温馨舒适。';
    const legacyKey = crypto.createHash('sha256').update(`owner|${text}|https://speaker.example.test/a.wav||0.8|low`).digest('hex');
    const legacyDir = path.join(dir, '.runtime', 'tts-cache', legacyKey);
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.copyFileSync(first, path.join(legacyDir, 'voice-raw.wav'));
    fs.copyFileSync(first, path.join(legacyDir, 'voice-track.wav'));
    fs.writeFileSync(path.join(legacyDir, 'meta.json'), JSON.stringify({ selectedDuration: 2, rawDuration: 2, rate: 1, toneProfile: 'low' }));
    const options = { apiKey: 'test-only', speakerAudioUrl: 'https://speaker.example.test/a.wav', cacheScope: 'owner', outDir: path.join(dir, 'job') };
    const result = await module.exports.generateIndexTTS(text, options);
    assert.equal(result.fromCache, false, 'old whole-text cache must not mask the new feature');
    assert.deepEqual(calls.map(call => call.text), ['房间通透明亮。', '床品温馨舒适。']);
    assert.ok(calls.every(call => call.speaker_audio_url === options.speakerAudioUrl));
    assert.equal(result.audioUrl, undefined, 'a provider URL for one part is not the joined output');
    const samples = decode(result.finalWavPath);
    assert.ok(samples.length / 22050 > 1.4 && samples.length / 22050 < 1.7);
    const cached = await module.exports.generateIndexTTS(text, { ...options, outDir: path.join(dir, 'cached-job') });
    assert.equal(cached.fromCache, true); assert.equal(calls.length, 2);
    assert.deepEqual(fs.readFileSync(cached.finalWavPath), fs.readFileSync(result.finalWavPath));
    const faster = await module.exports.generateIndexTTS(text, { ...options, toneProfile: 'high', outDir: path.join(dir, 'fast-job') });
    assert.equal(calls.length, 2, 'segments reuse their original-rate cache');
    assert.equal(faster.rate, 1.2);
    assert.ok(Math.abs(faster.selectedDuration - faster.rawDuration / 1.2) < 0.08, 'apply speed once after the final join');
    // A failed later segment must never publish or cache a partial final track.
    calls.length = 0; failSecond = true;
    const failedDir = path.join(dir, 'failed-job');
    await assert.rejects(module.exports.generateIndexTTS('新的房间通透明亮。新的床品温馨舒适。', { ...options, outDir: failedDir }), /503/);
    assert.equal(fs.existsSync(path.join(failedDir, 'voice-track.wav')), false);
    calls.length = 0; failSecond = false;
    await assert.rejects(module.exports.generateIndexTTS('取消的第一句。取消的第二句。', {
      ...options, outDir: path.join(dir, 'cancelled-job'), onLog: message => {
        if (message === '正在合成第 2/2 段...') throw new Error('任务已删除');
      },
    }), /任务已删除/);
    assert.ok(calls.length <= 1, 'cancellation must stop submitting additional paid segments');
  } finally {
    globalThis.fetch = oldFetch; process.chdir(oldCwd); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty generated segment must fail instead of silently dropping a sentence", async () => {
  const { stitchSpeechSegments } = await stitchModule();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-silent-segment-'));
  try {
    const silent = path.join(dir, 'silent.wav'); const spoken = path.join(dir, 'spoken.wav');
    await media.execMediaCommand('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
      'anullsrc=r=22050:cl=mono', '-t', '0.5', silent]);
    fixture(spoken, 440);
    const output = path.join(dir, 'joined.wav');
    await assert.rejects(stitchSpeechSegments([{ text: '不能丢失这句。', audioPath: silent },
      { text: '第二句。', audioPath: spoken }], output), /声音|duration/);
    assert.equal(fs.existsSync(output), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("nonperiodic audio must remain audible when joining on FFmpeg 5.1", async () => {
  const { stitchSpeechSegments } = await stitchModule();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-nonperiodic-'));
  try {
    const input = path.join(dir, 'input.wav'); const output = path.join(dir, 'joined.wav');
    await media.execMediaCommand('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
      'anoisesrc=r=22050:a=0.2:d=2:s=12345', '-c:a', 'pcm_s16le', input]);
    await stitchSpeechSegments([{ text: '这一整段声音必须保留。', audioPath: input }], output);
    const samples = decode(output);
    assert.ok(samples.length / 22050 > 1.99, 'audible source must not be erased');
    const energy = samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length;
    assert.ok(energy > 1000000, 'output must contain sound, not only padding');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
