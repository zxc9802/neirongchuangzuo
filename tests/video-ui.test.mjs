import test from 'node:test';
import assert from 'node:assert/strict';

async function fixture(t) {
  const keys = ['workspaceUser', 'document', 'fetch', 'setInterval', 'clearInterval'];
  const original = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  const nodes = new Map();
  const node = selector => { if (!nodes.has(selector)) nodes.set(selector, {}); return nodes.get(selector); };
  let failing = true, poll;
  globalThis.workspaceUser = { id: crypto.randomUUID() };
  globalThis.document = { body: { dataset: { page: 'video' } }, querySelector: node };
  globalThis.setInterval = callback => { poll = callback; return 1; };
  globalThis.clearInterval = () => {};
  globalThis.fetch = async path => path.endsWith('/tasks')
    ? failing ? new Response('<html>Service restarting</html>', { status: 502 }) : Response.json({ tasks: [] })
    : Response.json({ enabled: true, prompt: '人物复刻' });
  const module = await import(`../design/video-replica.js?test-${crypto.randomUUID()}`);
  const ctx = { esc: value => String(value ?? ''), icon: () => '', refresh() {
    const html = module.renderVideoReplica(ctx);
    node('#replica-error').textContent = html.match(/id="replica-error"[^>]*>(.*?)<\/p>/s)[1];
  } };
  ctx.refresh(); module.bindVideoReplica(ctx);
  t.after(() => {
    module.disposeVideoReplica();
    for (const key of keys) if (original[key] === undefined) delete globalThis[key]; else globalThis[key] = original[key];
  });
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
  await settle();
  return { node, ctx, recover: () => { failing = false; }, fail: () => { failing = true; },
    poll: async () => { poll(); await settle(); }, message: () => node('#replica-error').textContent };
}

test('automatic successful polling clears restart errors on first load and after a loaded page', async t => {
  const page = await fixture(t);
  assert.match(page.message(), /视频服务暂时不可用/);
  page.recover(); await page.poll();
  assert.equal(page.message(), '');
  page.fail(); await page.poll();
  assert.match(page.message(), /视频服务暂时不可用/);
  page.recover(); await page.poll();
  assert.equal(page.message(), '');
  page.ctx.refresh(); assert.equal(page.message(), '');
});

test('successful status polling preserves input validation errors', async t => {
  const page = await fixture(t);
  page.recover(); await page.poll();
  page.node('#replica-submit').onclick();
  assert.match(page.message(), /请先上传一段参考视频和一张人物照片/);
  await page.poll();
  assert.match(page.message(), /请先上传一段参考视频和一张人物照片/);
});
