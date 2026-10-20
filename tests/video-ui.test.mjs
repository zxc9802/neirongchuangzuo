import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshWorkspaceCredits } from '../design/workspace-credits.js';

const finiteWallet = () => ({ available: 1000, held: 0, total: 1000, unlimited: false,
  pricing: { imagePerUnit: 50, videoPoints: 333, videoSeconds: 30 } });
const STANDARD_MODEL = 'doubao-seedance-2-0-260128', PREMIUM_MODEL = 'doubao-seedance-2-5-260628';
const FAST_MODEL = 'doubao-seedance-2-0-fast-260128', MINI_MODEL = 'doubao-seedance-2-0-mini-260615';

for (const stage of ['create', 'upload']) test(`a stalled replica ${stage} request releases the busy UI without automatic resubmission`, async t => {
  const controllers = new Map(); let task, posts = 0;
  t.mock.method(AbortSignal, 'timeout', ms => {
    const controller = new AbortController(); controllers.set(ms, controller); return controller.signal;
  });
  const page = await fixture(t, { apiFetch: (url, options) => {
    if (!options?.method) return;
    if (options.method === 'POST') {
      posts++; task = { id: JSON.parse(options.body).requestId, status: 'draft', createdAt: Date.now() };
      if (stage === 'upload') return Response.json({ task });
    }
    return new Promise((resolve, reject) => options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  } });
  page.recover(); await page.poll();
  for (const kind of ['video', 'photo', 'voice']) page.node('#replica-' + kind).onchange({target: {files: [new File(['data'], kind + '.mp4')]}});
  page.node('#replica-submit').onclick(); await page.settle();
  const timeout = stage === 'upload' ? 180_000 : 60_000;
  assert.ok(controllers.has(timeout), 'writes need a bounded deadline too');
  controllers.get(timeout).abort(new DOMException('Timed out', 'TimeoutError'));
  await page.settle();
  assert.match(page.message(), /超时/);
  assert.doesNotMatch(page.html(), /id="replica-submit"[^>]*disabled/);
  assert.equal(posts, 1);
});

async function fixture(t, { wallet = finiteWallet(), tasks = [], taskFetch, apiFetch } = {}) {
  const keys = ['workspaceUser', 'document', 'fetch', 'setInterval', 'clearInterval'];
  const original = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  const nodes = new Map();
  const node = selector => { if (!nodes.has(selector)) nodes.set(selector, { setAttribute(name, value) { this[name] = value; } }); return nodes.get(selector); };
  let failing = true, poll;
  globalThis.workspaceUser = { id: crypto.randomUUID() };
  globalThis.document = { body: { dataset: { page: 'replica' } }, querySelector: node };
  globalThis.setInterval = callback => { poll = callback; return 1; };
  globalThis.clearInterval = () => {};
  globalThis.fetch = async (path, options) => {
    if (apiFetch) { const response = await apiFetch(path, options); if (response) return response; }
    return path === '/api/workspace/credits' ? Response.json(wallet) : path.endsWith('/tasks')
      ? failing ? new Response('<html>Service restarting</html>', { status: 502 }) : taskFetch ? taskFetch(options) : Response.json({ tasks })
      : Response.json({ enabled: true, prompt: '人物复刻' });
  };
  const module = await import(`../design/video-replica.js?test-${crypto.randomUUID()}`);
  let html, renders = 0;
  const ctx = { esc: value => String(value ?? ''), icon: () => '', refresh() {
    renders++;
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
    html: () => html, cost: () => node('#replica-cost').textContent, renders: () => renders, settle,
    select: id => node('#replica-history').onclick({ target: { closest: () => ({ dataset: { replicaTask: id } }) } }),
    wallet: async value => { wallet = value; await refreshWorkspaceCredits(); } };
}

test('generation polling and credit updates preserve reference players while updating each task stage', async t => {
  const task = { id: 'stable-preview', status: 'running', createdAt: Date.now(), voiceEngine: 'indextts2',
    video: { width: 720, height: 1280 }, photo: {}, voice: {},
    sourceVideoUrl: '/source.mp4', sourcePhotoUrl: '/photo.jpg', sourceVoiceUrl: '/voice.wav',
    narrationProgress: { ready: false, completed: 0, total: 2 } };
  const page = await fixture(t, { tasks: [task] });
  page.recover(); await page.poll(); page.select(task.id); await page.settle();
  const renders = page.renders();
  for (const update of [
    { narrationProgress: { ready: false, completed: 1, total: 2 } },
    { status: 'downloading', downloadProgress: { receivedBytes: 1024 * 1024, totalBytes: 4 * 1024 * 1024 } },
    { downloadProgress: { receivedBytes: 2 * 1024 * 1024, totalBytes: 4 * 1024 * 1024 } },
    { status: 'verifying', actualDuration: 14.709, narrationProgress: { ready: true, completed: 2, total: 2 } },
  ]) {
    Object.assign(task, update);
    await page.poll();
    assert.equal(page.renders(), renders, 'Progress and billing notifications must not replace the page containing the reference players');
  }
  assert.match(page.node('#replica-progress').innerHTML, /保存成片：2.0 MB \/ 4.0 MB/);
  assert.match(page.node('#replica-result').innerHTML, /正在同步口型与参考配音/);
  assert.match(page.node('#replica-result-summary').innerHTML, /14.709 秒/);
  assert.match(page.node('#replica-submit-area').innerHTML, /id="replica-submit"[^>]*disabled[^>]*>正在同步口型与参考配音/);
  await page.wallet({ ...finiteWallet(), unlimited: true });
  assert.equal(page.cost(), '无限积分');
  assert.equal(page.renders(), renders);
  Object.assign(task, { status: 'completed', resultUrl: '/result.mp4' });
  await page.poll();
  assert.equal(page.renders(), renders);
  assert.match(page.node('#replica-result').innerHTML, /src="\/result.mp4"/);
  assert.match(page.node('#replica-submit-area').innerHTML, /id="replica-submit"[^>]*hidden/);
  const output = page.node('#replica-result'), resultHtml = output.innerHTML;
  let resultReplacements = 0;
  Object.defineProperty(output, 'innerHTML', { get: () => resultHtml, set() { resultReplacements++; } });
  Object.assign(task, { billing: { status: 'settled', chargedPoints: 20 } });
  await page.poll();
  assert.equal(page.renders(), renders);
  assert.equal(resultReplacements, 0, 'An unchanged result player must not be recreated');
  assert.match(page.node('#replica-result-summary').innerHTML, /已使用 20 积分/);
});

test('polling still replaces expired reference sources and adds recovery controls for failures', async t => {
  const task = { id: 'failed-preview', status: 'verifying', createdAt: Date.now(), voiceEngine: 'indextts2',
    video: { width: 720, height: 1280 }, photo: {}, voice: {},
    sourceVideoUrl: '/source.mp4', sourcePhotoUrl: '/photo.jpg', sourceVoiceUrl: '/voice.wav' };
  const page = await fixture(t, { tasks: [task] });
  page.recover(); await page.poll(); page.select(task.id); await page.settle();
  const renders = page.renders();
  Object.assign(task, { status: 'failed', canRecheck: true, error: '配音暂时无法处理' });
  await page.poll();
  assert.equal(page.renders(), renders);
  assert.match(page.node('#replica-submit-area').innerHTML, /id="replica-recheck"/);
  assert.equal(typeof page.node('#replica-recheck').onclick, 'function');
  assert.equal(page.message(), task.error);
  Object.assign(task, { status: 'expired', canRecheck: false, sourceVideoUrl: null, sourcePhotoUrl: null, sourceVoiceUrl: null });
  await page.poll();
  assert.equal(page.renders(), renders + 1);
  assert.doesNotMatch(page.html(), /src="\/source.mp4"|src="\/voice.wav"|src="\/photo.jpg"/);
});

test('edition buttons show the requested descriptions and update the upload duration hint', async t => {
  const page = await fixture(t); page.recover(); await page.poll();
  for (const name of ['qiya-2.0', 'qiya-2.5', 'qiya-2.0-f1', 'qiya-20-m1']) assert.ok(page.html().includes(`<strong>${name}</strong>`));
  assert.doesNotMatch(page.html(), /Wan 2\.2|wan\/v2\.2-14b|PixVerse Swap|fal-ai\/pixverse\/swap/);
  for (const price of ['1', '0.8', '0.5']) assert.ok(page.html().includes(`最多生成15秒视频，${price}元/秒`));
  assert.match(page.html(), /最多生成30秒视频，1.5元\/秒/);
  assert.doesNotMatch(page.html(), /标准版|至臻版/);
  assert.match(page.html(), /data-replica-model="doubao-seedance-2-0-260128"[^>]*aria-pressed="true"/);
  page.node('#replica-models').onclick({ target: { closest: () => ({ dataset: { replicaModel: PREMIUM_MODEL } }) } });
  await page.settle();
  assert.match(page.html(), /data-replica-model="doubao-seedance-2-5-260628"[^>]*aria-pressed="true"/);
  assert.match(page.html(), /单个人物 · 2–30 秒/);
  page.node('#replica-new').onclick();
  assert.match(page.html(), /单个人物 · 2–15 秒/);
});

for (const model of [STANDARD_MODEL, PREMIUM_MODEL, FAST_MODEL, MINI_MODEL]) test(`${model} uses direct voice during task creation and start`, async t => {
  let task; const calls = [];
  const page = await fixture(t, { apiFetch: (path, options) => {
    if (!options?.method) return;
    const body = options.method === 'POST' ? JSON.parse(options.body) : options.body;
    calls.push({ path, body });
    if (path.endsWith('/tasks')) task = { id: body.requestId, model: body.model, voiceEngine: body.voiceEngine, status: 'draft', createdAt: Date.now() };
    for (const kind of ['video', 'photo', 'voice']) if (path.endsWith('/' + kind)) task = { ...task, [kind]: {} };
    if (path.endsWith('/start')) task = { ...task, status: 'running' };
    return Response.json({ task });
  } });
  page.recover(); await page.poll();
  page.node('#replica-models').onclick({ target: { closest: () => ({ dataset: { replicaModel: model } }) } }); await page.settle();
  for (const kind of ['video', 'photo', 'voice']) page.node('#replica-' + kind).onchange({ target: { files: [new File(['data'], kind + '.mp4')] } });
  page.node('#replica-submit').onclick(); await page.settle();
  assert.equal(calls[0].body.model, model); assert.equal(calls.at(-1).body.model, model);
  assert.equal(calls[0].body.voiceEngine, 'seedance'); assert.equal(calls.at(-1).body.voiceEngine, 'seedance');
  assert.equal(calls[0].body.sourceAudioMode, 'silent'); assert.equal(calls.at(-1).body.sourceAudioMode, 'silent');
  const count = calls.length;
  page.node('#replica-models').onclick({ target: { closest: () => ({ dataset: { replicaModel: STANDARD_MODEL } }) } }); await page.settle();
  assert.equal(calls.length, count);
  assert.match(page.html(), new RegExp(`data-replica-model="${model}"[^>]*aria-pressed="true"[^>]*disabled`));
});

test('direct voice stays hidden and remains the default after starting and creating another task', async t => {
  let task; const calls = [];
  const page = await fixture(t, { apiFetch: (path, options) => {
    if (!options?.method) return;
    const body = options.method === 'POST' ? JSON.parse(options.body) : options.body;
    calls.push({ path, body });
    if (path.endsWith('/tasks')) task = { id: body.requestId, model: body.model, voiceEngine: body.voiceEngine,
      sourceAudioMode: body.sourceAudioMode, status: 'draft', createdAt: Date.now() };
    for (const kind of ['video', 'photo', 'voice']) if (path.endsWith('/' + kind)) task = { ...task, [kind]: {} };
    if (path.endsWith('/start')) task = { ...task, status: 'running' };
    return Response.json({ task });
  } });
  page.recover(); await page.poll();
  assert.doesNotMatch(page.html(), /无原声直配（试用）|参考视频声音/);
  assert.doesNotMatch(page.html(), /原声参考（默认）|无原声参考|data-source-audio|选择参考视频声音模式/);
  for (const kind of ['video', 'photo', 'voice']) page.node('#replica-' + kind).onchange({ target: { files: [new File(['data'], kind + '.mp4')] } });
  page.node('#replica-submit').onclick(); await page.settle();
  assert.equal(calls[0].body.sourceAudioMode, 'silent'); assert.equal(calls.at(-1).body.sourceAudioMode, 'silent');
  assert.equal(calls[0].body.voiceEngine, 'seedance'); assert.equal(calls.at(-1).body.voiceEngine, 'seedance');
  assert.doesNotMatch(page.html(), /无原声直配（试用）|参考视频声音/);
  page.node('#replica-new').onclick();
  assert.doesNotMatch(page.html(), /无原声直配（试用）|参考视频声音/);
  assert.doesNotMatch(page.html(), /原声参考（默认）|无原声参考|data-source-audio/);
  for (const kind of ['video', 'photo', 'voice']) page.node('#replica-' + kind).onchange({ target: { files: [new File(['data'], kind + '.mp4')] } });
  page.node('#replica-submit').onclick(); await page.settle();
  assert.equal(calls.at(-1).body.voiceEngine, 'seedance'); assert.equal(calls.at(-1).body.sourceAudioMode, 'silent');
});

test('direct voice requires an uploaded voice before creating a paid task', async t => {
  let writes = 0;
  const page = await fixture(t, { apiFetch: (_path, options) => { if (options?.method) writes++; } });
  page.recover(); await page.poll();
  for (const kind of ['video', 'photo']) page.node('#replica-' + kind).onchange({ target: { files: [new File(['data'], kind + '.mp4')] } });
  page.node('#replica-submit').onclick(); await page.settle();
  assert.match(page.message(), /请先上传声音参考/); assert.equal(writes, 0);
});

test('PixVerse can no longer be selected for a new task but its historical result stays viewable', async t => {
  const task = { ...speechDraft(), model: 'fal-ai/pixverse/swap', status: 'completed', voiceEngine: 'indextts2', resultUrl: '/old-result.mp4' };
  const page = await fixture(t, { tasks: [task] });
  page.recover(); await page.poll();
  page.node('#replica-models').onclick({ target: { closest: () => ({ dataset: { replicaModel: task.model } }) } }); await page.settle();
  assert.match(page.html(), /data-replica-model="doubao-seedance-2-0-260128"[^>]*aria-pressed="true"/);
  assert.doesNotMatch(page.html(), /data-replica-model="fal-ai\/pixverse\/swap"/);
  page.select(task.id);
  assert.match(page.html(), /PixVerse Swap/); assert.match(page.html(), /src="\/old-result.mp4"/);
  assert.doesNotMatch(page.html(), /无原声直配（试用）|data-source-audio/);
});

test('saved premium drafts keep their edition and a rejected downgrade retains the original quote', async t => {
  const task = { ...speechDraft(), model: PREMIUM_MODEL, duration: 20, estimatedPoints: 2500 }, calls = [];
  const page = await fixture(t, { tasks: [task], apiFetch: (path, options) => {
    if (options?.method === 'POST') { calls.push(path); return Response.json({ error: '参考视频需为 2–15 秒，宽高至少 300 像素。' }, { status: 400 }); }
  } });
  page.recover(); await page.poll(); page.select(task.id);
  assert.match(page.html(), /单个人物 · 2–30 秒/);
  page.node('#replica-models').onclick({ target: { closest: () => ({ dataset: { replicaModel: STANDARD_MODEL } }) } }); await page.settle();
  assert.deepEqual(calls, ['/api/video-replica/tasks/editable-task/model']);
  assert.match(page.message(), /2–15 秒/); assert.match(page.html(), /单个人物 · 2–30 秒/);
  assert.match(page.cost(), /2500/);
});

test('a shorter local replacement is saved before downgrading a premium draft and is not uploaded twice', async t => {
  let task = { ...speechDraft(), model: PREMIUM_MODEL, duration: 20, estimatedPoints: 2500 }; const calls = [];
  const page = await fixture(t, { taskFetch: () => Response.json({ tasks: [task] }), apiFetch: (path, options) => {
    if (!options?.method) return;
    calls.push(path);
    if (path.endsWith('/video')) task = { ...task, duration: 10, estimatedPoints: 1250 };
    if (path.endsWith('/model')) task = { ...task, model: JSON.parse(options.body).model };
    if (path.endsWith('/start')) task = { ...task, status: 'running' };
    return Response.json({ task });
  } });
  page.recover(); await page.poll(); page.select(task.id);
  page.node('#replica-video').onchange({ target: { files: [new File(['shorter'], 'short.mp4')] } });
  page.node('#replica-models').onclick({ target: { closest: () => ({ dataset: { replicaModel: STANDARD_MODEL } }) } }); await page.settle();
  assert.deepEqual(calls, ['/api/video-replica/tasks/editable-task/video', '/api/video-replica/tasks/editable-task/model']);
  assert.match(page.html(), /单个人物 · 2–15 秒/); assert.match(page.cost(), /1250/);
  page.node('#replica-submit').onclick(); await page.settle();
  assert.equal(calls.filter(path => path.endsWith('/video')).length, 1);
});

test('automatic successful polling clears restart errors on first load and after a loaded page', async t => {
  const page = await fixture(t);
  assert.match(page.message(), /正在重新连接/);
  page.recover(); await page.poll();
  assert.equal(page.message(), '');
  page.fail(); await page.poll();
  assert.match(page.message(), /正在重新连接/);
  page.recover(); await page.poll();
  assert.equal(page.message(), '');
  page.ctx.refresh(); assert.equal(page.message(), '');
});

test('saved progress uses a neutral waiting state and resumes or stops the same task', async t => {
  const task = { id: 'recovery-task', status: 'waiting', createdAt: Date.now(), voiceEngine: 'indextts2',
    recovery: { state: 'waiting', message: '进度已保存，可以继续处理。' }, canResume: true, canCancel: true,
    narrationProgress: { completed: 2, total: 3, ready: false } };
  const calls = [];
  const page = await fixture(t, { tasks: [task], apiFetch: (path, options) => {
    if (options?.method !== 'POST') return;
    calls.push(path);
    assert.ok(path.endsWith('/resume') || path.endsWith('/cancel'));
    Object.assign(task, { status: path.endsWith('/resume') ? 'running' : 'cancelled', recovery: undefined, canResume: false });
    return Response.json({ task });
  } });
  page.recover(); await page.poll(); page.select(task.id); await page.settle();
  assert.match(page.message(), /进度已保存/);
  assert.match(page.html(), /role="status"/); assert.doesNotMatch(page.html(), /role="alert"|class="replica-error"/);
  assert.match(page.html(), /id="replica-resume"/); assert.match(page.html(), /id="replica-cancel"/);
  page.node('#replica-resume').onclick(); await page.settle();
  assert.equal(task.status, 'running');
  await page.poll(); page.node('#replica-cancel').onclick(); await page.settle();
  assert.equal(task.status, 'cancelled');
  assert.deepEqual(calls, ['/api/video-replica/tasks/recovery-task/resume', '/api/video-replica/tasks/recovery-task/cancel']);
});

for (const [width, height] of [[720, 1280], [1280, 720], [720, 720], [720, 960]]) {
  test(`replica preview follows uploaded ${width}x${height} video dimensions`, async t => {
    const task = { id: 'aspect-task', status: 'completed', createdAt: Date.now(), ratio: '16:9',
      video: { width, height }, resultUrl: '/api/video-replica/tasks/aspect-task/result' };
    const page = await fixture(t, { tasks: [task] });
    page.recover(); await page.poll(); page.select(task.id);
    const player = page.html().match(/<div[^>]*id="replica-result"[^>]*>/)[0];
    assert.ok(player.includes(`--replica-aspect:${width}/${height}`), 'The source dimensions override a stale task ratio');
    assert.ok(player.includes(`--replica-max-width:${Math.round(440 * width / height)}px`));
    assert.match(page.html(), /aria-label="人物复刻成片"/);
    await page.poll();
    assert.ok(page.html().includes(`--replica-aspect:${width}/${height}`), 'Polling preserves the video proportion');
    page.node('#replica-new').onclick();
    assert.doesNotMatch(page.html(), /--replica-aspect:/, 'A new blank form has no inherited media dimensions');
  });
}

test('historical replica previews use their recorded ratio when source dimensions are missing', async t => {
  const task = { id: 'legacy-aspect', status: 'completed', createdAt: Date.now(), ratio: '9:16',
    resultUrl: '/api/video-replica/tasks/legacy-aspect/result' };
  const page = await fixture(t, { tasks: [task] });
  page.recover(); await page.poll(); page.select(task.id);
  assert.ok(page.html().includes('--replica-aspect:9/16'));
});

for (const status of ['completed', 'running', 'failed', 'draft']) test(`reopening the page starts blank with a ${status} task available in history`, async t => {
  const task = { id: 'saved-task', status, createdAt: Date.now(), video: {}, photo: {}, voice: {}, voiceEngine: 'seedance',
    sourceVideoUrl: '/source.mp4', sourcePhotoUrl: '/photo.jpg', sourceVoiceUrl: '/reference.wav',
    resultUrl: status === 'completed' ? '/api/video-replica/tasks/saved-task/result' : null };
  const page = await fixture(t, { tasks: [task] });
  page.recover(); await page.poll();
  for (let i = 0; i < 2; i++) {
    await page.poll(); page.ctx.refresh();
    assert.match(page.html(), /成片在这里预览/);
    assert.match(page.html(), /data-replica-task="saved-task"/);
    assert.match(page.html(), /声音参考<small>必填/);
    assert.doesNotMatch(page.html(), /replica-voice-engine|配音模型|IndexTTS2/);
    assert.doesNotMatch(page.html(), /素材已上传并保存|aria-label="人物复刻成片"/);
    for (const kind of ['video', 'photo']) assert.doesNotMatch(page.html().match(new RegExp(`<input[^>]*id="replica-${kind}"[^>]*>`))[0], /disabled/);
  }
  page.select(task.id);
  assert.match(page.html(), /素材已上传并保存/);
  assert.match(page.html(), status === 'draft' ? /声音参考<small>必填/ : /声音参考<small>选填/);
  if (status === 'completed') assert.match(page.html(), /aria-label="人物复刻成片"/);
  page.node('#replica-new').onclick();
  await page.poll();
  assert.doesNotMatch(page.html(), /aria-label="人物复刻成片"/);
  assert.match(page.html(), /成片在这里预览/);
});

test('New Replica stays available during generation and polling preserves the new form', async t => {
  const task = { id: 'running-task', status: 'running', createdAt: Date.now(), video: {}, photo: {} };
  const page = await fixture(t, { tasks: [task] });
  page.recover(); await page.poll(); page.select(task.id);
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
  page.recover(); await page.poll(); page.select(task.id);
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
  page.recover(); await page.poll(); page.select(task.id);
  assert.match(page.html(), /已保留模型生成的声音/);
  assert.match(page.html(), /aria-label="人物复刻成片"/);
  assert.match(page.html(), /href="\/api\/video-replica\/tasks\/advisory-task\/result\?download=1"/);
  assert.doesNotMatch(page.html(), /台词一致|开口偏差|NaN/);
});

function speechDraft() {
  return { id: 'editable-task', status: 'draft', createdAt: Date.now(), captionsChecked: true, video: {}, photo: {}, voice: {},
    speech: { start: 0, end: 2, segments: [{ start: 0, end: 1, text: '薄饼' }, { start: 1.3, end: 2, text: '真的超好吃' }] } };
}

test('caption drafts start in direct voice without a transcript confirmation step', async t => {
  let task = { ...speechDraft(), captions: { cues: [
    { start: .1, end: .6, text: '今天吃生腌' }, { start: .6, end: 1.2, text: '只要9.9元' },
    { start: 1.3, end: 2, text: '真的超好吃' },
  ] } };
  const calls = [];
  const page = await fixture(t, { tasks: [task], apiFetch: (path, options) => {
    if (options?.method !== 'POST') return;
    const body = JSON.parse(options.body); calls.push({ path, body });
    if (path.endsWith('/start')) task = { ...task, ...body, status: 'preparing' };
    return Response.json({ task });
  } });
  page.recover(); await page.poll(); page.select(task.id);
  assert.match(page.html(), /id="replica-submit"[^>]*>一键生成/);
  assert.doesNotMatch(page.html(), /replica-speech|textarea|确认台词/);
  page.node('#replica-submit').onclick(); await page.settle();
  assert.deepEqual(calls.map(call => call.path), ['/api/video-replica/tasks', '/api/video-replica/tasks/editable-task/start']);
  assert.equal(calls[1].body.speechConfirmed, undefined);
  assert.match(page.html(), /正在将原视频语音转为台词/);
  assert.doesNotMatch(page.html(), /replica-speech|原视频台词|textarea|今天吃生腌/);
  assert.equal(task.captions.cues[0].text, '今天吃生腌');
});

for (const fal of ['minimax/h3-max/reference-to-video', 'fal-ai/wan/v2.2-14b/animate/replace']) test(`edition picker keeps removed ${fal} drafts compatible with the standard model`, async t => {
  const seedance = 'doubao-seedance-2-0-260128';
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
  assert.doesNotMatch(page.html(), /minimax\/h3-max|wan\/v2\.2-14b|Wan 2\.2/);
  assert.match(page.html(), /1:1复刻 · qiya-2\.0/);
  assert.match(page.html(), /id="replica-models"/);
  page.node('#replica-submit').onclick(); await page.settle();
  assert.equal(calls.find(call => call.path.endsWith('/tasks')).body.model, seedance);
  assert.equal(calls.find(call => call.path.endsWith('/start')).body.model, seedance);
  task = { ...task, model: fal, status: 'completed', modelName: '极速模型', resolution: '768p', resultUrl: '/api/video-replica/tasks/editable-task/result' };
  await page.poll(); page.select(task.id);
  assert.match(page.html(), /自动比例 · 768p/);
  assert.doesNotMatch(page.html(), /极速模型/);
  assert.match(page.html(), /aria-label="人物复刻成片"/);
  page.node('#replica-new').onclick();
  assert.doesNotMatch(page.html(), /极速模型|minimax\/h3-max|wan\/v2\.2-14b|Wan 2\.2/);
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
  page.recover(); await page.poll(); page.select(task.id);
  assert.match(page.html(), /保存成片：1.0 MB \/ 4.0 MB/);
  assert.match(page.html(), /progress aria-label="成片保存进度" max="4194304" value="1048576"/);
  task.downloadProgress.totalBytes = null;
  await page.poll();
  assert.match(page.node('#replica-progress').innerHTML, /保存成片：1.0 MB/);
  assert.doesNotMatch(page.node('#replica-progress').innerHTML, /progress aria-label="成片保存进度"/);
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
  page.recover(); await page.poll(); page.select(task.id);
  assert.equal(page.cost(), '10 秒');
  assert.doesNotMatch(page.html(), /预计冻结|失败退回预留积分|已冻结|已使用|查看费用/);
  assert.match(page.html(), /id="replica-submit"[^>]*disabled[^>]*>正在替换人物/);
});

test('pending tasks show elapsed time, last model reply and a task ID instead of a fixed wait estimate', async t => {
  const now = Date.now();
  const task = { id: 'waiting-task', status: 'running', createdAt: now - 700_000, startedAt: now - 650_000, lastCheckedAt: now - 30_000 };
  const page = await fixture(t, { tasks: [task] });
  page.recover(); await page.poll(); page.select(task.id);
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
  assert.match(page.message(), /正在重新连接/);
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

test('replica has no voice picker or model labels and still sends its default through uploads and start', async t => {
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
  assert.doesNotMatch(page.html(), /replica-voice-engine|配音模型|IndexTTS2|Seedance 2.0/);
  assert.match(page.html(), /声音参考<small>必填/);
  for (const kind of ['video', 'photo', 'voice']) page.node('#replica-' + kind).onchange({ target: { files: [new File(['data'], kind + '.mp4')] } });
  page.node('#replica-submit').onclick(); await page.settle();
  assert.equal(calls[0].body.voiceEngine, 'seedance'); assert.equal(calls.at(-1).body.voiceEngine, 'seedance');
  assert.doesNotMatch(page.html(), /replica-voice-engine|配音模型|IndexTTS2|Seedance 2.0/);
  const summary = page.html().match(/id="replica-result-summary"[^>]*>(.*?)<div id="replica-progress"/s)[1];
  assert.doesNotMatch(summary, /旗舰模型/);
  page.node('#replica-new').onclick();
  assert.match(page.html(), /声音参考<small>必填/);
  assert.doesNotMatch(page.html(), /replica-voice-engine|配音模型|IndexTTS2|Seedance 2.0/);
});

for (const voiceEngine of ['indextts2', 'seedance']) for (const sourceAudioMode of ['original', 'silent']) test(`reopening a ${voiceEngine} ${sourceAudioMode} draft submits direct voice after polling`, async t => {
  let task = { ...speechDraft(), voiceEngine, sourceAudioMode }; const calls = [];
  const page = await fixture(t, { tasks: [task], apiFetch: (path, options) => {
    if (path.endsWith('/config')) return Response.json({ enabled: true, voiceEnabled: true,
      voiceEngines: [{ id: 'indextts2', enabled: true }] });
    if (options?.method !== 'POST') return;
    const body = JSON.parse(options.body); calls.push({ path, body });
    if (path.endsWith('/start')) task = { ...task, voiceEngine: body.voiceEngine, sourceAudioMode: body.sourceAudioMode, status: 'preparing' };
    return Response.json({ task });
  } });
  page.recover(); await page.poll(); page.select(task.id);
  assert.doesNotMatch(page.html(), /replica-voice-engine|配音模型|IndexTTS2|Seedance 2.0/);
  assert.doesNotMatch(page.html(), /无原声直配（试用）|参考视频声音/);
  assert.doesNotMatch(page.html(), /原声参考（默认）|无原声参考|data-source-audio/);
  await page.poll();
  page.node('#replica-submit').onclick(); await page.settle();
  assert.equal(calls[0].body.voiceEngine, 'seedance'); assert.equal(calls[1].body.voiceEngine, 'seedance');
  assert.equal(calls[0].body.sourceAudioMode, 'silent'); assert.equal(calls[1].body.sourceAudioMode, 'silent');
  assert.doesNotMatch(page.html(), /replica-voice-engine|配音模型|IndexTTS2|Seedance 2.0/);
});

test('a legacy draft also requires a voice before submitting in direct mode', async t => {
  const task = { ...speechDraft(), voiceEngine: 'indextts2', voice: undefined }; const calls = [];
  const page = await fixture(t, { tasks: [task], apiFetch: (path, options) => {
    if (path.endsWith('/config')) return Response.json({ enabled: true, voiceEnabled: true, voiceEngines: [{ id: 'indextts2', enabled: true }] });
    if (options?.method) calls.push(path);
  } });
  page.recover(); await page.poll(); page.select(task.id);
  page.node('#replica-submit').onclick(); await page.settle();
  assert.equal(page.message(), '请先上传声音参考。'); assert.deepEqual(calls, []);
});

test('historical voice failures retain the reason without displaying the engine name', async t => {
  const task = { ...speechDraft(), voiceEngine: 'indextts2', status: 'failed',
    error: 'IndexTTS2 未完成配音，请检查参考声音后重新生成。' };
  const page = await fixture(t, { tasks: [task] }); page.recover(); await page.poll(); page.select(task.id);
  assert.equal(page.message(), '配音服务 未完成配音，请检查参考声音后重新生成。');
  assert.doesNotMatch(page.html(), /IndexTTS2|replica-voice-engine|配音模型/);
  assert.equal(task.error, 'IndexTTS2 未完成配音，请检查参考声音后重新生成。');
});

test('API voice errors do not reintroduce the removed engine name', async t => {
  const task = { ...speechDraft(), voiceEngine: 'indextts2' };
  const page = await fixture(t, { tasks: [task], apiFetch: (path, options) => {
    if (options?.method === 'POST') return Response.json({ error: 'IndexTTS2 拒绝了配音请求，请检查参考音频。' }, { status: 502 });
  } });
  page.recover(); await page.poll(); page.select(task.id);
  page.node('#replica-submit').onclick(); await page.settle();
  assert.match(page.message(), /配音服务.*拒绝了配音请求/);
  assert.doesNotMatch(page.html(), /IndexTTS2|replica-voice-engine|配音模型/);
});
