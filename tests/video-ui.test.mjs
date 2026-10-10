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

test('reopening the page previews the latest completed task without reopening it after New Replica', async t => {
  const task = { id: 'completed-task', status: 'completed', createdAt: Date.now(),
    resultUrl: '/api/video-replica/tasks/completed-task/result' };
  const page = await fixture(t, { tasks: [task] });
  page.recover(); await page.poll();
  assert.match(page.html(), /src="\/api\/video-replica\/tasks\/completed-task\/result"/);
  assert.match(page.html(), /aria-label="人物复刻成片"/);
  page.node('#replica-new').onclick();
  await page.poll();
  assert.doesNotMatch(page.html(), /aria-label="人物复刻成片"/);
  assert.match(page.html(), /成片在这里预览/);
});

test('New Replica stays available during generation and polling preserves the new form', async t => {
  const task = { id: 'running-task', status: 'running', createdAt: Date.now(), video: {}, photo: {} };
  const page = await fixture(t, { tasks: [task] });
  page.recover(); await page.poll();
  const button = page.html().match(/<button[^>]*id="replica-new"[^>]*>/)[0];
  assert.doesNotMatch(button, /disabled/);
  page.node('#replica-new').onclick();
  for (let i = 0; i < 2; i++) {
    await page.poll(); page.ctx.refresh();
    assert.match(page.html(), /成片在这里预览/);
    assert.doesNotMatch(page.html().match(/<input[^>]*id="replica-video"[^>]*>/)[0], /disabled/);
    assert.match(page.html(), /data-replica-task="running-task"/);
  }
  page.select(task.id);
  assert.match(page.html(), /replica-working/);
});

test('minor transcript differences still preview and download with an honest review message', async t => {
  const task = { id: 'minor-task', status: 'completed', createdAt: Date.now(),
    resultUrl: '/api/video-replica/tasks/minor-task/result', audioCheck: { transcriptMatched: false, transcriptDifferences: 2, afterOffsetMs: 16 } };
  const page = await fixture(t, { tasks: [task] });
  page.recover(); await page.poll();
  assert.match(page.html(), /台词有 2 字轻微识别差异/);
  assert.match(page.html(), /开口偏差 16 毫秒/);
  assert.match(page.html(), /请预览核对台词、音色与口型/);
  assert.match(page.html(), /aria-label="人物复刻成片"/);
  assert.match(page.html(), /href="\/api\/video-replica\/tasks\/minor-task\/result\?download=1"/);
  assert.doesNotMatch(page.html(), /台词一致/);
});

test('uncorrected generated audio stays playable without claiming matching words or zero timing error', async t => {
  const task = { id: 'advisory-task', status: 'completed', createdAt: Date.now(),
    resultUrl: '/api/video-replica/tasks/advisory-task/result', audioCheck: { corrected: false,
      transcriptMatched: null, transcriptDifferences: null, afterOffsetMs: null,
      warning: '已保留模型生成的声音，请预览核对台词、音色与开口时间。' } };
  const page = await fixture(t, { tasks: [task] });
  page.recover(); await page.poll();
  assert.match(page.html(), /已保留模型生成的声音/);
  assert.match(page.html(), /aria-label="人物复刻成片"/);
  assert.match(page.html(), /href="\/api\/video-replica\/tasks\/advisory-task\/result\?download=1"/);
  assert.doesNotMatch(page.html(), /台词一致|开口偏差|NaN/);
});

function speechDraft() {
  return { id: 'editable-task', status: 'draft', createdAt: Date.now(), captionsChecked: true, video: {}, photo: {}, voice: {},
    speech: { start: 0, end: 2, segments: [{ start: 0, end: 1, text: '薄饼' }, { start: 1.3, end: 2, text: '真的超好吃' }] } };
}

