import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderMarkdown, markdownText } from '../design/markdown.js';

test('AI responses render headings, lists, emphasis, quotes, tables and code', () => {
  const html = renderMarkdown('# 门店方案\n\n**到店理由**\n\n1. 拍门头\n2. 拍菜品\n\n> 保留真实环境\n\n| 镜头 | 时长 |\n| --- | --- |\n| 门头 | 3秒 |\n\n```js\nconst scene = "门店";\n```');
  for (const fragment of ['<h1>门店方案</h1>', '<strong>到店理由</strong>', '<ol>', '<blockquote>', '<div class="markdown-table"><table>', '<th>镜头</th>', '<pre><code class="language-js">']) assert.ok(html.includes(fragment), fragment);
  assert.match(renderMarkdown('第一句\n第二句'), /第一句<br>第二句/);
  assert.match(markdownText('普通文案'), /^<div class="markdown-body"><p>普通文案<\/p>/);
});

test('model output cannot inject HTML, executable links or remote image requests', () => {
  const payload = '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[点击](javascript:alert%281%29) [绕过](java&#x73;cript:alert%281%29) ![图片](https://tracker.example/pixel)';
  const html = renderMarkdown(payload);
  assert.doesNotMatch(html, /<script|<img|href="(?:javascript|data|vbscript):/i);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.doesNotMatch(html, /tracker\.example/);
  assert.doesNotMatch(renderMarkdown('[文件](file:///C:/secret) [数据](data:text/html,x)'), /href=/);
  const safe = renderMarkdown('[参考](https://example.com/?a=1&b=2 "描述")');
  assert.match(safe, /href="https:\/\/example\.com\/\?a=1&amp;b=2"/);
  assert.match(safe, /rel="noopener noreferrer"/);
});

test('angle-bracket scene notes and incomplete streamed markdown preserve text', () => {
  assert.ok(renderMarkdown('<推门风铃微响>\n\n**还在生成').includes('&lt;推门风铃微响&gt;'));
  assert.match(renderMarkdown('```html\n<img src=x onerror=x>'), /&lt;img src=x onerror=x&gt;/);
  assert.equal(renderMarkdown(''), '');
});

test('all long AI text viewers share the renderer and static assets are mapped', async () => {
  for (const name of ['agent-chat', 'video-creator', 'restaurant', 'business-flow', 'digital-human']) {
    const source = await readFile(new URL(`../design/${name}.js`, import.meta.url), 'utf8');
    assert.match(source, /import \{ markdownText \} from '\.\/markdown\.js'/);
    assert.ok(source.includes('markdownText('), name);
  }
  const index = await readFile(new URL('../design/index.html', import.meta.url), 'utf8');
  const preview = await readFile(new URL('../preview.mjs', import.meta.url), 'utf8');
  assert.ok(index.includes('"marked":"/vendor/marked.js"'));
  assert.ok(index.includes('/markdown.css'));
  for (const asset of ['/markdown.js', '/markdown.css', '/vendor/marked.js']) assert.ok(preview.includes(asset));
});
