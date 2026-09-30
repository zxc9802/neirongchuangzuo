import test from 'node:test';
import assert from 'node:assert/strict';
import { selectImagePreset, handleImagePresetAction, renderImagePresetEntry } from '../design/image-preset-ui.js';
import { buildPresetPrompt, getPresetDefaults } from '../design/image-presets.js';

function harness(overrides = {}) {
  const config = { prompt: '', files: ['original'], ratio: '1:1', quality: 'auto', skill: '活动海报', ...overrides };
  const navigations = [];
  const ctx = {
    configs: { image: config }, storeInfo: {},
    beginCreation: mode => navigations.push(mode),
    openModal: () => assert.fail('Selecting a style must not require opening a form'),
    esc: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    button: (action, label, className = '', attrs = '') => `<button data-action="${action}" class="${className}" ${attrs}>${label}</button>`,
  };
  return { config, ctx, navigations };
}

test('selecting a style prepares a valid image request immediately while retaining originals', () => {
  const { config, ctx, navigations } = harness({ brief: { product: '旧方案' }, contentPlan: { title: '旧计划' } });
  selectImagePreset(ctx, 'factory-poster');
  assert.equal(config.prompt, buildPresetPrompt('factory-poster', getPresetDefaults('factory-poster')));
  assert.equal(config.ratio, '3:4');
  assert.equal(config.quality, 'medium');
  assert.deepEqual(config.files, ['original']);
  assert.equal(config.brief, undefined);
  assert.equal(config.contentPlan, undefined);
  assert.deepEqual(navigations, ['image']);
  const html = renderImagePresetEntry(ctx);
  assert.match(html, /data-action="image-preset-select"/);
  assert.match(html, /修改文案（选填）/);
  assert.doesNotMatch(html, /<form|套用到创作区/);
});

test('reselecting the active style preserves manual prompt and output settings, accepting homepage originals', () => {
  const { config, ctx } = harness();
  selectImagePreset(ctx, 'factory-poster');
  config.prompt += '\n只显示我提供的商标';
  config.ratio = '16:9';
  config.quality = 'low';
  const before = structuredClone(config);
  const homepageFiles = ['homepage-photo'];
  selectImagePreset(ctx, 'factory-poster', { initialFiles: homepageFiles });
  assert.deepEqual({ ...config, files: before.files }, before);
  assert.deepEqual(config.files, ['homepage-photo']);
  homepageFiles.push('later-change');
  assert.deepEqual(config.files, ['homepage-photo']);
});

test('untouched styles use their own copy while keeping the merchant name', () => {
  const { config, ctx } = harness();
  ctx.storeInfo.name = '青禾加工';
  selectImagePreset(ctx, 'factory-poster');
  selectImagePreset(ctx, 'xiaohongshu-cover');
  assert.deepEqual(config.imagePreset.fields, { ...getPresetDefaults('xiaohongshu-cover'), businessName: '青禾加工' });
  assert.equal(config.quality, 'high');
  assert.doesNotMatch(config.prompt, /好工艺，看细节/);
});

test('switching layouts carries edited copy without sharing saved field objects', () => {
  const { config, ctx } = harness();
  selectImagePreset(ctx, 'factory-poster');
  const priorFields = config.imagePreset.fields;
  priorFields.title = '我们的实际样件';
  priorFields.points = '材料确认\n表面细节';
  priorFields.subtitle = '';
  config.prompt = buildPresetPrompt('factory-poster', priorFields);
  config.imagePreset.appliedPrompt = config.prompt;
  selectImagePreset(ctx, 'xiaohongshu-cover');
  assert.deepEqual(config.imagePreset.fields, priorFields);
  assert.notEqual(config.imagePreset.fields, priorFields);
  assert.match(config.prompt, /我们的实际样件/);
  assert.match(config.prompt, /2块编号便签/);
  assert.doesNotMatch(config.prompt, /找加工厂，这4点先说清/);
});

test('undo restores an imported prompt and plan without discarding the currently selected originals', () => {
  const before = { prompt: 'Agent 整理的门店推广要求', ratio: '9:16', quality: 'low', skill: '门店宣传', brief: { product: '真实套餐' }, contentPlan: { title: '已确认计划' } };
  const { config, ctx } = harness(before);
  selectImagePreset(ctx, 'xiaohongshu-cover', { initialFiles: ['homepage-photo'] });
  assert.match(renderImagePresetEntry(ctx), /撤销切换/);
  config.files.push('new-upload');
  assert.equal(handleImagePresetAction('image-preset-undo', { dataset: {} }, ctx), true);
  assert.deepEqual(config, { ...before, files: ['homepage-photo', 'new-upload'] });
  assert.doesNotMatch(renderImagePresetEntry(ctx), /撤销切换/);
});

test('a stale undo cannot overwrite later prompt edits or a restored draft', () => {
  const { config, ctx } = harness({ prompt: '先前要求' });
  selectImagePreset(ctx, 'factory-poster');
  config.prompt += '\n后续手动修改';
  const edited = structuredClone(config);
  handleImagePresetAction('image-preset-undo', { dataset: {} }, ctx);
  assert.deepEqual(config, edited);
  assert.doesNotMatch(renderImagePresetEntry(ctx), /撤销切换/);
  ctx.configs.image = { prompt: '恢复的草稿', files: [], ratio: '4:3', quality: 'auto', skill: '活动海报' };
  const restored = structuredClone(ctx.configs.image);
  handleImagePresetAction('image-preset-undo', { dataset: {} }, ctx);
  assert.deepEqual(ctx.configs.image, restored);
});

test('unknown styles leave the existing work untouched', () => {
  const { config, ctx, navigations } = harness({ prompt: '已有要求' });
  const before = structuredClone(config);
  selectImagePreset(ctx, 'unknown', { initialFiles: [] });
  assert.deepEqual(config, before);
  assert.deepEqual(navigations, []);
});

test('direct and repeated style selection focus the newly rendered active button without scrolling', t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
    else delete globalThis.document;
  });
  const { config, ctx } = harness();
  const events = [];
  let renderedButton;
  ctx.beginCreation = mode => {
    assert.equal(mode, 'image');
    const id = config.imagePreset.id;
    events.push(['render', id]);
    renderedButton = { id, focus: options => events.push(['focus', id, options]) };
  };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      querySelector(selector) {
        assert.equal(selector, `.image-preset-shortcuts [data-action="image-preset-select"][data-id="${renderedButton.id}"][aria-pressed="true"]`);
        return renderedButton;
      },
    },
  });
  for (const id of ['factory-poster', 'xiaohongshu-cover', 'xiaohongshu-cover']) selectImagePreset(ctx, id);
  assert.deepEqual(events, ['factory-poster', 'xiaohongshu-cover', 'xiaohongshu-cover'].flatMap(id => [
    ['render', id], ['focus', id, { preventScroll: true }],
  ]));
});
