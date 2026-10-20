import test from 'node:test';
import assert from 'node:assert/strict';
import { generationBody } from '../services/video/provider.mjs';

const task = overrides => ({
  duration: 15,
  ratio: '9:16',
  video: { duration: 12.3 },
  materials: { photo: { id: 'photo-1' }, video: { id: 'video-1' }, voice: { id: 'voice-1' } },
  ...overrides,
});

for (const model of [undefined, 'doubao-seedance-2-0-260128', 'doubao-seedance-2-5-260628']) {
  test(`${model || 'default model'} edits the source with adaptive ratio and duration`, () => {
    for (const ratio of ['9:16', '16:9']) {
      const source = task({ model, ratio });
      const before = structuredClone(source);
      const { payload } = generationBody(source);
      assert.equal(payload.params.mode, 'fusion_video');
      assert.equal(payload.params.scale, 'adaptive');
      assert.equal(payload.params.duration, -1);
      assert.deepEqual(payload.referVideoUrl, ['asset://video-1']);
      assert.deepEqual(source, before, 'Keep measured duration and ratio for display and billing');
    }
  });
}

test('voice prompt includes measured lead-in, interior pause and output-tail silence', () => {
  const request = generationBody(task({
    voice: { duration: 5.8 },
    speech: { start: 0.16, segments: [
      { start: 0.16, end: 9.28, text: '不要九块九，不要八块九，甚至连六块钱都不要了。' },
      { start: 11.232, end: 12.282, text: '真的超好吃。' },
    ] },
  }));

  assert.match(request.prompt, /0\.000–0\.160秒；9\.280–11\.232秒；12\.282秒至成片结束必须保持静音/);
  assert.match(request.prompt, /0\.160–9\.280 秒：不要九块九，不要八块九，甚至连六块钱都不要了。/);
  assert.match(request.prompt, /11\.232–12\.282 秒：真的超好吃。/);
  assert.match(request.prompt, /每段仅说一次/);
  assert.match(request.prompt, /价格、数字、单位按原字说，不改写、不补全、不重复/);
  assert.match(request.prompt, /音频1仅提供音色，不使用音频1的台词/);
  assert.match(request.prompt, /不保留或混入原视频的人声/);
  assert.deepEqual(request.payload.referAudioUrl, ['asset://voice-1']);
});

test('a continuous full-duration speech track does not invent a silent gap', () => {
  const { prompt } = generationBody(task({
    duration: 6,
    video: { duration: 6 },
    voice: {},
    speech: { start: 0, segments: [
      { start: 0, end: 2.5, text: '前半段。' },
      { start: 2.5, end: 6, text: '后半段。' },
    ] },
  }));

  assert.doesNotMatch(prompt, /必须保持静音|秒至成片结束/);
  assert.match(prompt, /最后一段结束后不得补说或复读/);
});

test('silent direct voice uses the original audio transcript even if stale partial subtitles remain', () => {
  const source = task({ voice: {}, voiceEngine: 'seedance', sourceAudioMode: 'silent',
    captions: { cues: [{ start: 0, end: 1, text: '只有这句有字幕' }] },
    speech: { source: 'audio', start: 0, end: 5, segments: [
      { start: 0, end: 1, text: '只有这句有字幕' },
      { start: 2, end: 5, text: '这句没有字幕也必须说出来' },
    ] },
  });
  const { prompt } = generationBody(source);
  assert.match(prompt, /原视频原声转写/);
  assert.match(prompt, /这句没有字幕也必须说出来/);
  assert.doesNotMatch(prompt, /台词来自原视频字幕|优先于听辨结果/);
  assert.match(prompt, /画面字幕可能不完整/);
});

test('rounded-up video duration freezes the end frame without removing real packaging text', () => {
  const { prompt, payload } = generationBody(task());

  assert.match(prompt, /视频1实际时长为12\.300秒/);
  assert.match(prompt, /输出超过原视频时长的部分保持末帧静止、闭嘴和无声/);
  assert.match(prompt, /不增加动作、不重复片段、不延伸表演/);
  assert.match(prompt, /已有字幕保持原样/);
  assert.doesNotMatch(prompt, /去除画面叠加的字幕/);
  assert.match(prompt, /人物以外的场景、商品及包装、背景标识/);
  assert.doesNotMatch(prompt, /原视频人声从第|唯一台词依据/);
  assert.equal(payload.params.duration, -1);
  assert.equal('referAudioUrl' in payload, false);
});

test('direct voice replacement follows original speech emotion rather than the timbre sample performance', () => {
  const request = generationBody(task({
    voice: { duration: 11.35 },
    speech: { start: .16, segments: [{ start: .16, end: 9.28, text: '真的超好吃。' }] },
  }));
  assert.deepEqual(request.payload.referAudioUrl, ['asset://voice-1']);
  assert.match(request.prompt, /视频1原声提供完整的说话情绪/);
  assert.match(request.prompt, /重音、语调、停顿、气口和情绪起伏/);
  assert.match(request.prompt, /不沿用音频1的平淡语气/);
  assert.match(request.prompt, /音频1仅提供音色/);
  assert.match(request.prompt, /不保留或混入原视频的人声/);
});

test('person replacement explicitly edits the numbered video instead of requesting reference generation', () => {
  const { prompt, payload } = generationBody(task());
  assert.match(prompt, /^编辑视频1/);
  assert.match(prompt, /将视频1中的唯一人物完整替换为图片1/);
  assert.doesNotMatch(prompt, /参考视频/);
  assert.match(prompt, /图片1是人物外貌的唯一参考/);
  assert.match(prompt, /脸型、五官/);
  assert.match(prompt, /发型都必须采用图片1/);
  assert.match(prompt, /人物的服装采用图片1/);
  assert.match(prompt, /去掉原人物与图片1不一致的服装、配饰和衣服文字/);
  assert.match(prompt, /替换从第一帧开始并保持到最后一帧/);
  assert.match(prompt, /人物以外的场景/);
  assert.deepEqual(payload.resources, ['asset:\/\/photo-1']);
  assert.deepEqual(payload.referVideoUrl, ['asset:\/\/video-1']);
});

for (const model of ['doubao-seedance-2-0-260128', 'doubao-seedance-2-5-260628']) {
  test(`${model} keeps independent narration scripts out of the person edit request`, () => {
    const source = task({ model, voice: { duration: 10 }, voiceEngine: 'indextts2',
      captions: { cues: [{ start: 0.5, end: 3, text: '这段台词交给独立配音。' }] },
      speech: { start: 0.5, end: 5, segments: [
        { start: 0.5, end: 3, text: '这段台词交给独立配音。' },
        { start: 3.5, end: 5, text: '不要让画面模型重新表演。' },
      ] },
    });
    const before = structuredClone(source);
    const { prompt, payload } = generationBody(source);
    assert.doesNotMatch(prompt, /这段台词交给独立配音|不要让画面模型重新表演|0\.500|3\.500|12\.300/);
    assert.doesNotMatch(prompt, /唯一语音文案|唯一台词依据|配音由系统单独生成/);
    assert.match(prompt, /沿用视频1的动作、表情(?:变化)?、说话节奏/);
    assert.match(prompt, /已有字幕保持原样/);
    assert.deepEqual(payload.resources, ['asset://photo-1']);
    assert.deepEqual(payload.referVideoUrl, ['asset://video-1']);
    assert.equal('referAudioUrl' in payload, false);
    assert.deepEqual(source, before, 'Retain the full speech timeline for independent narration and lip sync');
  });
}
