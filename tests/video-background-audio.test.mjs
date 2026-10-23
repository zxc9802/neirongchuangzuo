import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createVoiceConversionService } from '../services/video/voice-conversion.mjs';

const sam = 'https://queue.fal.run/fal-ai/sam-audio';
const chatterbox = 'https://queue.fal.run/fal-ai/chatterbox';
const receipt = (root, id) => ({ request_id: id, status_url: `${root}/requests/${id}/status`, response_url: `${root}/requests/${id}` });
function wav(channels, seconds = 4) {
  const rate = 48000, count = Math.round(rate * seconds), bytes = channels.length * 2;
  const data = Buffer.alloc(44 + count * bytes);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(channels.length, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * bytes, 28); data.writeUInt16LE(bytes, 32);
  data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(count * bytes, 40);
  for (let i = 0; i < count; i++) for (let c = 0; c < channels.length; c++)
    data.writeInt16LE(Math.round(channels[c](i / rate) * 32767), 44 + i * bytes + c * 2);
  return data;
}
const tone = (hz, t) => .12 * Math.sin(2 * Math.PI * hz * t);
const speech = t => t >= .5 && t < 3 ? tone(440, t) : 0;
const converted = t => t >= .5 && t < 3 ? tone(220, t) : 0;
const background = wav([t => tone(880, t), t => tone(1320, t)]);
function pcm(path, start = 0, seconds = 4) {
  const bytes = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-ss', String(start), '-t', String(seconds),
    '-ar', '48000', '-ac', '2', '-f', 'f32le', '-']);
  return Array.from({ length: bytes.length / 4 }, (_, i) => bytes.readFloatLE(i * 4));
}
function amplitude(samples, hz, channel) {
  let re = 0, im = 0;
  for (let i = channel; i < samples.length; i += 2) {
    const phase = 2 * Math.PI * hz * Math.floor(i / 2) / 48000;
    re += samples[i] * Math.cos(phase); im += samples[i] * Math.sin(phase);
  }
  return Math.hypot(re, im) * 4 / samples.length;
}
async function fixture(t, options = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'background-audio-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await writeFile(join(folder, 'source.mp4'), wav([t => speech(t) + tone(880, t), t => speech(t) + tone(1320, t)]));
  await writeFile(join(folder, 'reference.wav'), wav([converted]));
  const task = { mode: 'deep', replacements: { voice: true }, video: { audio: true, duration: 4 }, voice: {} };
  const posts = [], uploads = [], downloads = [], saves = [];
  const deps = {
    upload: async path => { uploads.push(basename(path)); return 'https://fal.media/' + basename(path); },
    download: async (url, path) => {
      downloads.push(url);
      if (options.download) await options.download(url);
      await writeFile(path, url.endsWith('/speech.wav') ? wav([speech]) : url.endsWith('/background.wav') ? background : wav([converted], options.convertedDuration ?? 4));
    },
    fetchImpl: async (url, init) => {
      assert.equal(init.headers.Authorization, 'Key test-only');
      if (init.method === 'POST') {
        posts.push({ url, body: JSON.parse(init.body) });
        if (url === `${sam}/separate`) {
          assert.equal(saves.at(-1).separation.submitting, true);
          if (options.submitError) throw options.submitError;
          return Response.json(options.receipt || receipt(sam, 'separate-1'));
        }
        assert.equal(url, `${chatterbox}/speech-to-speech`);
        return Response.json(receipt(chatterbox, 'voice-1'));
      }
      if (url.endsWith('/status')) return Response.json({ status: options.status || 'COMPLETED' });
      if (url.startsWith(sam)) return Response.json(options.result || {
        target: { url: 'https://fal.media/speech.wav' }, residual: { url: 'https://fal.media/background.wav' }, duration: 4, sample_rate: 48000,
      });
      return Response.json({ audio: { url: 'https://fal.media/converted.wav' } });
    },
  };
  let service = createVoiceConversionService({ FAL_KEY: 'test-only' }, deps);
  const save = async () => saves.push(structuredClone(task.voiceConversion));
  return { folder, task, posts, uploads, downloads, saves, get service() { return service; },
    advance: () => service.advance(task, folder, save), restart: () => {
      task.voiceConversion = JSON.parse(JSON.stringify(task.voiceConversion));
      service = createVoiceConversionService({ FAL_KEY: 'test-only' }, deps);
    } };
}

