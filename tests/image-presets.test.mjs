import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IMAGE_PRESETS,
  PRESET_FIELD_LIMITS,
  getImagePreset,
  getPresetDefaults,
  validatePresetFields,
  buildPresetPrompt,
  imageTaskTitle,
} from '../design/image-presets.js';

test('work titles extract bounded business headings and fall back to output mode instead of production instructions', () => {
  const prompt = buildPresetPrompt('factory-poster', getPresetDefaults('factory-poster'));
  assert.equal(imageTaskTitle({ prompt }), '好工艺，看细节');
  assert.equal(imageTaskTitle({ prompt: '设计3:4竖版工厂宣传海报。深海军蓝、金属灰。', generationMode: 'series' }), '统一风格套图');
  assert.equal(imageTaskTitle({ prompt: '主标题：\n【制作约束】保留设备', generationMode: 'variations' }), '同主题多风格');
  assert.equal(imageTaskTitle({ prompt: '主标题：   \r\n副标题：不是主标题' }), '图片作品');
  assert.equal(imageTaskTitle({ generationMode: 'constructor' }), '图片作品');
  assert.equal(imageTaskTitle(null), '图片作品');
  assert.equal(imageTaskTitle({ prompt: '主标题：' + '🌱'.repeat(40) }), '🌱'.repeat(32));
});

test('preset defaults are isolated and preserve their recommended ratio and quality', () => {
  assert.equal(IMAGE_PRESETS.length, 2);
  for (const preset of IMAGE_PRESETS) {
    const first = getPresetDefaults(preset.id);
    first.title = '修改后的标题';
    first.points = '修改后的要点';
    assert.notEqual(getPresetDefaults(preset.id).title, first.title);
    assert.notEqual(getPresetDefaults(preset.id).points, first.points);
    assert.deepEqual(validatePresetFields(preset.id, getPresetDefaults(preset.id)), {});
    assert.equal(preset.ratio, '3:4');
    assert.match(preset.cover, /^\/media\/ai-industrial-.+\.png$/);
  }
  assert.equal(getImagePreset('factory-poster').quality, 'medium');
  assert.equal(getImagePreset('xiaohongshu-cover').quality, 'high');
});

test('custom copy fully replaces defaults without inventing optional business or contact copy', () => {
  const fields = {
    businessName: '测试加工车间',
    title: '来看看这组样件',
    subtitle: '先核对需求再确认制作',
    points: '不锈钢样件｜查看实际表面\n装配细节｜按图核对孔位',
    callToAction: '留言沟通样件用途',
  };
  for (const preset of IMAGE_PRESETS) {
    const prompt = buildPresetPrompt(preset.id, fields);
    for (const value of Object.values(fields).flatMap(value => value.split('\n'))) assert.ok(prompt.includes(value));
    for (const value of Object.values(preset.defaults).filter(Boolean).flatMap(value => value.split('\n'))) assert.ok(!prompt.includes(value));
    const optionalBlank = buildPresetPrompt(preset.id, { ...fields, businessName: '', subtitle: '', callToAction: '' });
    for (const field of ['businessName', 'subtitle', 'callToAction']) assert.ok(!optionalBlank.includes(fields[field]));
    assert.ok(!optionalBlank.includes('商家 / 企业名称：'));
    assert.ok(!optionalBlank.includes('副标题：'));
    assert.ok(!optionalBlank.includes('咨询引导：'));
  }
});

test('factory and Xiaohongshu layouts differ and the card count follows the provided points', () => {
  const fields = { ...getPresetDefaults('factory-poster'), points: '实际加工过程\n真实检验记录' };
  const poster = buildPresetPrompt('factory-poster', fields);
  const cover = buildPresetPrompt('xiaohongshu-cover', fields);
  assert.match(poster, /照片约占70%/);
  assert.match(poster, /深海军蓝/);
  assert.match(poster, /2条要点/);
  assert.match(cover, /文字约占70%/);
  assert.match(cover, /米白纸张底/);
  assert.match(cover, /2块编号便签/);
  assert.doesNotMatch(cover, /4块编号便签|四张|2乘2/);
  const single = buildPresetPrompt('xiaohongshu-cover', { ...fields, points: '唯一要点' });
  assert.match(single, /1块编号便签/);
  for (const prompt of [poster, cover]) {
    assert.match(prompt, /保留原图设备、刀具和零件结构/);
    assert.match(prompt, /不虚构企业身份、价格、产能、认证、客户、精度、交期/);
    assert.match(prompt, /预设示例图仅说明风格，不作为本次素材/);
  }
});

