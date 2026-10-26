import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { captionSpeech, createCaptionService } from '../services/video/captions.mjs';
import { generationBody } from '../services/video/provider.mjs';

const run = promisify(execFile);
const python = process.env.VIDEO_PYTHON_BIN || process.env.MIX_PYTHON_BIN || 'python3';
const available = await run(python, ['-c', 'import rapidocr_onnxruntime, cv2, PIL']).then(() => true, () => false);

test('existing burned subtitles remain byte-for-byte intact without erasure or duplicate overlay', { skip: !available }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'video-caption-preserve-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, 'base.mp4'), burned = join(root, 'burned.mp4'), output = join(root, 'output.mp4');
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=512x768:r=15:d=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', base]);
  const captions = { kind: 'embedded', width: 512, height: 768,
    cues: [{ start: .1, end: 1.8, text: '花了290', box: [80, 550, 430, 590] }] };
  const service = createCaptionService({ VIDEO_PYTHON_BIN: python });
  await service.render(base, burned, captions);
  assert.equal((await service.extract(burned)).kind, 'burned');
  const result = await service.render(burned, output, captions);
  const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
  assert.equal(await hash(output), await hash(burned), 'Existing caption pixels and scene details must not be erased or re-encoded');
  assert.equal(result.preserved, true); assert.equal(result.rendered, false);
});

test('caption wording overrides misheard speech while retaining VAD openings and pauses', () => {
  const captions = { engine: 'rapidocr', cues: [
    { start: .1, end: 1, text: '因为姐妹想看我吃生腌' }, { start: 1, end: 2, text: '有寄生虫的' },
    { start: 2.8, end: 3.5, text: '只要9.9元' },
  ] };
  const timeline = captionSpeech(captions, [{ start: .032, end: 1.9, text: '我吃生烟', words: [] }, { start: 2.75, end: 3.4 }]);
  assert.equal(timeline.text, '因为姐妹想看我吃生腌有寄生虫的只要9.9元');
  assert.equal(timeline.start, .032); assert.equal(timeline.segments[1].start, 2.75);
  const { prompt, payload } = generationBody({ duration: 4, video: { duration: 3.5 }, ratio: '9:16', speech: timeline, captions,
    materials: { photo: { id: 'photo' }, video: { id: 'video' } } });
  assert.match(prompt, /台词来自原视频字幕，优先于听辨结果/); assert.match(prompt, /只要9.9元/);
  assert.doesNotMatch(prompt, /生烟/); assert.equal('referAudioUrl' in payload, false);
  assert.match(prompt, /保留.*字幕/);
  assert.doesNotMatch(prompt, /去除画面叠加的字幕|原字幕将由系统在成片中按原时间线合成/);
});

test('a subtitle spanning a speech pause keeps both spoken intervals for narration', () => {
  const captions = { engine: 'rapidocr', cues: [
    { start: .2, end: 1.7, text: '我从来都不会说' },
    { start: 1.7, end: 3.1, text: '我们家的麻辣烫是' },
    { start: 3.1, end: 4.2, text: '最好吃的' },
    { start: 4.4, end: 6.4, text: '因为味道这个事' },
    { start: 6.4, end: 8.4, text: '它本来就没有一个' },
    { start: 8.4, end: 9.6, text: '标准的答案' },
  ] };
  const intervals = [
    { start: .288, end: 1.408 }, { start: 1.664, end: 3.968 },
    { start: 4.448, end: 5.184 }, { start: 5.504, end: 6.4 },
    { start: 6.624, end: 9.408 },
  ];
  const original = structuredClone(intervals);
  const timeline = captionSpeech(captions, intervals);
  assert.deepEqual(timeline.segments.map(({ start, end, text }) => ({ start, end, text })), [
    { start: .288, end: 1.408, text: '我从来都不会说' },
    { start: 1.664, end: 3.968, text: '我们家的麻辣烫是最好吃的' },
    { start: 4.448, end: 6.4, text: '因为味道这个事' },
    { start: 6.624, end: 9.408, text: '它本来就没有一个标准的答案' },
  ]);
  assert.deepEqual(intervals, original, 'Analysis must not mutate the stored source intervals');
  assert.deepEqual(captionSpeech(captions, timeline.segments), timeline, 'Confirming the same subtitles preserves timing');
});

test('embedded and burned captions preserve text, prices and cue times without changing audio', { skip: !available }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'video-captions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, 'base.mp4'), soft = join(root, 'soft.mp4'), burned = join(root, 'burned.mp4');
  const srt = join(root, 'source.srt');
  await writeFile(srt, '1\n00:00:00,400 --> 00:00:01,400\n因为姐妹想看我吃生腌\n\n2\n00:00:02,000 --> 00:00:03,400\n只要9.9元\n');
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x456789:s=512x768:r=25:d=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', base]);
  await run('ffmpeg', ['-v', 'error', '-y', '-i', base, '-i', srt, '-map', '0', '-map', '1', '-c', 'copy', '-c:s', 'mov_text', soft]);
  const service = createCaptionService({ VIDEO_PYTHON_BIN: python });
  const embedded = await service.extract(soft);
  assert.equal(embedded.kind, 'embedded');
  assert.deepEqual(embedded.cues.map(cue => [cue.start, cue.end, cue.text]),
    [[.4, 1.4, '因为姐妹想看我吃生腌'], [2, 3.4, '只要9.9元']]);
  await service.render(base, burned, embedded);
  const extracted = await service.extract(burned);
  assert.equal(extracted.kind, 'burned');
  assert.deepEqual(extracted.cues.map(cue => cue.text), embedded.cues.map(cue => cue.text));
  for (let i = 0; i < embedded.cues.length; i++) {
    assert.ok(Math.abs(extracted.cues[i].start - embedded.cues[i].start) <= .11);
    assert.ok(Math.abs(extracted.cues[i].end - embedded.cues[i].end) <= .11);
  }
  const corrected = { ...embedded, cues: embedded.cues.map((cue, i) => ({ ...cue, text: i ? '只要8.8元' : cue.text })) };
  const final = join(root, 'final.mp4');
  await service.render(base, final, corrected);
  const output = await service.extract(final);
  assert.deepEqual(output.cues.map(cue => cue.text), ['因为姐妹想看我吃生腌', '只要8.8元']);
  async function audioHash(path) {
    const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', path, '-vn', '-f', 's16le', '-acodec', 'pcm_s16le', '-'], { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024 });
    return createHash('sha256').update(stdout).digest('hex');
  }
  assert.equal(await audioHash(final), await audioHash(base));
  assert.equal(await service.extract(base), null);
});

