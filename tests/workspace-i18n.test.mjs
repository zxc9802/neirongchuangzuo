import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createInterfaceLocalizer } from '../design/workspace-i18n.js';
import { UI_COPY } from '../design/workspace-locales.js';
import { uiLocaleInventory } from '../scripts/ui-locale-inventory.mjs';

function fixture(t, body) {
  const { document, window } = parseHTML(`<!doctype html><html lang="en"><head></head><body>${body}</body></html>`);
  const localizer = createInterfaceLocalizer({ document, Observer: window.MutationObserver });
  t.after(() => localizer.stop());
  localizer.start();
  return { document, localizer, language(value) { document.documentElement.lang = value; localizer.localize(); } };
}

test('all extracted interface strings include both English and Malay with unchanged placeholders', async () => {
  const inventory = await uiLocaleInventory();
  const missing = inventory.filter(item => !UI_COPY[item.text]);
  assert.deepEqual(missing, [], 'new interface strings need translations');
  const placeholders = value => [...value.matchAll(/\{\w+\}/g)].map(match => match[0]).sort();
  for (const { text } of inventory) for (const language of ['en', 'ms']) {
    assert.ok(UI_COPY[text][language]?.trim(), `${language}: ${text}`);
    assert.deepEqual(placeholders(UI_COPY[text][language]), placeholders(text), `${language} placeholders: ${text}`);
  }
});

test('forms translate labels and accessibility copy while retaining field names and option values', t => {
  const f = fixture(t, '<label>脚本语言<select name="script-language"><option>中文</option><option value="ms">马来语</option></select></label><input name="title" placeholder="给提示词起个名字" value="门店发现"><button aria-label="关闭弹窗">关闭</button>');
  const select = f.document.querySelector('select');
  assert.equal(select.name, 'script-language');
  assert.equal(select.firstElementChild.value, '中文');
  assert.equal(select.lastElementChild.value, 'ms');
  assert.equal(f.document.querySelector('input').value, '门店发现');
  assert.equal(f.document.querySelector('button').textContent, 'Close');
  assert.notEqual(f.document.querySelector('input').getAttribute('placeholder'), '给提示词起个名字');
  f.language('ms');
  assert.equal(f.document.querySelector('button').textContent, 'Tutup');
  assert.equal(select.firstElementChild.value, '中文');
  f.language('zh-CN');
  assert.equal(f.document.querySelector('button').textContent, '关闭');
  assert.equal(f.document.querySelector('button').getAttribute('aria-label'), '关闭弹窗');
});

test('user copy, AI output, file names and rich editors are never translated even when matching UI labels', t => {
  const f = fixture(t, '<textarea>门店发现</textarea><div contenteditable="true" data-placeholder="描述画面、镜头、氛围和声音…">生成视频</div><div class="markdown-body">门店发现</div><strong data-no-i18n>首页</strong><div class="generated-asset-copy"><h2>门店发现</h2></div><button>生成视频</button>');
  assert.equal(f.document.querySelector('textarea').textContent, '门店发现');
  assert.equal(f.document.querySelector('[contenteditable]').textContent, '生成视频');
  assert.equal(f.document.querySelector('[contenteditable]').getAttribute('data-placeholder'), 'Describe the visuals, camera shots, atmosphere and audio…');
  assert.equal(f.document.querySelector('.markdown-body').textContent, '门店发现');
  assert.equal(f.document.querySelector('[data-no-i18n]').textContent, '首页');
  assert.equal(f.document.querySelector('h2').textContent, '门店发现');
  assert.notEqual(f.document.querySelector('button').textContent, '生成视频');
});

test('late dialogs and replacement status text are localized without an application rerender', async t => {
  const f = fixture(t, '<main><p id="status">正在上传…</p></main>');
  const main = f.document.querySelector('main');
  main.insertAdjacentHTML('beforeend', '<section><h3>画面比例</h3><button>取消</button></section>');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.notEqual(main.querySelector('h3').textContent, '画面比例');
  assert.equal(main.querySelector('button').textContent, 'Cancel');
  f.document.querySelector('#status').textContent = '生成失败';
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.document.querySelector('#status').textContent, UI_COPY['生成失败'].en);
  f.language('ms');
  assert.equal(f.document.querySelector('#status').textContent, UI_COPY['生成失败'].ms);
});

test('dynamic counters translate without changing their numeric values or identifiers', t => {
  const f = fixture(t, '<p>已选 3/30</p>');
  const p = f.document.querySelector('p');
  assert.match(p.textContent, /3\/30/);
  assert.doesNotMatch(p.textContent, /已选/);
  f.language('ms');
  assert.match(p.textContent, /3\/30/);
  f.language('zh-CN');
  assert.equal(p.textContent, '已选 3/30');
});

test('material controls and composite counters round-trip while preserving file names and editor tokens', t => {
  const f = fixture(t, '<p>无限积分 · 6 张</p><button aria-label="替换 一品厨门头.jpg">图片1</button><div contenteditable="true">@图片1 保留门头</div><span class="vc-task-copy"><strong>一品厨门店</strong></span>');
  const button = f.document.querySelector('button');
  assert.equal(f.document.querySelector('p').textContent, 'Unlimited · 6 images');
  assert.equal(button.textContent, 'Image 1');
  assert.equal(button.getAttribute('aria-label'), 'Replace 一品厨门头.jpg');
  f.language('ms');
  assert.equal(button.textContent, 'Imej 1');
  assert.equal(button.getAttribute('aria-label'), 'Gantikan 一品厨门头.jpg');
  assert.equal(f.document.querySelector('[contenteditable]').textContent, '@图片1 保留门头');
  assert.equal(f.document.querySelector('strong').textContent, '一品厨门店');
  f.language('zh-CN');
  assert.equal(button.textContent, '图片1');
  assert.equal(button.getAttribute('aria-label'), '替换 一品厨门头.jpg');
  assert.equal(f.document.querySelector('p').textContent, '无限积分 · 6 张');
});
