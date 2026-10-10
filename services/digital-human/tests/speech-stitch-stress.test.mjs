import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { execMediaCommand, probeMedia } from "../src/lib/engine/ffmpeg.ts";
import { splitSpeechText, stitchSpeechSegments } from "../src/lib/engine/speech-stitch.ts";

function decode(file) {
  const result = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", "22050", "-f", "s16le", "-"], { maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, String(result.stderr));
  const samples = new Int16Array(result.stdout.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = result.stdout.readInt16LE(i * 2);
  return samples;
}

function silentRuns(samples) {
  const runs = []; let start = -1;
  for (let i = 0; i <= samples.length; i++) {
    if (i < samples.length && Math.abs(samples[i]) <= 2) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      const duration = (i - start) / 22050;
      if (duration > 0.04) runs.push(duration);
      start = -1;
    }
  }
  return runs;
}

async function fixture(file, { rate = 22050, channels = 1, amplitude = 0.1, codec = "pcm_s16le", seed = 12345 } = {}) {
  const gate = "if(between(t,0.25,0.55)+between(t,0.73,1.1),val(0),0)";
  await execMediaCommand("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i",
    `anoisesrc=r=${rate}:a=${amplitude}:d=1.6:s=${seed}`, "-af", `aeval=${gate.replaceAll(",", "\\,")}`,
    "-ac", String(channels), "-c:a", codec, file]);
}

async function workers(items, count, run) {
  let cursor = 0;
  const results = await Promise.allSettled(Array.from({ length: count }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await run(items[index], index);
    }
  }));
  const failed = results.find(result => result.status === "rejected");
  if (failed) throw failed.reason;
}