test('caption drafts start in one click without a transcript confirmation step', async t => {
  let task = { ...speechDraft(), voice: undefined, captions: { cues: [
    { start: .1, end: .6, text: '今天吃生腌' }, { start: .6, end: 1.2, text: '只要9.9元' },
    { start: 1.3, end: 2, text: '真的超好吃' },
  ] } };
  const calls = [];
  const page = await fixture(t, { tasks: [task], apiFetch: (path, options) => {
    if (options?.method !== 'POST') return;
    const body = JSON.parse(options.body); calls.push({ path, body });
    if (path.endsWith('/start')) task = { ...task, status: 'preparing' };
    return Response.json({ task });
  } });
  page.recover(); await page.poll(); page.select(task.id);
  assert.match(page.html(), /id="replica-submit"[^>]*>一键生成/);
  assert.doesNotMatch(page.html(), /replica-speech|textarea|确认台词/);
  page.node('#replica-submit').onclick(); await page.settle();
  assert.deepEqual(calls.map(call => call.path), ['/api/video-replica/tasks', '/api/video-replica/tasks/editable-task/start']);
  assert.equal(calls[1].body.speechConfirmed, undefined);
  assert.match(page.html(), /正在自动分析字幕与人声/);
  assert.doesNotMatch(page.html(), /replica-speech|原视频台词|textarea|今天吃生腌/);
  assert.equal(task.captions.cues[0].text, '今天吃生腌');
});

test('replica has no video model picker and old drafts submit with the flagship model', async t => {
  const fal = 'minimax/h3-max/reference-to-video', seedance = 'doubao-seedance-2-0-260128';
  let task = { ...speechDraft(), model: fal }; const calls = [];
  const page = await fixture(t, { taskFetch: () => Response.json({ tasks: [task] }), apiFetch: (path, options) => {
    if (path.endsWith('/config')) return Response.json({ enabled: true, voiceEnabled: true, model: seedance,
      models: [{ id: seedance, name: '旗舰模型', enabled: true }] });
    if (options?.method !== 'POST') return;
    const body = JSON.parse(options.body); calls.push({ path, body });
    if (path.endsWith('/start')) task = { ...task, model: body.model, status: 'running' };
    return Response.json({ task });
  } });
  page.recover(); await page.poll(); page.select(task.id);
  assert.doesNotMatch(page.html(), /replica-model|复刻模型|minimax\/h3-max/);
  assert.match(page.html(), /AI 视频 · 旗舰模型/);
  page.node('#replica-submit').onclick(); await page.settle();
  assert.equal(calls.find(call => call.path.endsWith('/tasks')).body.model, seedance);
  assert.equal(calls.find(call => call.path.endsWith('/start')).body.model, seedance);
  task = { ...task, model: fal, status: 'completed', modelName: '极速模型', resolution: '768p', resultUrl: '/api/video-replica/tasks/editable-task/result' };
  await page.poll(); page.select(task.id);
  assert.match(page.html(), /极速模型 · .*768p/);
  assert.match(page.html(), /aria-label="人物复刻成片"/);
  page.node('#replica-new').onclick();
  assert.doesNotMatch(page.html(), /replica-model|极速模型|minimax\/h3-max/);
});

test('one click uploads every selected asset then starts once without analysis or confirmation requests', async t => {
  let task; const calls = [];
  const page = await fixture(t, { apiFetch: (path, options) => {
    if (!options?.method) return;
    calls.push({ path, method: options.method, body: options.method === 'POST' ? JSON.parse(options.body) : options.body });
    if (path.endsWith('/tasks')) task = { id: JSON.parse(options.body).requestId, status: 'draft', createdAt: Date.now() };
    for (const kind of ['video', 'photo', 'voice']) if (path.endsWith('/' + kind)) task = { ...task, [kind]: {} };
    if (path.endsWith('/start')) task = { ...task, status: 'preparing' };
    return Response.json({ task });
  } });
  page.recover(); await page.poll();
  const files = ['video', 'photo', 'voice'].map(kind => new File(['data'], kind + '.mp4', { type: 'application/octet-stream' }));
  for (const [i, kind] of ['video', 'photo', 'voice'].entries()) page.node('#replica-' + kind).onchange({ target: { files: [files[i]] } });
  page.node('#replica-submit').onclick(); page.node('#replica-submit').onclick(); await page.settle();
  assert.deepEqual(calls.map(call => call.path), ['/api/video-replica/tasks', ...['video', 'photo', 'voice', 'start'].map(kind => `/api/video-replica/tasks/${task.id}/${kind}`)]);
  assert.deepEqual(calls.slice(1, 4).map(call => call.body), files);
  assert.equal(calls[0].body.voiceEngine, 'seedance');
  assert.equal(calls[4].body.voiceEngine, 'seedance');
  assert.equal(calls[4].body.speechConfirmed, undefined);
  assert.match(page.html(), /id="replica-submit"[^>]*disabled[^>]*>正在自动分析字幕与人声/);
});

