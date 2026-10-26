import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { generationBody, createVideoProvider, MODELS, PIXVERSE_MODEL, WAN3_MODEL, isWan3Model } from '../services/video/provider.mjs';
import { wan3GenerationBody } from '../services/video/wan3.mjs';
import { restoreSourceAudio, probeVideo } from '../services/video/media.mjs';

const models = MODELS.filter(model => model.id !== PIXVERSE_MODEL);
const kinds = ['photo', 'product', 'background', 'voice'];
for (const model of models) test(`deep ${model.id}: all 16 combinations map only enabled images to the right references`, () => {
  for (let mask = 0; mask < 16; mask++) {
    const replacements = Object.fromEntries(kinds.map((kind, bit) => [kind, Boolean(mask & (1 << bit))]));
    const selectedImages = kinds.slice(0, 3).filter(kind => replacements[kind]);
    const task = { mode: 'deep', model: model.id, replacements, video: { duration: 4 },
      voiceEngine: replacements.voice ? 'chatterbox' : 'seedance', ...(replacements.voice ? { voice: {} } : {}),
      materials: Object.fromEntries(['video', ...selectedImages].map(kind => [kind, { id: isWan3Model(model.id) ? `https://workspace.example/${kind}?signature=test` : kind + '-asset' }])) };
    if (isWan3Model(model.id)) {
      const direct = generationBody(task);
      assert.deepEqual(direct.payload.resources, selectedImages.map(kind => task.materials[kind].id));
      assert.deepEqual(direct.payload.referVideoUrl, [task.materials.video.id]);
      assert.equal(wan3GenerationBody(task).input.prompt, direct.prompt.replaceAll('图片', '图'));
    }
    const body = model.id === WAN3_MODEL ? wan3GenerationBody(task) : generationBody(task);
    const prompt = body.prompt || body.input.prompt;
    if (model.id === WAN3_MODEL) {
      assert.deepEqual(body.input.media, [...selectedImages.map(kind => ({ type: 'reference_image', url: task.materials[kind].id })), { type: 'reference_video', url: task.materials.video.id }]);
      assert.equal(body.parameters.audio, false);
    } else {
      assert.deepEqual(body.payload.resources, selectedImages.map(kind => isWan3Model(model.id) ? task.materials[kind].id : `asset://${kind}-asset`));
      assert.deepEqual(body.payload.referVideoUrl, [isWan3Model(model.id) ? task.materials.video.id : 'asset://video-asset']);
      assert.equal(body.payload.params.generateAudio, false);
      assert.equal(body.payload.referAudioUrl, undefined);
    }
    for (const [kind, phrase] of [['photo', '脸部外貌和发型'], ['product', '中展示的商品'], ['background', '的场景背景']]) {
      if (replacements[kind]) assert.match(prompt, new RegExp(`${phrase}替换为(?:图片|图)${selectedImages.indexOf(kind) + 1}`));
      else assert.match(prompt, new RegExp(`不得替换${{ photo: '人物', product: '商品', background: '背景' }[kind]}`));
    }
    assert.doesNotMatch(prompt, /唯一人物完整替换为图片1|人物外观替换为图片1/);
    assert.match(prompt, /同时完成原视频叠加水印去除和下列明确指定的替换/);
    assert.match(prompt, /抖音\/TikTok.*账号ID.*@用户名.*作者昵称.*相邻角标/);
    assert.match(prompt, /随时间移动.*从第一帧到最后一帧去除/);
    assert.match(prompt, /自然重建被遮挡的背景.*不用模糊、马赛克、色块或裁切画面/);
    assert.match(prompt, /去水印要求优先于背景保留要求/);
    assert.match(prompt, /商品包装文字和场景中的真实招牌不属于水印，不得因去水印而误删/);
    assert.match(prompt, /未指定的非水印、非字幕内容保持原样/);
    for (const request of [body, generationBody({ ...task, captions: { cues: [{ start: 0, end: 4, text: '原片准确字幕' }] } }),
      ...(isWan3Model(model.id) ? [wan3GenerationBody({ ...task, captions: { cues: [{ start: 0, end: 4, text: '原片准确字幕' }] } })] : [])]) {
      const cleanPrompt = request.prompt || request.input.prompt;
      assert.match(cleanPrompt, /去除视频1中画面叠加的台词字幕/);
      assert.match(cleanPrompt, /最终成片不需要字幕，系统也不会补字幕/);
      assert.match(cleanPrompt, /单行、多行、逐字出现、不同位置和不同字体/);
      assert.match(cleanPrompt, /自然重建字幕遮挡的衣服、皮肤、手部、商品和背景纹理/);
      assert.match(cleanPrompt, /不得用模糊、马赛克、色块、涂抹、裁切或覆盖条遮盖字幕/);
      assert.doesNotMatch(cleanPrompt, /正常台词字幕的原文、位置、排版和出现时间保持原样|原字幕将由系统|原片准确字幕/);
      assert.match(cleanPrompt, /商品包装文字和场景中的真实招牌.*不得.*删除/);
    }
  }
});

test('product and background are registered as images with the material provider', async () => {
  const requests = [];
  const credentials = { base: 'https://provider.example', project: 'test', access: 'test', secret: 'test' };
  const provider = createVideoProvider({ video: credentials, material: credentials }, async (_url, options) => {
    requests.push(JSON.parse(options.body)); return Response.json({ data: { materialId: 'image', status: 2 } });
  });
  for (const kind of ['photo', 'product', 'background']) await provider.createMaterial(`https://workspace.example/${kind}`, kind);
  assert.deepEqual(requests.map(body => body.fileType), [1, 1, 1]);
});

for (const audio of [true, false]) test(`original audio restoration removes model audio and preserves source audio=${audio}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'deep-audio-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source.mp4'), generated = join(root, 'generated.mp4'), result = join(root, 'result.mp4');
  const make = (path, seconds, frequency) => execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x320:r=25',
    ...(frequency ? ['-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=16000`] : []),
    '-t', String(seconds), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(frequency ? ['-c:a', 'aac'] : ['-an']), path]);
  make(source, 2, audio ? 440 : null); make(generated, 3, 880);
  await restoreSourceAudio(source, generated, result);
  const metadata = await probeVideo(result);
  assert.equal(metadata.audio, audio); assert.ok(Math.abs(metadata.duration - 2) < .15);
  if (audio) {
    const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', result, '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-f', 's16le', '-']);
    let crossings = 0;
    for (let index = 2; index < pcm.length; index += 2) if (pcm.readInt16LE(index - 2) <= 0 && pcm.readInt16LE(index) > 0) crossings++;
    assert.ok(Math.abs(crossings / (pcm.length / 2 / 16000) - 440) < 5, 'the source tone, not the model tone, must be audible');
  }
});
