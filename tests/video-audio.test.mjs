import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectSpeech, normalizeVoice, alignSpeech, createSpeechService } from '../services/video/speech.mjs';
import { probeVideo } from '../services/video/media.mjs';

const enabled = Boolean(process.env.VIDEO_PYTHON_BIN || process.env.MIX_PYTHON_BIN);
const voice = fileURLToPath(new URL('./fixtures/replica-speech.wav', import.meta.url));
test('speech correction keeps burned-in captions and mouth frames on the corrected audio timeline', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'replica-picture-alignment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const generated = join(root, 'generated.mp4'), aligned = join(root, 'aligned.mp4');
  // A white caption marker appears exactly while its generated line is spoken.
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=black:s=160x240:r=30:d=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-vf',
    "drawbox=x=0:y=160:w=160:h=40:color=white:t=fill:enable='between(t,1,3)+between(t,4,5.5)'",
    '-af', "volume=0:enable='lt(t,1)+between(t,3,4)+gt(t,5.5)'", '-c:v', 'libx264', '-c:a', 'aac', generated]);
  const timeline = windows => ({ start: windows[0][0], text: '甲乙', segments: windows.map(([start, end], i) => ({
    start, end, text: i ? '乙' : '甲', words: [{ start, end, word: i ? '乙' : '甲' }],
  })) });
  const generatedTimeline = timeline([[1, 3], [4, 5.5]]);
  const joined = { start: 0.2, text: '甲乙', segments: [{ start: 0.2, end: 3.7, text: '甲乙' }] };
  for (const [original, checks] of [
    [timeline([[0.2, 2], [3, 4.5]]), [[0.4, true], [2.4, false], [3.2, true], [5.5, false]]],
    // When one target line spans two VAD islands, remove the picture pause too.
    [joined, [[0.4, true], [2.4, true], [3.2, true], [4.2, false]]],
  ]) {
    await alignSpeech(generated, aligned, original, generatedTimeline, 6);
    for (const [time, speaking] of checks) {
      const pixel = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(time), '-i', aligned,
        '-vf', 'crop=2:2:80:180', '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1']);
      const pcm = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(time), '-i', aligned,
        '-t', '0.1', '-vn', '-ar', '16000', '-ac', '1', '-f', 'f32le', 'pipe:1']);
      const samples = Array.from({ length: pcm.length / 4 }, (_, i) => pcm.readFloatLE(i * 4));
      const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
      assert.equal(rms > 0.01, speaking, `audio at ${time}s`);
      assert.equal(pixel[0] > 200, speaking, `caption/mouth frame at ${time}s must follow the same speech window`);
    }
    assert.ok(Math.abs((await probeVideo(aligned)).duration - 6) < 0.1);
  }
});

test('analysis preserves VAD and ASR diagnostics when a closing speech interval has no recognized words', { skip: !enabled }, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'replica-asr-diagnostic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'source.wav'), diagnosticPath = join(root, 'verification-source.json');
  await writeFile(input, await readFile(voice));
  const intervals = await detectSpeech(input);
  assert.equal(intervals.length, 2);
  const words = [{ word: '你好', start: intervals[0].start, end: intervals[0].end }];
  const speech = createSpeechService({
    VIDEO_TRANSCRIPTION_API_KEY: 'test-no-network',
    VIDEO_TRANSCRIPTION_BASE_URL: 'https://transcription.example',
    VIDEO_PYTHON_BIN: process.env.VIDEO_PYTHON_BIN || process.env.MIX_PYTHON_BIN,
  }, async () => new Response(JSON.stringify({ text: '你好', words }), { headers: { 'content-type': 'application/json' } }));
  const timeline = await speech.analyze(input, 5, { diagnosticsPath: diagnosticPath });
  assert.equal(timeline.text, '你好'); assert.equal(timeline.end, intervals[1].end); assert.match(timeline.warning, /核对/);
  const diagnostic = JSON.parse(await readFile(diagnosticPath, 'utf8'));
  assert.deepEqual(diagnostic.vad, intervals);
  assert.deepEqual(diagnostic.asr, { text: '你好', words });
  assert.deepEqual(diagnostic.timeline, timeline);
  assert.equal(diagnostic.error, undefined);
  await assert.rejects(readFile(input + '.asr.wav'), { code: 'ENOENT' });
});

test('analysis continues to transcription when the real detector finds no speech', { skip: !enabled }, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'replica-empty-vad-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'source.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '3', input]);
  let transcriptions = 0;
  const speech = createSpeechService({
    VIDEO_TRANSCRIPTION_API_KEY: 'test-no-network', VIDEO_TRANSCRIPTION_BASE_URL: 'https://transcription.example',
    VIDEO_PYTHON_BIN: process.env.VIDEO_PYTHON_BIN || process.env.MIX_PYTHON_BIN,
  }, async () => {
    transcriptions++;
    return Response.json({ text: '你好', words: [{ word: '你好', start: 1, end: 2 }] });
  });
  const timeline = await speech.analyze(input, 3);
  assert.equal(transcriptions, 1); assert.equal(timeline.text, '你好'); assert.equal(timeline.timingSource, 'asr');
  assert.equal(timeline.start, 1); assert.equal(timeline.end, 2); assert.match(timeline.warning, /核对/);
});

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
  const playlist = join(root, 'playlist.mp3');
  await writeFile(playlist, `#EXTM3U\n${voice}\n`);
  await assert.rejects(normalizeVoice(playlist, join(root, 'invalid.wav')), /MP3 \/ WAV/);
  const mp3 = join(root, 'voice.mp3');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', voice, mp3]);
  assert.equal((await normalizeVoice(mp3, join(root, 'mp3-reference.wav'))).ready, true);
  const tone = join(root, 'music.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', tone]);
  assert.deepEqual(await detectSpeech(tone), []);
  assert.equal((await normalizeVoice(voice, join(root, 'reference.wav'))).ready, true);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=duration=16', join(root, 'long.wav')]);
  await assert.rejects(normalizeVoice(join(root, 'long.wav'), join(root, 'long-reference.wav')), /2–15/);
});
