import test from 'node:test';
import assert from 'node:assert/strict';
import { translate, UI_COPY } from '../design/workspace-locales.js';
import { setUiLanguage } from '../design/workspace-preferences.js';
import { renderHomeView } from '../design/home.js';

test('English and Malay cover the home interface and interpolate counts', () => {
  for (const [source, translations] of Object.entries(UI_COPY)) {
    assert.ok(translations.en && translations.ms, `missing translation: ${source}`);
  }
  assert.equal(translate('加载更多 {count} 个', 'en', { count: 6 }), 'Load 6 more');
  assert.equal(translate('加载更多 {count} 个', 'ms', { count: 6 }), 'Muat 6 lagi');
  assert.equal(translate('义鹏的门店', 'en'), '义鹏的门店');
});

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const context = () => ({
  esc, icon: () => '', button: (action, text, classes, attrs = '') => `<button data-action="${action}" class="${classes}" ${attrs}>${text}</button>`,
  modules: { image: { title: 'AI 图片', type: 'image' }, video: { title: 'AI 视频', type: 'image' }, mix: { title: 'AI 混剪', type: 'video' }, avatar: { title: '数字人', type: 'video' } },
  assets: [], storeInfo: {}, businessProfileVersion: 0,
  getBusinessBrief: () => ({ industry: 'dining', purpose: 'visit', platform: 'xiaohongshu' }),
});

test('localized home keeps business identifiers and creation actions intact', t => {
  t.after(() => setUiLanguage('zh-CN'));
  setUiLanguage('en');
  const english = renderHomeView(context());
  assert.match(english, /Your business/);
  assert.match(english, /Food &amp; cafés/);
  assert.match(english, /data-action="home-create"/);
  assert.match(english, /value="dining" selected/);
  assert.match(english, /data-skill="图片精修"/);
  assert.match(english, /Photo Retouch/);
  assert.doesNotMatch(english, />创作灵感</);
  setUiLanguage('ms');
  const malay = renderHomeView(context());
  assert.match(malay, /Jenis perniagaan/);
  assert.match(malay, /Makanan &amp; kafe/);
  assert.match(malay, /value="xiaohongshu" selected/);
  assert.match(malay, /Muat 6 lagi/);
});

test('saved preferences survive a new module load and invalid values are ignored', async t => {
  const original = globalThis.localStorage;
  const saved = new Map([['qiya-ui-language', 'ms'], ['qiya-ui-theme', 'dark']]);
  globalThis.localStorage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  t.after(() => { if (original === undefined) delete globalThis.localStorage; else globalThis.localStorage = original; });
  const preferences = await import(`../design/workspace-preferences.js?saved=${crypto.randomUUID()}`);
  assert.equal(preferences.uiLanguage(), 'ms');
  assert.equal(preferences.uiTheme(), 'dark');
  assert.equal(preferences.setUiLanguage('unsupported'), false);
  assert.equal(preferences.setUiTheme('unsupported'), false);
  preferences.setUiLanguage('en'); preferences.setUiTheme('light');
  const reopened = await import(`../design/workspace-preferences.js?reopened=${crypto.randomUUID()}`);
  assert.equal(reopened.uiLanguage(), 'en');
  assert.equal(reopened.uiTheme(), 'light');
});
