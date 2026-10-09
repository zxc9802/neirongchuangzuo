import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshWorkspaceCredits } from '../design/workspace-credits.js';

const finiteWallet = () => ({ available: 1000, held: 0, total: 1000, unlimited: false,
  pricing: { imagePerUnit: 50, videoPoints: 333, videoSeconds: 30 } });

async function fixture(t, { wallet = finiteWallet(), tasks = [] } = {}) {
  const keys = ['workspaceUser', 'document', 'fetch', 'setInterval', 'clearInterval'];
  const original = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  const nodes = new Map();
  const node = selector => { if (!nodes.has(selector)) nodes.set(selector, {}); return nodes.get(selector); };
  let failing = true, poll;
  globalThis.workspaceUser = { id: crypto.randomUUID() };
  globalThis.document = { body: { dataset: { page: 'video' } }, querySelector: node };
  globalThis.setInterval = callback => { poll = callback; return 1; };
  globalThis.clearInterval = () => {};
  globalThis.fetch = async path => path === '/api/workspace/credits' ? Response.json(wallet) : path.endsWith('/tasks')
    ? failing ? new Response('<html>Service restarting</html>', { status: 502 }) : Response.json({ tasks })
    : Response.json({ enabled: true, prompt: '人物复刻' });
  const module = await import(`../design/video-replica.js?test-${crypto.randomUUID()}`);
  let html;
  const ctx = { esc: value => String(value ?? ''), icon: () => '', refresh() {
    html = module.renderVideoReplica(ctx);
    node('#replica-error').textContent = html.match(/id="replica-error"[^>]*>(.*?)<\/p>/s)[1];
    node('#replica-cost').textContent = html.match(/id="replica-cost"[^>]*>(.*?)<\/p>/s)[1];
  } };
  ctx.refresh(); module.bindVideoReplica(ctx);
  t.after(() => {
    module.disposeVideoReplica();
    for (const key of keys) if (original[key] === undefined) delete globalThis[key]; else globalThis[key] = original[key];
  });
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
  await settle();
  return { node, ctx, recover: () => { failing = false; }, fail: () => { failing = true; },
    poll: async () => { poll(); await settle(); }, message: () => node('#replica-error').textContent,
    html: () => html, cost: () => node('#replica-cost').textContent,
    select: id => node('#replica-history').onclick({ target: { closest: () => ({ dataset: { replicaTask: id } }) } }),
    wallet: async value => { wallet = value; await refreshWorkspaceCredits(); } };
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

test('server unlimited credits replace freeze and refund copy before and after uploading', async t => {
  const task = { id: 'draft-task', status: 'draft', createdAt: Date.now(), duration: 10, estimatedPoints: 112, video: {}, photo: {} };
  const page = await fixture(t, { tasks: [task] });
  await page.wallet({ ...finiteWallet(), available: 0, total: 0, unlimited: true });
  assert.equal(page.cost(), '无限积分');
  assert.match(page.html(), /上传素材，确认时长/);
  assert.doesNotMatch(page.cost(), /预计冻结|失败退回|积分不足/);
  page.recover(); await page.poll(); page.select(task.id);
  assert.equal(page.cost(), '无限积分 · 10 秒');
  assert.match(page.html(), /开始人物复刻/);
  assert.doesNotMatch(page.cost(), /预计冻结|失败退回|结算/);
});

test('finite credits retain the normal freeze quote and refund message regardless of account name', async t => {
  const task = { id: 'draft-task', status: 'draft', createdAt: Date.now(), duration: 10, estimatedPoints: 112 };
  const page = await fixture(t, { tasks: [task] });
  globalThis.workspaceUser.account = 'zxc9911';
  globalThis.workspaceUser.unlimited = true;
  await page.wallet(finiteWallet());
  assert.equal(page.cost(), '上传后确认时长和积分；失败退回预留积分。');
  assert.match(page.html(), /上传素材，查看费用/);
  page.recover(); await page.poll(); page.select(task.id);
  assert.equal(page.cost(), '预计冻结 112 积分 · 10 秒 · 成功后按成片时长结算，不超过预估');
  assert.doesNotMatch(page.cost(), /无限积分/);
});

test('an exempt task with zero estimated points does not fall back to paid-task copy', async t => {
  const task = { id: 'free-task', status: 'running', createdAt: Date.now(), duration: 10, estimatedPoints: 0,
    billing: { exempt: true, reservedPoints: 0, chargedPoints: 0 } };
  const page = await fixture(t, { tasks: [task] });
  await page.wallet(finiteWallet());
  page.recover(); await page.poll();
  assert.equal(page.cost(), '10 秒');
  assert.doesNotMatch(page.html(), /预计冻结|失败退回预留积分|已冻结|已使用|查看费用/);
  assert.match(page.html(), /id="replica-submit"[^>]*disabled[^>]*>正在替换人物/);
});
