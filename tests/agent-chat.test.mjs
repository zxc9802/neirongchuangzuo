import assert from 'node:assert/strict';
import { test } from 'node:test';

const STORAGE_KEY = 'store-ai-agent-conversations-v1';
let revision = 0;
const flush = async () => { for (let index = 0; index < 4; index++) await new Promise(resolve => setImmediate(resolve)); };
const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

async function harness(t, sessions = []) {
  const values = new Map();
  if (sessions.length) values.set(STORAGE_KEY, JSON.stringify({ version: 1, sessions, activeId: sessions[0].id }));
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', listeners: {}, addEventListener(name, callback) { this.listeners[name] = callback; }, setAttribute() {}, focus() {}, close() {} });
    return nodes.get(id);
  };
  const body = { dataset: { page: 'agent' } };
  const pending = [];
  const requests = [];
  const queries = [];
  const mocks = {
    FileReader: class {
      readAsDataURL(blob) {
        blob.arrayBuffer().then(buffer => {
          if (this.aborted) return;
          this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`;
          this.onload?.();
        }).catch(() => this.onerror?.());
      }
      abort() { this.aborted = true; }
    },
    window: { innerWidth: 1200, location: { href: 'http://localhost/#agent', origin: 'http://localhost' } },
    document: { body, getElementById: node },
    localStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) },
    fetch: (url, options) => {
      if (url === '/api/ai/status') return Promise.resolve({ ok: true, json: async () => ({ chat: { configured: true, model: 'test-luna' } }) });
      if (url !== '/api/ai/chat' && !url.startsWith('/api/ai/chat/')) throw new Error(`Unexpected request: ${url}`);
      if (options.body) requests.push(JSON.parse(options.body)); else queries.push(url);
      return new Promise((resolve, reject) => {
        const request = { resolve, reject };
        pending.push(request);
        options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    },
  };
  const descriptors = Object.fromEntries(Object.keys(mocks).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(mocks)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => {
    for (const request of pending) request.reject(new Error('Test cleanup'));
    for (const key of Object.keys(mocks)) {
      if (descriptors[key]) Object.defineProperty(globalThis, key, descriptors[key]);
      else delete globalThis[key];
    }
  });
  const chat = await import(`../design/agent-chat.js?test=${revision++}`);
  const read = () => JSON.parse(values.get(STORAGE_KEY) || 'null');
  let html = '';
  let renders = 0;
  const toasts = [];
  const transfers = [];
  const ctx = {
    mode: 'agent', assets: [], configs: { image: {} }, modules: { image: { title: 'AI 图片', max: 10000, type: 'image', limit: 4 } },
    button: (action, content, classes = '', attrs = '') => `<button data-action="${action}" class="${classes}" ${attrs}>${content}</button>`,
    icon: () => '<svg></svg>', esc, toast: message => toasts.push(message), beginCreation: mode => transfers.push(mode),
    picker() {}, openModal() {},
    refresh() {
      renders++;
      html = chat.renderAgentChat(ctx);
      const current = read();
      node('agent-chat-input').value = current?.sessions.find(session => session.id === current.activeId)?.draft.text || '';
      chat.bindAgentChat(ctx);
    },
  };
  const action = (name, dataset = {}) => chat.handleAgentChatAction(name, { dataset }, ctx);
  const type = text => { node('agent-chat-input').value = text; node('agent-chat-input').listeners.input(); };
  const submit = () => node('agent-chat-form').listeners.submit({ preventDefault() {} });
  const respond = async (index, data, ok = true, status = ok ? 200 : 502) => { pending[index].resolve({ ok, status, json: async () => data }); await flush(); };
  ctx.refresh();
  await flush();
  return { chat, ctx, read, action, type, submit, respond, requests, queries, node, body, toasts, transfers, html: () => html, renders: () => renders };
}

test('Agent sends multi-turn roles once, escapes the reply, and transfers the selected answer', async t => {
  const h = await harness(t);
  h.type('帮我介绍来样加工业务');
  h.submit();
  h.submit();
  await flush();
  assert.equal(h.requests.length, 1);
  assert.match(h.requests[0].requestId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(h.requests[0].messages, [{ role: 'user', content: '帮我介绍来样加工业务' }]);
  assert.match(h.html(), /正在整理/);
  assert.equal(h.node('agent-send').disabled, true);
  assert.equal(h.node('agent-chat-input').value, '');
  await h.respond(0, { text: '先确认材质 <img src=x onerror=alert(1)>', model: 'test-luna' });
  assert.match(h.html(), /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(h.html(), /<img src=x/);
  assert.match(h.html(), /宣传助手 · Plus模型/);
  assert.doesNotMatch(h.html(), /test-luna/);
  assert.equal(h.read().sessions[0].messages.at(-1).model, 'test-luna');
  h.type('材料是棉布');
  h.submit();
  await flush();
  assert.deepEqual(h.requests[1].messages.map(message => message.role), ['user', 'assistant', 'user']);
  await h.respond(1, { text: '提供棉布来样加工，请发送规格以确认起订量。', model: 'test-luna' });
  const answer = h.read().sessions[0].messages.at(-1);
  h.action('agent-transfer-answer', { mode: 'image', id: answer.id });
  assert.equal(h.ctx.configs.image.prompt, answer.text);
  assert.deepEqual(h.transfers, ['image']);
});

test('a late answer remains in its original session and preserves another session draft', async t => {
  const h = await harness(t);
  h.type('餐厅活动');
  h.submit();
  await flush();
  const original = h.read().activeId;
  h.action('agent-new');
  const active = h.read().activeId;
  assert.notEqual(original, active);
  h.type('未发送的工厂需求');
  await h.respond(0, { text: '请提供活动价格。', model: 'test-luna' });
  assert.equal(h.read().activeId, active);
  assert.equal(h.read().sessions.find(session => session.id === original).messages.at(-1).text, '请提供活动价格。');
  assert.equal(h.read().sessions.find(session => session.id === active).draft.text, '未发送的工厂需求');
  assert.doesNotMatch(h.html(), /请提供活动价格/);
  assert.equal(h.node('agent-chat-input').value, '未发送的工厂需求');
});

test('a failed request queries its original answer without a second paid POST or losing the next draft', async t => {
  const h = await harness(t);
  h.type('宣传门店');
  h.submit();
  await flush();
  h.type('这是下一轮草稿');
  await h.respond(0, { error: '服务暂时繁忙', code: 'upstream_unavailable' }, false);
  assert.match(h.html(), /服务暂时繁忙/);
  const user = h.read().sessions[0].messages[0];
  assert.equal(user.status, 'error');
  h.action('agent-retry', { id: user.id });
  await flush();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.queries, [`/api/ai/chat/${user.requestId}`]);
  assert.equal(h.read().sessions[0].messages.length, 1);
  await h.respond(1, { text: '先说说你的门店特色。' });
  assert.equal(h.read().sessions[0].messages.length, 2);
  assert.equal(h.read().sessions[0].draft.text, '这是下一轮草稿');
});

test('old attachment names cannot be represented as sent images; text-only retry requires a user action', async t => {
  const h = await harness(t, [{ id: 'old', title: '旧需求', updatedAt: new Date().toISOString(), messages: [{ id: 'old-message', text: '参考这张图片', attachments: ['车间.png'] }], draft: { text: '', attachments: [] } }]);
  h.type('继续整理');
  h.submit();
  await flush();
  assert.equal(h.requests.length, 0);
  assert.match(h.html(), /参考图片已不在当前页面/);
  const last = h.read().sessions[0].messages.at(-1);
  h.action('agent-retry-text', { id: last.id });
  await flush();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.requests[0].messages, [{ role: 'user', content: '参考这张图片' }, { role: 'user', content: '继续整理' }]);
  await h.respond(0, { text: '目前只能依据你的文字整理。' });
  assert.match(h.html(), /本轮仅发送文字/);
});

test('closing a pending session aborts its response without resurrecting deleted history', async t => {
  const h = await harness(t);
  h.type('等待处理');
  h.submit();
  await flush();
  const removed = h.read().activeId;
  h.action('agent-delete-confirm', { id: removed });
  await flush();
  assert.equal(h.read().sessions.some(session => session.id === removed), false);
  assert.equal(h.read().sessions[0].messages.length, 0);
});

test('selected image bytes accompany the user turn and remain in multi-turn context', async t => {
  const h = await harness(t);
  h.ctx.assets.push({ id: 'photo', name: '门店.png', type: 'image', url: 'blob:photo', file: new Blob(['sample-image'], { type: 'image/png' }) });
  h.ctx.picker = (_type, _multiple, options) => options.onConfirm(['photo']);
  h.type('请看这张门店照片');
  h.action('agent-attach');
  h.submit();
  await flush();
  assert.equal(h.requests[0].messages[0].images[0].name, '门店.png');
  assert.equal(h.requests[0].messages[0].images[0].dataUrl, `data:image/png;base64,${Buffer.from('sample-image').toString('base64')}`);
  await h.respond(0, { text: '可以介绍店面风格。' });
  h.type('给出一份配文');
  h.submit();
  await flush();
  assert.equal(h.requests[1].messages[0].images.length, 1);
  assert.equal(h.requests[1].messages[1].images, undefined);
  assert.equal(h.requests[1].messages[2].images, undefined);
  await h.respond(1, { text: '门店配文。' });
});

test('unsupported images are rejected locally before any AI request', async t => {
  const h = await harness(t);
  h.ctx.assets.push({ id: 'photo', name: '动画.gif', type: 'image', url: 'blob:photo', file: new Blob(['GIF89a'], { type: 'image/gif' }) });
  h.ctx.picker = (_type, _multiple, options) => options.onConfirm(['photo']);
  h.type('参考这张图');
  h.action('agent-attach');
  h.submit();
  await flush();
  assert.equal(h.requests.length, 0);
  assert.match(h.html(), /需使用 PNG、JPEG 或 WebP/);
  assert.equal(h.read().sessions[0].messages[0].errorCode, 'image_type');
});

test('four individually valid images over 24 MB are rejected before an AI request', async t => {
  const h = await harness(t);
  const ids = ['one', 'two', 'three', 'four'];
  for (const id of ids) h.ctx.assets.push({ id, name: `${id}.png`, type: 'image', url: `blob:${id}`, file: new Blob([new Uint8Array(7 * 1024 * 1024)], { type: 'image/png' }) });
  h.ctx.picker = (_type, _multiple, options) => options.onConfirm(ids);
  h.type('请分析这几张图片');
  h.action('agent-attach');
  h.submit();
  // Blob reads yield beyond a single task when the payload is large.
  for (let index = 0; index < 100 && h.read().sessions[0].messages[0].status === 'pending'; index++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.requests.length, 0);
  assert.equal(h.read().sessions[0].messages[0].errorCode, 'image_total_too_large');
  assert.match(h.html(), /图片合计超过 24 MB/);
});

test('stopping a response only claims that receiving has stopped', async t => {
  const h = await harness(t);
  h.type('整理产品特点');
  h.submit();
  await flush();
  h.action('agent-stop');
  await flush();
  assert.equal(h.read().sessions[0].messages[0].status, 'error');
  assert.match(h.html(), /已停止接收回答；可查询原回答，不会重复提交/);
  assert.equal(h.requests.length, 1);
});

test('a frontend timeout explains that upstream processing may continue and never retries automatically', async t => {
  const h = await harness(t);
  const originalTimeout = globalThis.setTimeout;
  let expire;
  globalThis.setTimeout = (callback, duration, ...args) => {
    if (duration === 180000) { expire = callback; return -1; }
    return originalTimeout(callback, duration, ...args);
  };
  t.after(() => { globalThis.setTimeout = originalTimeout; });
  h.type('整理门店介绍');
  h.submit();
  await flush();
  assert.equal(typeof expire, 'function');
  expire();
  await flush();
  assert.match(h.html(), /上游服务可能仍在处理/);
  assert.match(h.html(), /避免连续重试/);
  assert.equal(h.requests.length, 1);
});

test('background completion does not re-render a different application module', async t => {
  const h = await harness(t);
  h.type('产品宣传');
  h.submit();
  await flush();
  h.body.dataset.page = 'image';
  const count = h.renders();
  await h.respond(0, { text: '回答已完成。' });
  assert.equal(h.renders(), count);
  assert.equal(h.read().sessions[0].messages.at(-1).text, '回答已完成。');
});

test('interrupted history is recoverable and long contexts retain the latest user message', async t => {
  const h = await harness(t, [{ id: 'interrupted', title: '未完成', updatedAt: new Date().toISOString(), messages: [{ id: 'pending', text: '请整理', attachments: [], role: 'user', status: 'pending' }], draft: { text: '', attachments: [] } }]);
  assert.match(h.html(), /上次回答因页面关闭而中断/);
  const messages = Array.from({ length: 31 }, (_, index) => ({ id: String(index), role: index % 2 ? 'assistant' : 'user', text: String(index) + 'x'.repeat(2200), attachments: [] }));
  const recent = h.chat.agentContextMessages(messages);
  assert.ok(recent.length <= 20);
  assert.ok(recent.reduce((size, message) => size + message.text.length, 0) <= 32000);
  assert.equal(recent[0].role, 'user');
  assert.equal(recent.at(-1).id, '30');
});

test('reloaded submitted history queries the same UUID and can repeat a pending query without paid calls', async t => {
  const requestId = crypto.randomUUID();
  const h = await harness(t, [{ id: 'reloaded', title: '旧任务', updatedAt: new Date().toISOString(), messages: [{ id: 'pending', requestId, submitted: true, text: '工厂介绍', attachments: [], role: 'user', status: 'pending' }], draft: { text: '', attachments: [] } }]);
  h.action('agent-retry', { id: 'pending' });
  await flush();
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.queries, [`/api/ai/chat/${requestId}`]);
  await h.respond(0, { requestId, status: 'running' }, true, 202);
  assert.match(h.html(), /原回答还在处理中/);
  h.action('agent-retry', { id: 'pending' });
  await flush();
  await h.respond(1, { text: '已完成的原回答' });
  assert.equal(h.requests.length, 0);
  assert.equal(h.queries.length, 2);
  assert.equal(h.read().sessions[0].messages.at(-1).text, '已完成的原回答');
});

test('stopped reception retains its submission ID and queries rather than resubmitting', async t => {
  const h = await harness(t);
  h.type('工厂宣传'); h.submit(); await flush();
  const originalId = h.requests[0].requestId;
  h.action('agent-stop'); await flush();
  const user = h.read().sessions[0].messages[0];
  assert.equal(user.requestId, originalId);
  assert.equal(user.submitted, true);
  h.action('agent-retry', { id: user.id }); await flush();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.queries, [`/api/ai/chat/${originalId}`]);
  await h.respond(1, { text: '原任务完成' });
});