test('deep conversion separates once, converts only speech, and restores stereo background at the original times', async t => {
  const f = await fixture(t);
  await f.advance();
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].url, `${sam}/separate`);
  assert.equal(f.posts[0].body.reranking_candidates, 1);
  f.restart(); await f.advance(); f.restart(); await f.advance(); await f.advance();
  assert.equal(f.task.voiceConversion.ready, true);
  assert.equal(f.task.voiceConversion.separation.ready, true);
  assert.equal(f.posts.length, 2);
  assert.equal(f.posts[1].body.source_audio_url, 'https://fal.media/conversion-source.wav');
  const source = pcm(join(f.folder, 'conversion-source.wav'), 1, 1);
  assert(amplitude(source, 440, 0) > .07);
  assert(amplitude(source, 880, 0) < .001, 'music must not be sent to voice conversion');
  const video = join(f.folder, 'generated.mp4'), output = join(f.folder, 'result.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=s=160x240:r=25:d=4',
    '-f', 'lavfi', '-i', 'sine=frequency=1760:duration=4', '-c:v', 'libx264', '-c:a', 'aac', video]);
  await f.service.mux(video, join(f.folder, 'converted-voice.wav'), output, 4, join(f.folder, 'separated-background.wav'));
  const frames = path => execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:v:0', '-f', 'framemd5', '-']).toString();
  assert.equal(frames(output), frames(video));
  for (const [start, seconds, speaking] of [[.05, .3, false], [1, 1, true], [3.5, .4, false]]) {
    const samples = pcm(output, start, seconds);
    assert(amplitude(samples, 880, 0) > .10, 'left music remains, including speech pauses');
    assert(amplitude(samples, 1320, 1) > .10, 'right music remains');
    assert(amplitude(samples, 880, 1) < .005, 'stereo music is not collapsed to mono');
    if (speaking) assert(amplitude(samples, 220, 0) > .05);
    else assert(amplitude(samples, 220, 0) < .005, 'leading silence and pauses stay aligned');
    assert(amplitude(samples, 440, 0) < .005, 'original speech is not mixed back');
    assert(amplitude(samples, 1760, 0) < .005, 'generated video audio is not mixed back');
  }
  const meta = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,channels', '-of', 'json', output]));
  assert.equal(Number(meta.format.duration), 4);
  assert.equal(meta.streams.find(s => s.codec_type === 'audio').channels, 2);
});

test('separation failures never fall back to whole-track conversion or replay an uncertain paid submission', async t => {
  for (const options of [{ submitError: new Error('lost response') }, { receipt: receipt('https://evil.example', 'separate-1') }]) {
    const f = await fixture(t, options);
    await assert.rejects(f.advance(), { code: 'VIDEO_CONVERSION_UNCERTAIN' });
    f.restart(); await assert.rejects(f.advance(), { code: 'VIDEO_CONVERSION_UNCERTAIN' });
    assert.equal(f.posts.length, 1);
  }
  for (const options of [{ status: 'FAILED' }, { result: { target: { url: 'https://fal.media/speech.wav' } } },
    { result: { target: { url: 'https://fal.media/speech.wav' }, residual: { url: 'https://evil.example/music.wav' } } }]) {
    const f = await fixture(t, options); await f.advance();
    await assert.rejects(f.advance(), { code: 'VIDEO_CONVERSION_FAILED' });
    f.restart(); await assert.rejects(f.advance(), { code: 'VIDEO_CONVERSION_FAILED' });
    assert.equal(f.posts.length, 1);
    assert.equal(f.task.voiceConversion.ready, false);
  }
});

test('separation download retry keeps both original receipts and a pre-dispatch rejection can resume', async t => {
  let attempts = 0;
  const f = await fixture(t, { download: async url => { if (url.endsWith('/background.wav') && !attempts++) throw new Error('network'); } });
  await f.advance(); await assert.rejects(f.advance(), { code: 'VIDEO_CONVERSION_PENDING' });
  assert.equal(f.posts.length, 1);
  f.restart(); await f.advance(); await f.advance();
  assert.equal(f.task.voiceConversion.ready, true); assert.equal(f.posts.length, 2);
  const rejected = await fixture(t, { submitError: Object.assign(new Error('credits'), { providerNotDispatched: true }) });
  await assert.rejects(rejected.advance(), { providerNotDispatched: true });
  assert.equal(rejected.task.voiceConversion.separation.submitting, undefined);
  assert.equal(rejected.task.voiceConversion.separation.failed, undefined);
});

test('existing deep conversion receipts keep their original workflow on upgrade', async t => {
  const f = await fixture(t);
  f.task.voiceConversion = { engine: 'chatterbox', ready: false, id: 'voice-1', sourceUrl: 'https://fal.media/old-source.wav',
    targetUrl: 'https://fal.media/reference.wav', statusUrl: receipt(chatterbox, 'voice-1').status_url, resultUrl: receipt(chatterbox, 'voice-1').response_url };
  await f.advance();
  assert.equal(f.task.voiceConversion.ready, true); assert.equal(f.posts.length, 0);
  assert.equal(f.task.voiceConversion.separation, undefined);
});

test('separation input preserves audio that starts later than the first video frame', async t => {
  const f = await fixture(t);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=s=160x240:r=25:d=4',
    '-itsoffset', '0.4', '-f', 'lavfi', '-i', 'sine=duration=3.6', '-c:v', 'libx264', '-c:a', 'aac', join(f.folder, 'source.mp4')]);
  await f.advance();
  const samples = pcm(join(f.folder, 'separation-source.wav'), 0, .25);
  assert(samples.length > 1000);
  assert(samples.every(sample => Math.abs(sample) < .001));
  const meta = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=sample_rate,channels',
    '-of', 'json', join(f.folder, 'separation-source.wav')]));
  assert.equal(Number(meta.format.duration), 4);
  assert.equal(meta.streams[0].channels, 2); assert.equal(meta.streams[0].sample_rate, '48000');
});

test('short voice output does not cut off music and a missing background cannot silently produce voice-only video', async t => {
  const f = await fixture(t, { convertedDuration: 2 });
  await f.advance(); await f.advance(); await f.advance();
  const video = join(f.folder, 'generated.mp4'), output = join(f.folder, 'result.mp4'), music = join(f.folder, 'separated-background.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=s=160x240:r=25:d=4', '-c:v', 'libx264', video]);
  await f.service.mux(video, join(f.folder, 'converted-voice.wav'), output, 4, music);
  assert(amplitude(pcm(output, 3.5, .4), 880, 0) > .10);
  await rm(music);
  await assert.rejects(f.service.mux(video, join(f.folder, 'converted-voice.wav'), output, 4, music));
});