test('an uncertain start response retries the same task without reuploading or dispatching twice', async t => {
  let task = { ...speechDraft(), speech: undefined, captionsChecked: undefined }, starts = 0, failResponse = true;
  const calls = [];
  const page = await fixture(t, { tasks: [task], apiFetch: (path, options) => {
    if (options?.method !== 'POST') return;
    calls.push({ path, body: JSON.parse(options.body) });
    if (path.endsWith('/start')) {
      starts++; task = { ...task, status: 'preparing' };
      if (failResponse) { failResponse = false; throw new Error('连接中断'); }
    }
    return Response.json({ task });
  } });
  page.recover(); await page.poll(); page.select(task.id);
  page.node('#replica-submit').onclick(); await page.settle();
  assert.equal(page.message(), '连接中断');
  page.node('#replica-submit').onclick(); await page.settle();
  assert.deepEqual(calls.map(call => call.path), ['/api/video-replica/tasks', '/api/video-replica/tasks/editable-task/start', '/api/video-replica/tasks']);
  assert.equal(starts, 1);
  assert.equal(calls[0].body.requestId, calls[2].body.requestId);
  assert.match(page.html(), /正在自动分析字幕与人声/);
});

test('failed recheck displays the service error without saving speech or submitting generation', async t => {
  const task = { ...speechDraft(), status: 'failed', canRecheck: true }, calls = [];
  const page = await fixture(t, { tasks: [task], apiFetch: (path, options) => {
    if (options?.method !== 'POST') return;
    calls.push(path);
    return Response.json({ error: '成片检查暂时不可用，请重试。' }, { status: 503 });
  } });
  page.recover(); await page.poll(); page.select(task.id);
  page.node('#replica-recheck').onclick(); await page.settle();
  assert.equal(page.message(), '成片检查暂时不可用，请重试。');
  assert.doesNotMatch(page.html(), /replica-speech|textarea/);
  assert.deepEqual(calls, ['/api/video-replica/tasks/editable-task/recheck']);
});

test('source dialogue stays hidden in every task state while saved captions remain intact', async t => {
  const tasks = ['draft', 'reserving', 'preparing', 'reviewing', 'submitting', 'running', 'downloading', 'verifying', 'settling', 'completed', 'failed', 'expired'].map(status => ({
    ...speechDraft(), id: `hidden-${status}`, status, canRecheck: status === 'failed',
    captions: { cues: [{ start: .1, end: 1, text: '原字幕内部保留' }] },
  }));
  const original = structuredClone(tasks);
  const page = await fixture(t, { tasks });
  page.recover(); await page.poll();
  for (const task of tasks) {
    page.select(task.id);
    assert.doesNotMatch(page.html(), /replica-speech|原视频台词|textarea|试听原视频|原字幕内部保留|薄饼|真的超好吃/, task.status);
    if (task.canRecheck) assert.match(page.html(), /id="replica-recheck"/);
  }
  assert.deepEqual(tasks, original);
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
    return Response.json({ task: { ...task, status: 'verifying', canRecheck: false } });
  } });
  page.recover(); await page.poll(); page.select(task.id);
  assert.match(page.html(), /id="replica-recheck"[^>]*>重新检查成片/);
  assert.match(page.html(), /成片台词与原视频不一致，未交付成片；请重新检查成片。/);
  assert.doesNotMatch(page.html(), /请核对素材后重新生成/);
  assert.doesNotMatch(page.html(), /replica-speech|textarea/);
  page.node('#replica-recheck').onclick(); page.node('#replica-recheck').onclick(); await page.settle();
  assert.deepEqual(calls, [{ path: '/api/video-replica/tasks/editable-task/recheck', body: {} }]);
  assert.doesNotMatch(page.html(), /id="replica-recheck"/);
});

