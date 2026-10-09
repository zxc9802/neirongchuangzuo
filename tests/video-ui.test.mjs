import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshWorkspaceCredits } from '../design/workspace-credits.js';

const finiteWallet = () => ({ available: 1000, held: 0, total: 1000, unlimited: false,
  pricing: { imagePerUnit: 50, videoPoints: 333, videoSeconds: 30 } });

async function fixture(t, { wallet = finiteWallet(), tasks = [], taskFetch, apiFetch } = {}) {
  const keys = ['workspaceUser', 'document', 'fetch', 'setInterval', 'clearInterval'];
  const original = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  const nodes = new Map();
  const node = selector => { if (!nodes.has(selector)) nodes.set(selector, {}); return nodes.get(selector); };
  let failing = true, poll;
  globalThis.workspaceUser = { id: crypto.randomUUID() };
  globalThis.document = { body: { dataset: { page: 'video' } }, querySelector: node };
  globalThis.setInterval = callback => { poll = callback; return 1; };
  globalThis.clearInterval = () => {};
  globalThis.fetch = async (path, options) => {
    if (apiFetch) { const response = await apiFetch(path, options); if (response) return response; }
    return path === '/api/workspace/credits' ? Response.json(wallet) : path.endsWith('/tasks')
      ? failing ? new Response('<html>Service restarting</html>', { status: 502 }) : taskFetch ? taskFetch(options) : Response.json({ tasks })
      : Response.json({ enabled: true, prompt: '人物复刻' });
  };
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
    html: () => html, cost: () => node('#replica-cost').textContent, settle,
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

function speechDraft() {
  return { id: 'editable-task', status: 'draft', createdAt: Date.now(), video: {}, photo: {}, voice: {},
    speech: { start: 0, end: 2, segments: [{ start: 0, end: 1, text: '薄饼' }, { start: 1.3, end: 2, text: '真的超好吃' }] } };
}

test('draft corrections survive refresh and are saved with original timings before one generation starts', async t => {
  let task = speechDraft();
  const calls = [];
  const page = await fixture(t, { tasks: [task], apiFetch: (path, options) => {
    if (options?.method !== 'POST') return;
    calls.push({ path, body: JSON.parse(options.body) });
    if (path.endsWith('/speech')) task = { ...task, speech: { ...task.speech, segments: task.speech.segments.map((segment, i) => ({ ...segment, text: JSON.parse(options.body).segments[i].text })) } };
    if (path.endsWith('/start')) task = { ...task, status: 'running' };
    return Response.json({ task });
  } });
  page.recover(); await page.poll(); page.select(task.id);
  assert.match(page.html(), /textarea[^>]*aria-label="第 1 段台词"/);
  assert.match(page.html(), /Max模型/);
  assert.doesNotMatch(page.html(), /SEEDANCE/);
  page.node('#replica-speech').oninput({ target: { dataset: { replicaSegment: '0' }, value: '博主' } });
  await page.poll(); page.ctx.refresh();
  assert.match(page.html(), />博主<\/textarea>/);
  page.node('#replica-submit').onclick(); page.node('#replica-submit').onclick(); await page.settle();
  assert.deepEqual(calls.map(call => call.path), ['/api/video-replica/tasks', '/api/video-replica/tasks/editable-task/speech', '/api/video-replica/tasks/editable-task/start']);
  assert.deepEqual(calls[1].body, { segments: [{ text: '博主' }, { text: '真的超好吃' }] });
  assert.deepEqual(task.speech.segments.map(segment => [segment.start, segment.end]), [[0, 1], [1.3, 2]]);
  assert.equal(calls[2].body.speechConfirmed, true);
  assert.doesNotMatch(page.html(), /textarea[^>]*data-replica-segment/);
});

test('blank corrected segments do not save or start a task', async t => {
  const task = speechDraft(), calls = [];
  const page = await fixture(t, { tasks: [task], apiFetch: (path, options) => { if (options?.method) calls.push(path); } });
  page.recover(); await page.poll(); page.select(task.id);
  page.node('#replica-speech').oninput({ target: { dataset: { replicaSegment: '1' }, value: '  ' } });
  page.node('#replica-submit').onclick(); await page.settle();
  assert.equal(page.message(), '每段台词不能为空。');
  assert.deepEqual(calls, []);
});

test('failed correction save preserves edits and never submits generation', async t => {
  const task = speechDraft(), calls = [];
  const page = await fixture(t, { tasks: [task], apiFetch: (path, options) => {
    if (options?.method !== 'POST') return;
    calls.push(path);
    return path.endsWith('/speech') ? Response.json({ error: '台词保存失败，请重试。' }, { status: 503 }) : Response.json({ task });
  } });
  page.recover(); await page.poll(); page.select(task.id);
  page.node('#replica-speech').oninput({ target: { dataset: { replicaSegment: '0' }, value: '博主' } });
  page.node('#replica-submit').onclick(); await page.settle();
  assert.equal(page.message(), '台词保存失败，请重试。');
  assert.match(page.html(), />博主<\/textarea>/);
  assert.deepEqual(calls, ['/api/video-replica/tasks', '/api/video-replica/tasks/editable-task/speech']);
});

test('completed and failed tasks cannot submit or edit speech', async t => {
  for (const status of ['running', 'completed', 'failed']) {
    const task = { ...speechDraft(), status }, calls = [];
    const page = await fixture(t, { tasks: [task], apiFetch: (path, options) => { if (options?.method) calls.push(path); } });
    page.recover(); await page.poll(); page.select(task.id);
    assert.doesNotMatch(page.html(), /textarea[^>]*data-replica-segment/);
    page.node('#replica-submit').onclick(); await page.settle();
    assert.deepEqual(calls, []);
  }
});

test('eligible failed output rechecks the same task once without generating again', async t => {
  const task = { ...speechDraft(), status: 'failed', canRecheck: true, code: 'VIDEO_SPEECH_INVALID',
    error: '成片台词与原视频不一致，未交付成片；请核对素材后重新生成。' }, calls = [];
  const page = await fixture(t, { tasks: [task], apiFetch: (path, options) => {
    if (options?.method !== 'POST') return;
    calls.push({ path, body: JSON.parse(options.body) });
    return Response.json({ task: path.endsWith('/speech') ? task : { ...task, status: 'verifying', canRecheck: false } });
  } });
  page.recover(); await page.poll(); page.select(task.id);
  assert.match(page.html(), /id="replica-recheck"[^>]*>重新检查成片/);
  assert.match(page.html(), /成片未通过语音检查，请核对台词后重新检查。/);
  assert.doesNotMatch(page.html(), /请核对素材后重新生成/);
  assert.match(page.html(), /textarea[^>]*aria-label="第 1 段台词"/);
  page.node('#replica-speech').oninput({ target: { dataset: { replicaSegment: '0' }, value: '博主' } });
  page.node('#replica-recheck').onclick(); page.node('#replica-recheck').onclick(); await page.settle();
  assert.deepEqual(calls, [{ path: '/api/video-replica/tasks/editable-task/speech', body: { segments: [{ text: '博主' }, { text: '真的超好吃' }] } }, { path: '/api/video-replica/tasks/editable-task/recheck', body: {} }]);
  assert.doesNotMatch(page.html(), /id="replica-recheck"/);
});

test('blank corrected segments block rechecking an existing output', async t => {
  const task = { ...speechDraft(), status: 'failed', canRecheck: true }, calls = [];
  const page = await fixture(t, { tasks: [task], apiFetch: (path, options) => { if (options?.method) calls.push(path); } });
  page.recover(); await page.poll(); page.select(task.id);
  page.node('#replica-speech').oninput({ target: { dataset: { replicaSegment: '0' }, value: '' } });
  page.node('#replica-recheck').onclick(); await page.settle();
  assert.equal(page.message(), '每段台词不能为空。');
  assert.deepEqual(calls, []);
});

test('tasks without recoverable output do not request recheck', async t => {
  const task = { ...speechDraft(), status: 'failed', canRecheck: false }, calls = [];
  const page = await fixture(t, { tasks: [task], apiFetch: (path, options) => { if (options?.method) calls.push(path); } });
  page.recover(); await page.poll(); page.select(task.id);
  assert.doesNotMatch(page.html(), /id="replica-recheck"/);
  page.node('#replica-recheck').onclick(); await page.settle();
  assert.deepEqual(calls, []);
});

test('downloading output shows received size and progress with or without content length', async t => {
  const task = { id: 'download-task', status: 'downloading', createdAt: Date.now(), downloadProgress: { receivedBytes: 1024 * 1024, totalBytes: 4 * 1024 * 1024 } };
  const page = await fixture(t, { tasks: [task] });
  page.recover(); await page.poll();
  assert.match(page.html(), /保存成片：1.0 MB \/ 4.0 MB/);
  assert.match(page.html(), /progress aria-label="成片保存进度" max="4194304" value="1048576"/);
  task.downloadProgress.totalBytes = null;
  await page.poll();
  assert.match(page.html(), /保存成片：1.0 MB/);
  assert.doesNotMatch(page.html(), /progress aria-label="成片保存进度"/);
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

test('pending tasks show elapsed time, last model reply and a task ID instead of a fixed wait estimate', async t => {
  const now = Date.now();
  const task = { id: 'waiting-task', status: 'running', createdAt: now - 700_000, startedAt: now - 650_000, lastCheckedAt: now - 30_000 };
  const page = await fixture(t, { tasks: [task] });
  page.recover(); await page.poll();
  assert.match(page.html(), /已等待 10 分/);
  assert.match(page.html(), /最近收到模型回复/);
  assert.match(page.html(), /waiting-task/);
  assert.match(page.html(), /等待时间较长/);
  assert.doesNotMatch(page.html(), /通常需要几分钟/);
  const before = page.html();
  task.lastCheckedAt = Date.now();
  await page.poll();
  assert.match(page.node('#replica-progress').innerHTML, /最近收到模型回复：0 秒前/);
  assert.equal(page.html(), before, 'a new poll timestamp does not rebuild the video player');
});

for (const stalledPart of ['headers', 'body']) test(`a stalled ${stalledPart} request times out and later polls recover without submitting`, async t => {
  let controller;
  t.mock.method(AbortSignal, 'timeout', ms => { assert.equal(ms, 15_000); controller = new AbortController(); return controller.signal; });
  let stall = true, calls = 0;
  const task = { id: 'existing-task', status: 'running', createdAt: Date.now() };
  const page = await fixture(t, { taskFetch: options => {
    calls++; assert.equal(options.method, undefined);
    if (!stall) return Response.json({ tasks: [task] });
    const pending = new Promise((resolve, reject) => options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    return stalledPart === 'headers' ? pending : { ok: true, json: () => pending };
  } });
  page.recover(); await page.poll();
  assert.ok(controller, 'status requests need a bounded timeout');
  controller.abort(new DOMException('Timed out', 'TimeoutError'));
  await page.poll();
  assert.match(page.message(), /查询任务超时/);
  stall = false; await page.poll();
  assert.equal(page.message(), '');
  assert.equal(calls, 2);
  assert.match(page.html(), /正在替换人物/);
});
