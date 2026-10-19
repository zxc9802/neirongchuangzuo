import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_VIDEO_SETTINGS } from '../design/video-catalog.js';

async function fixture(t, api) {
  const names = ['document', 'workspaceUser', 'fetch', 'setInterval', 'clearInterval', 'EventSource'];
  const old = Object.fromEntries(names.map(k => [k, globalThis[k]])), nodes = new Map();
  const node = k => { if (!nodes.has(k)) nodes.set(k, { addEventListener(type, callback) { this[type] = callback; } }); return nodes.get(k); };
  let poll, html;
  globalThis.workspaceUser = { id: crypto.randomUUID() };
  globalThis.document = { body: { dataset: { page: 'video' } }, querySelector: node };
  globalThis.EventSource = undefined;
  globalThis.setInterval = cb => { poll = cb; return 1; }; globalThis.clearInterval = () => {};
  globalThis.fetch = async (path, options) => path === '/api/workspace/credits' ? Response.json({ unlimited: true }) : api(path, options);
  const module = await import('../design/video-creator.js?test=' + crypto.randomUUID());
  const ctx = { esc: x => String(x ?? ''), icon: () => '', mode: 'video', button: (action, text, _class, attrs = '') => `<button data-action="${action}" ${attrs}>${text}</button>`,
    configs: { video: { prompt: '', files: [] } }, assets: [], toast() {}, refresh() { html = module.renderVideoCreator(ctx); } };
  ctx.refresh(); module.bindVideoCreator(ctx);
  t.after(() => { module.disposeVideoCreator(); for (const key of names) { if (old[key] === undefined) delete globalThis[key]; else globalThis[key] = old[key]; } });
  await delay(15);
  return { node, ctx, html: () => html, action: (name, data = {}, actionContext = ctx) => module.handleVideoCreatorAction(name, { dataset: data }, actionContext), async poll() { await poll(); await delay(5); } };
}

test('lost director response retries identical operation and original expected revision after polling receives completed script', async t => {
  let conversation, calls = [], first = true;
  const f = await fixture(t, async (path, options) => {
    const body = options?.body ? JSON.parse(options.body) : null;
    if (path.endsWith('/config')) return Response.json({ directorEnabled: true, generationEnabled: true });
    if (path.endsWith('/quote')) return Response.json({ points: 1000, unlimited: true, affordable: true });
    if (path.endsWith('/tasks')) return Response.json({ tasks: [] });
    if (path.endsWith('/conversations') && body) { conversation = { id: body.requestId, version: 1, skill: body.skill, settings: body.settings, operations: [], tasks: [], assets: [] }; return Response.json({ conversation }); }
    if (path.endsWith('/conversations')) return Response.json({ conversations: [] });
    if (options?.method === 'PUT') { conversation.assets.push({ id: crypto.randomUUID(), type: 'image', name: '实拍', url: '/photo' }); return Response.json({ conversation }); }
    if (path.endsWith('/script')) {
      calls.push(body);
      if (first) { first = false; conversation.version++; conversation.operations.push({ id: body.requestId, status: 'completed', message: body.message, skill: conversation.skill, settings: body.settings,
        result: { kind: 'script', script: { title: '脚本', shots: [], videoPrompt: '真实素材' }, warnings: [] } }); throw new Error('Connection lost after acceptance'); }
      return Response.json({ operation: conversation.operations[0] });
    }
    return Response.json({ conversation });
  });
  f.node('#vc-images').onchange({ target: { files: [new File(['test'], '实拍.jpg', { type: 'image/jpeg' })] } }); await delay(20);
  f.node('#vc-message').input({ target: { value: '介绍门店' } }); f.action('vc-send'); await delay(20);
  assert.match(f.html(), /Connection lost/); await f.poll();
  f.action('vc-send'); await delay(20);
  assert.equal(calls.length, 2); assert.deepEqual(calls[1], calls[0]); assert.equal(calls[1].expectedScriptId, null);
  f.action('vc-apply', { id: calls[0].requestId });
  assert.match(f.html(), /视频提示词/); assert.match(f.html(), /真实素材/); assert.match(f.html(), /Max模型/);
  assert.equal(f.action('vc-send', {}, { ...f.ctx, mode: 'replica' }), false);
});