test('recheck shows immediate progress and keeps the failure reason next to the action after polling', async t => {
  let task = { ...speechDraft(), status: 'failed', canRecheck: true, code: 'VIDEO_SPEECH_INVALID', error: '台词识别不完整，请核对素材后重新分析。' };
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const page = await fixture(t, { taskFetch: () => Response.json({ tasks: [task] }), apiFetch: async (path, options) => {
    if (options?.method !== 'POST') return;
    if (path.endsWith('/recheck')) { await waiting; task = { ...task, status: 'verifying', canRecheck: false, startedAt: Date.now(), error: '' }; }
    return Response.json({ task });
  } });
  page.recover(); await page.poll(); page.select(task.id);
  page.node('#replica-recheck').onclick(); await page.settle();
  assert.match(page.html(), /id="replica-recheck"[^>]*disabled[^>]*>正在提交复核/);
  release(); await page.settle();
  assert.match(page.message(), /正在核对已有成片/);
  task = { ...task, status: 'failed', canRecheck: true, error: '台词识别不完整，请核对素材后重新分析。' };
  await page.poll();
  assert.equal(page.message(), task.error);
  await page.poll();
  assert.equal(page.message(), task.error);
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
  assert.match(page.html(), /id="replica-submit"[^>]*>一键生成/);
  assert.doesNotMatch(page.cost(), /预计冻结|失败退回|积分不足/);
  page.recover(); await page.poll(); page.select(task.id);
  assert.equal(page.cost(), '无限积分 · 10 秒');
  assert.match(page.html(), /id="replica-submit"[^>]*>一键生成/);
  assert.doesNotMatch(page.cost(), /预计冻结|失败退回|结算/);
});

