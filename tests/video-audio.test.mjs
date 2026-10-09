import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectSpeech, normalizeVoice, alignSpeech } from '../services/video/speech.mjs';

const enabled = Boolean(process.env.VIDEO_PYTHON_BIN || process.env.MIX_PYTHON_BIN);
const voice = fileURLToPath(new URL('./fixtures/replica-speech.wav', import.meta.url));
test('real Silero detects delayed speech and corrected FFmpeg audio within 100 ms, rejects a music tone', { skip: !enabled }, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'replica-audio-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const generated = join(root, 'generated.mp4'), aligned = join(root, 'aligned.mp4');
  const original = await detectSpeech(voice);
  assert.equal(original.length, 2);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=s=320x480:r=25:d=5', '-i', voice,
    '-filter_complex', '[1:a]adelay=1250:all=1,apad[a]', '-map', '0:v', '-map', '[a]', '-t', '5', '-c:v', 'libx264', '-c:a', 'aac', generated]);
  const delayed = await detectSpeech(generated);
  assert.equal(delayed.length, original.length);
  assert.ok(Math.abs(delayed[0].start - original[0].start - 1.25) < 0.1);
  const timeline = intervals => ({ start: intervals[0].start, text: '你好这是一段声音复刻测试',
    segments: intervals.map((interval, index) => ({ ...interval, text: index ? '这是一段声音复刻测试' : '你好',
      words: [{ start: interval.start, end: interval.end, word: index ? '这是一段声音复刻测试' : '你好' }] })) });
  await alignSpeech(generated, aligned, timeline(original), timeline(delayed), 5);
  const corrected = await detectSpeech(aligned);
  assert.equal(corrected.length, original.length);
  for (let i = 0; i < original.length; i++) {
    assert.ok(Math.abs(corrected[i].start - original[i].start) <= 0.1, JSON.stringify(corrected));
    assert.ok(Math.abs(corrected[i].end - original[i].end) <= 0.1, JSON.stringify(corrected));
  }
  const tone = join(root, 'music.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', tone]);
  assert.deepEqual(await detectSpeech(tone), []);
  assert.equal((await normalizeVoice(voice, join(root, 'reference.wav'))).ready, true);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=duration=16', join(root, 'long.wav')]);
  await assert.rejects(normalizeVoice(join(root, 'long.wav'), join(root, 'long-reference.wav')), /2–15/);
});