for (const top of [350, 580]) test(`stationary packaging or a logo at y=${top} is not used as dialogue`, { skip: !available }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'video-caption-logo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, 'base.mp4'), logo = join(root, 'logo.mp4');
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x456789:s=512x768:r=25:d=2',
    '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p', base]);
  const service = createCaptionService({ VIDEO_PYTHON_BIN: python });
  await service.render(base, logo, { kind: 'embedded', width: 512, height: 768,
    cues: [{ start: 0, end: 2, text: '起芽品牌', box: [160, top, 350, top + 40] }] });
  assert.equal(await service.extract(logo), null);
});

test('confirmed subtitles exclude adjacent clothing text and bridge short OCR gaps once', { skip: !available }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'video-caption-clothing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, 'base.mp4'), source = join(root, 'source.mp4');
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x456789:s=512x768:r=25:d=4',
    '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p', base]);
  const service = createCaptionService({ VIDEO_PYTHON_BIN: python });
  await service.render(base, source, { kind: 'embedded', width: 512, height: 768, cues: [
    { start: 0, end: 4, text: '碗碗香', box: [160, 528, 350, 558] },
    { start: .1, end: .8, text: '我从来都不会说', box: [80, 565, 430, 601] },
    { start: 1.2, end: 1.8, text: '我从来都不会说', box: [80, 565, 430, 601] },
    { start: 2, end: 3.6, text: '我们家的麻辣烫', box: [80, 565, 430, 601] },
  ] });
  const extracted = await service.extract(source);
  assert.deepEqual(extracted.cues.map(cue => cue.text), ['我从来都不会说', '我们家的麻辣烫']);
  assert.ok(extracted.cues.every(cue => cue.box[1] > 550), 'Only the confirmed subtitle band is extracted');
  assert.equal(captionSpeech(extracted).text, '我从来都不会说我们家的麻辣烫');
});

test('replacement removes wrong model captions and restores source words and timing without changing audio or signage', { skip: !available }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'video-caption-replace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, 'base.mp4'), source = join(root, 'source.mp4'), wrong = join(root, 'wrong.mp4'), output = join(root, 'output.mp4');
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x456789:s=512x768:r=25:d=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', base]);
  const service = createCaptionService({ VIDEO_PYTHON_BIN: python });
  const captions = { kind: 'burned', width: 512, height: 768, cues: [
    { start: .4, end: 1.4, text: '生腌真好吃', box: [80, 550, 430, 590] },
    { start: 2, end: 3.4, text: '只要9.9元', box: [80, 550, 430, 590] },
  ] };
  await service.render(base, source, captions);
  const original = await service.extract(source);
  assert.deepEqual(original.cues.map(cue => cue.text), captions.cues.map(cue => cue.text));
  await service.render(base, wrong, { ...captions, cues: [
    { start: 0, end: 4, text: '起芽品牌', box: [160, 100, 350, 140] },
    { start: 0, end: 4, text: '好净的钱不莓净', box: [80, 550, 430, 590] },
  ] });
  const before = structuredClone(original);
  const result = await service.render(wrong, output, original, { replaceExisting: true });
  assert.equal(result.rendered, true); assert.equal(result.replaced, true);
  assert.deepEqual(original, before, 'Rendering must not mutate the stored source captions');
  const actual = await service.extract(output);
  assert.deepEqual(actual.cues.map(cue => cue.text), original.cues.map(cue => cue.text));
  for (let i = 0; i < original.cues.length; i++) {
    assert.ok(Math.abs(actual.cues[i].start - original.cues[i].start) <= .11);
    assert.ok(Math.abs(actual.cues[i].end - original.cues[i].end) <= .11);
  }
  const pcm = async path => (await run('ffmpeg', ['-v', 'error', '-i', path, '-vn', '-f', 's16le', '-acodec', 'pcm_s16le', '-'],
    { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024 })).stdout;
  assert.deepEqual(await pcm(output), await pcm(wrong));
  const pixels = async (path, crop) => (await run('ffmpeg', ['-v', 'error', '-ss', '1.6', '-i', path, '-vf', crop,
    '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024 })).stdout;
  // Compare the repaired area with the same frame's plain background, allowing encoder color conversion.
  for (const [reference, referenceCrop, crop] of [[output, 'crop=450:100:30:400', 'crop=450:100:30:520'],
    [wrong, 'crop=400:100:50:70', 'crop=400:100:50:70']]) {
    const expected = await pixels(reference, referenceCrop), corrected = await pixels(output, crop);
    const difference = corrected.reduce((sum, value, i) => sum + Math.abs(value - expected[i]), 0) / corrected.length;
    assert.ok(difference < 3, `Old subtitle pixels must be removed while the sign remains intact (difference=${difference})`);
  }
});