test('finite credits retain the normal freeze quote and refund message regardless of account name', async t => {
  const task = { id: 'draft-task', status: 'draft', createdAt: Date.now(), duration: 10, estimatedPoints: 112 };
  const page = await fixture(t, { tasks: [task] });
  globalThis.workspaceUser.account = 'zxc9911';
  globalThis.workspaceUser.unlimited = true;
  await page.wallet(finiteWallet());
  assert.equal(page.cost(), '按视频时长预留积分；失败退回预留积分。');
  assert.match(page.html(), /id="replica-submit"[^>]*>一键生成/);
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

test('reference voice jobs show separate parallel narration and lip-sync stages without invented ASR timing', async t => {
  const tasks = [
    { id: 'voice-running', status: 'running', voiceEngine: 'indextts2', narrationProgress: { ready: false } },
    { id: 'voice-finishing', status: 'verifying', voiceEngine: 'indextts2', narrationProgress: { ready: false } },
    { id: 'mouth-finishing', status: 'verifying', voiceEngine: 'indextts2', narrationProgress: { ready: true } },
    { id: 'voice-complete', status: 'completed', voiceEngine: 'indextts2', resultUrl: '/result',
      audioCheck: { engine: 'indextts2', referenceApplied: true, lipSync: 'processed' } },
  ];
  const page = await fixture(t, { tasks }); page.recover(); await page.poll();
  for (const [id, text] of [['voice-running', '正在替换人物并生成参考配音'], ['voice-finishing', '正在完成参考声音配音'],
    ['mouth-finishing', '正在同步口型与参考配音'], ['voice-complete', '已使用参考声音配音，并按新配音处理口型']]) {
    page.select(id); assert.ok(page.html().includes(text));
  }
  assert.doesNotMatch(page.html(), /NaN|开口偏差/);
});

test('voice picker defaults to Seedance and switching to IndexTTS sends the selection through uploads and start', async t => {
  let task; const calls = [];
  const page = await fixture(t, { apiFetch: (path, options) => {
    if (path.endsWith('/config')) return Response.json({ enabled: true, voiceEnabled: true,
      voiceEngines: [{ id: 'seedance', enabled: true }, { id: 'indextts2', enabled: true }] });
    if (!options?.method) return;
    const body = options.method === 'POST' ? JSON.parse(options.body) : options.body;
    calls.push({ path, body });
    if (path.endsWith('/tasks')) task = { id: body.requestId, voiceEngine: body.voiceEngine, status: 'draft', createdAt: Date.now() };
    for (const kind of ['video', 'photo', 'voice']) if (path.endsWith('/' + kind)) task = { ...task, [kind]: {} };
    if (path.endsWith('/start')) task = { ...task, voiceEngine: body.voiceEngine, status: 'running' };
    return Response.json({ task });
  } });
  page.recover(); await page.poll();
  assert.match(page.html(), /value="seedance" selected/);
  page.node('#replica-voice-engine').onchange({ target: { value: 'indextts2' } });
  await page.poll(); page.ctx.refresh();
  assert.match(page.html(), /value="indextts2" selected/);
  for (const kind of ['video', 'photo', 'voice']) page.node('#replica-' + kind).onchange({ target: { files: [new File(['data'], kind + '.mp4')] } });
  page.node('#replica-submit').onclick(); await page.settle();
  assert.equal(calls[0].body.voiceEngine, 'indextts2'); assert.equal(calls.at(-1).body.voiceEngine, 'indextts2');
  assert.match(page.html(), /id="replica-voice-engine" disabled/);
  assert.match(page.html(), /IndexTTS2 配音/);
  page.node('#replica-voice-engine').onchange({ target: { value: 'seedance' } });
  assert.match(page.html(), /value="indextts2" selected/);
  page.node('#replica-new').onclick();
  assert.match(page.html(), /value="seedance" selected/);
});

test('reopening an IndexTTS draft restores its choice and a Seedance override survives old draft responses', async t => {
  let task = { ...speechDraft(), voiceEngine: 'indextts2' }; const calls = [];
  const page = await fixture(t, { tasks: [task], apiFetch: (path, options) => {
    if (path.endsWith('/config')) return Response.json({ enabled: true, voiceEnabled: true,
      voiceEngines: [{ id: 'indextts2', enabled: true }] });
    if (options?.method !== 'POST') return;
    const body = JSON.parse(options.body); calls.push({ path, body });
    if (path.endsWith('/start')) task = { ...task, voiceEngine: body.voiceEngine, status: 'preparing' };
    return Response.json({ task });
  } });
  page.recover(); await page.poll(); page.select(task.id);
  assert.match(page.html(), /value="indextts2" selected/);
  assert.doesNotMatch(page.html().match(/<select[^>]+>/)[0], /disabled/);
  page.node('#replica-voice-engine').onchange({ target: { value: 'seedance' } });
  await page.poll();
  page.node('#replica-submit').onclick(); await page.settle();
  assert.equal(calls[0].body.voiceEngine, 'seedance'); assert.equal(calls[1].body.voiceEngine, 'seedance');
  assert.match(page.html(), /value="seedance" selected/);
  assert.match(page.html(), /Seedance 2.0 配音/);
});

test('IndexTTS asks for the required voice input before making any paid task request', async t => {
  const task = { ...speechDraft(), voice: undefined }; const calls = [];
  const page = await fixture(t, { tasks: [task], apiFetch: (path, options) => {
    if (path.endsWith('/config')) return Response.json({ enabled: true, voiceEnabled: true, voiceEngines: [{ id: 'indextts2', enabled: true }] });
    if (options?.method) calls.push(path);
  } });
  page.recover(); await page.poll(); page.select(task.id);
  page.node('#replica-voice-engine').onchange({ target: { value: 'indextts2' } });
  page.node('#replica-submit').onclick(); await page.settle();
  assert.equal(page.message(), '使用 IndexTTS2 请先上传声音参考。'); assert.deepEqual(calls, []);
});