test("speech matrix preserves quiet, loud, mono, stereo, PCM, float and MP3 segments", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speech-matrix ' 中文-"));
  const cases = [];
  for (const rate of [16000, 22050, 44100, 48000]) {
    for (const channels of [1, 2]) {
      for (const amplitude of [0.004, 0.1, 0.9]) {
        for (const codec of ["pcm_s16le", "pcm_f32le", "libmp3lame"]) cases.push({ rate, channels, amplitude, codec });
      }
    }
  }
  const started = performance.now();
  try {
    await workers(cases, 4, async (options, index) => {
      const input = path.join(dir, `input-${index}.${options.codec === "libmp3lame" ? "mp3" : "wav"}`);
      const output = path.join(dir, `joined-${index}.wav`);
      await fixture(input, options);
      try {
        await stitchSpeechSegments([{ text: "不能遗漏前后两个词。", audioPath: input }], output);
      } catch (error) { throw new Error(`${JSON.stringify(options)}: ${error.message}`); }
      const media = await probeMedia(output);
      assert.equal(media.sampleRate, 22050, JSON.stringify(options));
      assert.equal(media.audioChannels, 1, JSON.stringify(options));
      assert.ok(media.durationSeconds > 0.82 && media.durationSeconds < 1.06, `${JSON.stringify(options)}: ${media.durationSeconds}`);
      const samples = decode(output);
      const gap = silentRuns(samples);
      assert.ok(gap.some(duration => duration > 0.1 && duration < 0.23), `internal pause was removed: ${JSON.stringify(options)} ${gap}`);
      assert.ok(Math.max(...samples.subarray(0, 10000).map(Math.abs)) > 60, `quiet audio was erased: ${JSON.stringify(options)}`);
    });
    console.log(JSON.stringify({ stress: "audio-matrix", cases: cases.length, concurrency: 4, elapsedMs: Math.round(performance.now() - started) }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("concurrent and long speech joins preserve every segment without crossing task files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speech-concurrent-"));
  const concurrency = process.env.SPEECH_STRESS === "1" ? 8 : 4;
  const longCount = process.env.SPEECH_STRESS === "1" ? 120 : 24;
  const started = performance.now();
  try {
    const sources = [];
    for (let i = 0; i < 4; i++) {
      const input = path.join(dir, `source-${i}.wav`);
      const trimmed = path.join(dir, `trimmed-${i}.wav`);
      await fixture(input, { rate: [16000, 22050, 44100, 48000][i], seed: 12345 + i });
      await stitchSpeechSegments([{ text: "一段话。", audioPath: input }], trimmed);
      sources.push({ input, duration: (await probeMedia(trimmed)).durationSeconds, samples: decode(trimmed) });
    }
    const cases = Array.from({ length: concurrency }, (_, index) => index);
    await workers(cases, concurrency, async index => {
      const count = index === 0 ? longCount : 12;
      const parts = Array.from({ length: count }, (_, part) => ({ text: "必须保留这一整句。", audioPath: sources[(index + part) % sources.length].input }));
      const output = path.join(dir, `task-${index}.wav`);
      await stitchSpeechSegments(parts, output);
      const samples = decode(output);
      const expected = Array.from({ length: count }, (_, part) => sources[(index + part) % sources.length].duration).reduce((a, b) => a + b, 0) + (count - 1) * 0.18;
      assert.ok(Math.abs(samples.length / 22050 - expected) < 0.02, `segments missing from task ${index}`);
      let offset = 0;
      for (let part = 0; part < count; part++) {
        const source = sources[(index + part) % sources.length];
        const anchor = Math.floor(source.samples.length / 4);
        assert.deepEqual(samples.subarray(offset + anchor, offset + anchor + 500), source.samples.subarray(anchor, anchor + 500), `order/content mismatch: task ${index}, part ${part}`);
        offset += source.samples.length + (part < count - 1 ? Math.round(0.18 * 22050) : 0);
      }
    });
    assert.equal(fs.readdirSync(dir).filter(file => file.startsWith(".tts-join-")).length, 0, "temporary directories leaked");
    console.log(JSON.stringify({ stress: "long-and-concurrent", concurrency, segments: longCount + (concurrency - 1) * 12, elapsedMs: Math.round(performance.now() - started), rssBytes: process.memoryUsage().rss }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("silent, corrupt and missing input cannot produce a partial delivery or leave join directories", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speech-invalid-"));
  try {
    const valid = path.join(dir, "valid.wav"); const silent = path.join(dir, "silent.wav");
    await fixture(valid);
    await execMediaCommand("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=22050:cl=mono", "-t", "0.5", silent]);
    const corrupt = path.join(dir, "corrupt.wav"); fs.writeFileSync(corrupt, "not an audio file");
    const empty = path.join(dir, "empty.wav"); fs.writeFileSync(empty, "");
    for (const invalid of [silent, corrupt, empty, path.join(dir, "missing.wav")]) {
      const output = path.join(dir, "failed.wav");
      await assert.rejects(stitchSpeechSegments([{ text: "成功的一段。", audioPath: valid }, { text: "不可丢失的一段。", audioPath: invalid }], output));
      assert.equal(fs.existsSync(output), false, "partial audio was delivered");
      assert.equal(fs.readdirSync(dir).filter(file => file.startsWith(".tts-join-")).length, 0);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("maximum-length multilingual scripts retain all spoken characters within provider segment limits", () => {
  const units = ["我们来海南旅居，", "价格1800元、3.5万元。", "床、衣柜和沙发都有！", "Wi-Fi和电视都能用；", "评论区扣个‘1’。", "你好🙂家人们，", "Supercalifragilisticexpialidocious中文测试"];
  let state = 12345;
  for (let count = 0; count < 500; count++) {
    const length = 1 + count % 100;
    let text = "";
    for (let i = 0; i < length; i++) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; text += units[state % units.length]; }
    text = text.slice(0, 5000);
    const parts = splitSpeechText(text);
    assert.equal(parts.join(""), text);
    assert.ok(parts.every(part => Array.from(part).length <= 50));
  }
});