test('unknown presets and malformed field values are rejected without fallback or coercion', () => {
  for (const id of ['unknown', '__proto__', '', null, 42]) {
    assert.equal(getImagePreset(id), undefined);
    assert.throws(() => getPresetDefaults(id), /有效的生图预设/);
    assert.ok(validatePresetFields(id, {})._preset);
    assert.throws(() => buildPresetPrompt(id, {}), /有效的生图预设/);
  }
  for (const fields of [null, undefined, [], '文字', 42]) {
    assert.ok(validatePresetFields('factory-poster', fields)._form);
    assert.throws(() => buildPresetPrompt('factory-poster', fields), /有效的预设内容/);
  }
  for (const field of Object.keys(getPresetDefaults('factory-poster'))) {
    for (const value of [42, null, undefined, {}, ['一条']]) {
      const fields = { ...getPresetDefaults('factory-poster'), [field]: value };
      assert.match(validatePresetFields('factory-poster', fields)[field], /必须填写文字/);
      assert.throws(() => buildPresetPrompt('factory-poster', fields), /必须填写文字/);
    }
  }
});

test('required copy and point length/count limits reject mistakes rather than truncate', () => {
  const valid = getPresetDefaults('factory-poster');
  for (const title of ['', ' \r\n ']) assert.match(validatePresetFields('factory-poster', { ...valid, title }).title, /填写主标题/);
  for (const points of ['', '\n\r\n', '一\n二\n三\n四\n五']) {
    assert.match(validatePresetFields('factory-poster', { ...valid, points }).points, /1–4 条/);
    assert.throws(() => buildPresetPrompt('factory-poster', { ...valid, points }), /1–4 条/);
  }
  const tooLong = { ...valid, points: '点'.repeat(PRESET_FIELD_LIMITS.point + 1) };
  assert.match(validatePresetFields('factory-poster', tooLong).points, /最多 60 字/);
  assert.throws(() => buildPresetPrompt('factory-poster', tooLong), /最多 60 字/);
  for (const field of ['businessName', 'title', 'subtitle', 'callToAction']) {
    const fields = { ...valid, [field]: '字'.repeat(PRESET_FIELD_LIMITS[field] + 1) };
    assert.ok(validatePresetFields('factory-poster', fields)[field]);
    assert.throws(() => buildPresetPrompt('factory-poster', fields), /最多/);
  }
});

test('CRLF and blank lines preserve meaningful point copy with the correct number of cards', () => {
  const fields = { ...getPresetDefaults('xiaohongshu-cover'), points: '\r\n  材料要求｜不锈钢  \r\n \r\n加工数量｜先确认样件\r\n' };
  assert.deepEqual(validatePresetFields('xiaohongshu-cover', fields), {});
  const prompt = buildPresetPrompt('xiaohongshu-cover', fields);
  assert.match(prompt, /2块编号便签/);
  assert.match(prompt, /要点1：材料要求｜不锈钢\n要点2：加工数量｜先确认样件/);
  assert.doesNotMatch(prompt, /\r/);
});

test('maximum valid copy is preserved and remains within the image API prompt limit', () => {
  const fields = {
    businessName: '企'.repeat(PRESET_FIELD_LIMITS.businessName),
    title: '题'.repeat(PRESET_FIELD_LIMITS.title),
    subtitle: '副'.repeat(PRESET_FIELD_LIMITS.subtitle),
    points: ['甲', '乙', '丙', '丁'].map(character => character.repeat(PRESET_FIELD_LIMITS.point)).join('\r\n'),
    callToAction: '询'.repeat(PRESET_FIELD_LIMITS.callToAction),
  };
  for (const preset of IMAGE_PRESETS) {
    assert.deepEqual(validatePresetFields(preset.id, fields), {});
    const prompt = buildPresetPrompt(preset.id, fields);
    assert.ok(prompt.length <= 1000, `${preset.id} has ${prompt.length} characters`);
    for (const value of Object.values(fields).flatMap(value => value.split('\r\n'))) assert.ok(prompt.includes(value));
  }
});
