import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createHash } from 'node:crypto';
import { renderGeneratedAssets, bindGeneratedAssets, disposeGeneratedAssets } from '../design/generated-assets.js';

const photoId = `photo-${'a'.repeat(64)}`, voiceId = `voice-${'b'.repeat(64)}`;
const stored = (kind, id, name) => ({ kind, id, name, filename: name + (kind === 'photo' ? '.jpg' : kind === 'voice' ? '.wav' : '.mp4'), type: kind === 'photo' ? 'image' : kind === 'voice' ? 'audio' : 'video', permanent: true, createdAt: Date.now(), url: `/api/assets/materials/${id}/media` });
const assets = [stored('photo', photoId, '已存人物'), stored('voice', voiceId, '已存声音')];
const generatedId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

async function fixture(t, { fetchMedia, fetchMetadata, materials = [...assets], uploadFailure = false, tasks = [] } = {}) {
  const previous = { document: globalThis.document, fetch: globalThis.fetch, workspaceUser: globalThis.workspaceUser };
  const { document, window } = parseHTML('<html><body data-page="replica"><main></main><dialog id="modal"><div id="modal-body"></div></dialog></body></html>');
  globalThis.document = document; globalThis.workspaceUser = { id: crypto.randomUUID() };
  const calls = [], dialog = document.querySelector('#modal');
  Object.defineProperty(dialog, 'open', { get: () => dialog.hasAttribute('open') });
  dialog.close = () => { dialog.removeAttribute('open'); dialog.dispatchEvent(new window.Event('close')); };
  globalThis.fetch = async (path, options) => {
    calls.push({ path, options });
    if (path.startsWith('/api/assets/materials/') && options?.method === 'POST') {
      if (uploadFailure && options.body.name !== '原片.mp4') return Response.json({ error: '素材入库失败，请重试。' }, { status: 503 });
      const kind = path.split('/').at(-1), hash = createHash('sha256').update(Buffer.from(await options.body.arrayBuffer())).digest('hex');
      const item = stored(kind, `${kind}-${hash}`, options.body.name.replace(/\.[^.]+$/, ''));
      if (!materials.some(existing => existing.id === item.id)) materials.push(item);
      return Response.json({ material: item });
    }
    if (path.endsWith('/media') || path.includes('/result-1.png')) return fetchMedia ? fetchMedia(path, options) : new Response('image', { headers: { 'Content-Type': 'image/jpeg' } });
    const metadata = fetchMetadata?.(path, options); if (metadata) return metadata;
    if (path === '/api/assets/materials') return Response.json({ materials });
    if (path.startsWith('/api/ai/images')) return Response.json({ tasks: [{ id: generatedId, status: 'completed', completedAt: Date.now(), prompt: '生成背景', images: [{ url: `/api/ai/media/${generatedId}/result-1.png`, filename: '背景.png' }] }] });
    return Response.json(path.endsWith('/config') ? { enabled: true, voiceEnabled: true } : { tasks });
  };
  const module = await import(`../design/video-replica.js?picker=${crypto.randomUUID()}`);
  const ctx = { mode: 'replica', assets: [], esc: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'), icon: () => '',
    refresh() { document.querySelector('main').innerHTML = module.renderVideoReplica(ctx); module.bindVideoReplica(ctx); },
    openModal(_title, _description, html) { document.querySelector('#modal-body').innerHTML = html; dialog.setAttribute('open', ''); },
    navigate() { assert.fail('selecting a replica asset must not navigate away'); },
  };
  t.after(() => { dialog.close(); module.disposeVideoReplica(); Object.assign(globalThis, previous); });
  const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
  const node = selector => document.querySelector(selector);
  ctx.refresh(); await settle(); node('#replica-mode-deep').click();
  await node('#replica-video').onchange({ target: { files: [new File(['video'], '原片.mp4', { type: 'video/mp4' })] } });
  return { ctx, calls, dialog, node, settle, document, window, module,
    open: async kind => { node(`[data-replica-select-${kind}]`).click(); await settle(); },
    choose: async key => { node(`[data-rap-key="${key}"]`).click(); await node('#rap-confirm').onclick(); await settle(); },
  };
}

test('enhanced editing switch is scoped to deep mode and keeps draft selections across mode changes', async t => {
  const f = await fixture(t);
  assert.equal(f.node('#replica-edit-mode').value, 'standard');
  f.node('#replica-edit-mode').onchange({ target: { value: 'enhanced' } });
  assert.equal(f.node('#replica-edit-mode').value, 'enhanced');
  assert.equal(f.node('#replica-models option[value="wan3.0-video"]'), null);
  f.node('#replica-mode-classic').click();
  assert.equal(f.node('#replica-edit-mode'), null);
  f.node('#replica-mode-deep').click();
  assert.equal(f.node('#replica-edit-mode').value, 'enhanced');
  assert.match(f.node('main').textContent, /原片.mp4/);
  f.node('#replica-edit-mode').onchange({ target: { value: 'standard' } });
  assert.ok(f.node('#replica-models option[value="wan3.0-video"]'));
  f.node('#replica-models').onchange({ target: { value: 'wan3.0-video' } });
  assert.equal(f.node('#replica-edit-mode option[value="enhanced"]').hasAttribute('disabled'), true);
  f.node('#replica-new').click();
  assert.equal(f.node('#replica-edit-mode').value, 'standard');
});

test('enhanced editing selection is submitted, restored from history and locked after submission', async t => {
  let task;
  const tasks = [];
  const f = await fixture(t, { tasks, fetchMetadata: (path, options) => {
    if (!options?.method || !path.startsWith('/api/video-replica/tasks')) return;
    const body = options.method === 'PUT' ? {} : JSON.parse(options.body);
    if (path === '/api/video-replica/tasks') task = { id: body.requestId, status: 'draft', createdAt: Date.now(), ...body };
    else if (path.endsWith('/video')) task.video = { duration: 4 };
    else if (path.endsWith('/start')) { task.status = 'running'; tasks.push(task); }
    return Response.json({ task });
  } });
  await f.settle();
  f.node('#replica-edit-mode').onchange({ target: { value: 'enhanced' } });
  f.node('#replica-submit').click(); await f.settle();
  assert.equal(task.editMode, 'enhanced'); assert.equal(task.mode, 'deep');
  assert.equal(task.status, 'running');
  assert.equal(f.node('#replica-edit-mode').hasAttribute('disabled'), true, f.node('#replica-edit-mode').outerHTML);
  assert.match(f.node('#replica-history').textContent, /视频编辑增强 2.0/);
  f.node('#replica-new').click();
  f.node(`[data-replica-task="${task.id}"]`).click();
  assert.equal(f.node('#replica-edit-mode').value, 'enhanced');
});

test('deep image previews open the clicked upload, navigate images only, and preserve replacement controls', async t => {
  const f = await fixture(t);
  const upload = async kind => f.node(`#replica-${kind}`).onchange({ target: { files: [new File(['data'], `${kind}.png`, { type: 'image/png' })] } });
  await upload('photo');
  f.node('#replica-preview-photo').click();
  assert.equal(f.dialog.open, true);
  assert.equal(f.node('#replica-image-full').src, f.node('#replica-preview-photo img').src);
  assert.equal(f.node('#replica-image-prev').hidden, true);
  assert.equal(f.node('#replica-image-next').hidden, true);
  f.dialog.close();
  await upload('product'); await upload('background');
  await f.open('voice'); await f.choose(voiceId);
  f.node('#replica-preview-photo').click();
  assert.equal(f.node('#replica-image-caption').textContent, '人物 · 2 / 3');
  assert.equal(f.node('#replica-image-next').hidden, false);
  f.node('#replica-image-next').click();
  assert.equal(f.node('#replica-image-full').src, f.node('#replica-preview-background img').src);
  f.node('#replica-image-next').click();
  assert.equal(f.node('#replica-image-caption').textContent, '商品 · 1 / 3');
  f.node('#replica-image-prev').click();
  assert.equal(f.node('#replica-image-caption').textContent, '背景 · 3 / 3');
  let prevented = false;
  f.node('#replica-image-preview').onkeydown({ key: 'ArrowLeft', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(f.node('#replica-image-caption').textContent, '人物 · 2 / 3');
  f.dialog.close();
  assert.equal(f.node('#replica-preview-photo').closest('label'), null);
  assert.equal(f.node('label.replica-material-add[for="replica-photo"]').textContent, '+');
  f.node('#replica-remove-product').click();
  f.node('#replica-preview-photo').click();
  assert.equal(f.node('#replica-image-caption').textContent, '人物 · 1 / 2');
});

test('deep history uses result or source video frames, shows the recorded model and generation time, and permits locked image previews', async t => {
  const tasks = [{ id: 'finished', status: 'completed', mode: 'deep', model: 'wan3.0-video-prime', createdAt: 1,
    startedAt: new Date(2026, 9, 24, 12, 34).getTime(), replacements: { photo: true }, sourcePhotoUrl: '/face.jpg',
    sourceVideoUrl: '/reference.mp4', resultUrl: '/finished.mp4', photo: {} },
  { id: 'waiting', status: 'waiting', mode: 'deep', model: 'doubao-seedance-2-5-260628', createdAt: 1, sourceVideoUrl: '/waiting.mp4' },
  { id: 'expired', status: 'expired', mode: 'deep', model: 'wan3.0-video', createdAt: 1 }];
  const f = await fixture(t, { tasks });
  const finished = f.node('[data-replica-task="finished"]'), waiting = f.node('[data-replica-task="waiting"]');
  assert.equal(finished.querySelector('video').getAttribute('src'), '/finished.mp4#t=0.001');
  assert.equal(waiting.querySelector('video').getAttribute('src'), '/waiting.mp4#t=0.001');
  assert.equal(f.node('[data-replica-task="expired"] video'), null);
  assert.equal(finished.querySelector('img'), null, 'the uploaded face is not the history cover');
  assert.equal(finished.querySelector('video').hasAttribute('muted'), true);
  assert.equal(finished.querySelector('video').hasAttribute('autoplay'), false);
  assert.match(finished.textContent, /qiya-3\.0 快速版/);
  assert.match(finished.textContent, /生成时间：.*2026.*12:34/);
  assert.match(waiting.textContent, /qiya-2\.5/);
  finished.click();
  assert.equal(f.node('#replica-photo').disabled, true);
  assert.equal(f.node('#replica-preview-photo').disabled, false);
  f.node('#replica-preview-photo').click();
  assert.equal(f.node('#replica-image-full').src, '/face.jpg');
});

test('deep history shows elapsed generation time, preserves the original start after rechecks, and does not invent missing durations', async t => {
  const start = new Date(2026, 9, 24, 12, 34).getTime();
  const cases = [
    ['seconds', { completedAt: start + 45_000 }, '45 秒'],
    ['minutes', { completedAt: start + 320_000 }, '5 分 20 秒'],
    ['hours', { completedAt: start + 3_723_000 }, '1 小时 2 分 3 秒'],
    ['rechecked', { generationStartedAt: start, startedAt: start + 300_000, completedAt: start + 320_000 }, '5 分 20 秒'],
    ['expired', { status: 'expired', completedAt: start + 61_000 }, '1 分 1 秒'],
    ['missing-end', {}, '暂无记录'],
    ['missing-start', { startedAt: null, completedAt: start + 45_000 }, '暂无记录'],
    ['invalid-order', { completedAt: start - 1000 }, '暂无记录'],
    ['running', { status: 'running' }, '生成中'],
    ['queued', { status: 'queued' }, '排队中'],
    ['waiting', { status: 'waiting' }, '已暂停'],
    ['failed', { status: 'failed' }, '未完成'],
    ['draft', { status: 'draft', startedAt: null }, '待生成'],
  ];
  const tasks = cases.map(([id, fields]) => ({ id, status: 'completed', mode: 'deep', model: 'wan3.0-video',
    createdAt: start - 600_000, startedAt: start, duration: 39, ...fields }));
  const f = await fixture(t, { tasks });
  for (const [id, , expected] of cases) assert.equal(f.node(`[data-replica-task="${id}"] .replica-history-duration`).textContent, `生成耗时：${expected}`);
});

for (const kind of ['photo', 'voice', 'product', 'background']) test(`${kind}: asset dialog confirms into the right slot and selected material can be removed`, async t => {
  const f = await fixture(t);
  await f.open(kind);
  assert.equal(f.dialog.open, true);
  assert.equal(f.node('#rap-confirm').disabled, true);
  const id = kind === 'voice' ? voiceId : photoId;
  assert.equal(Boolean(f.node(`[data-rap-key="${voiceId}"]`)), kind === 'voice');
  assert.equal(Boolean(f.node(`[data-rap-key="${photoId}"]`)), kind !== 'voice');
  await f.choose(id);
  assert.equal(f.dialog.open, false);
  assert.ok(f.node(`#replica-toggle-${kind}`).hasAttribute('checked'));
  assert.match(f.node('main').textContent, /原片.mp4/);
  assert.match(f.node('main').textContent, kind === 'voice' ? /已存声音/ : /已存人物/);
  assert.ok(!f.calls.some(call => call.path === assets[0].url || call.path === assets[1].url), 'owned asset IDs need no media download');
  const remove = f.node(`#replica-remove-${kind}`);
  assert.equal(remove.getAttribute('aria-label'), '取消选择');
  assert.ok(remove.closest('.replica-material-preview'));
  assert.equal(remove.closest('label'), null, 'removing a reference must not open the file chooser');
  assert.doesNotMatch(f.node('.replica-material-actions').textContent, /取消选择/);
  f.node(`#replica-remove-${kind}`).click();
  assert.ok(!f.node(`#replica-toggle-${kind}`).hasAttribute('checked'));
  assert.doesNotMatch(f.node('main').textContent, /已存人物|已存声音/);
  f.node(`#replica-toggle-${kind}`).onchange({ target: { checked: true } });
  assert.doesNotMatch(f.node('main').textContent, /已存人物|已存声音/, 'cleared material must not reappear when enabled again');
  assert.ok(f.calls.every(call => !call.options?.method || call.options.method === 'GET' || call.path.startsWith('/api/assets/materials/')), 'picking and removing local materials never submits generation');
});

test('asset dialog supports deselection, search, source filters and cancellation without changing the draft', async t => {
  const f = await fixture(t);
  await f.open('background');
  const card = () => f.node(`[data-rap-key="${photoId}"]`);
  card().click(); assert.equal(f.node('#rap-count').textContent, '已选 1/1');
  card().click(); assert.equal(f.node('#rap-count').textContent, '已选 0/1');
  assert.equal(f.node('#rap-confirm').disabled, true);
  f.node('#rap-search').oninput({ target: { value: '找不到的名称' } });
  assert.equal(f.document.querySelectorAll('[data-rap-key]').length, 0);
  f.node('#rap-search').oninput({ target: { value: '背景.png' } });
  assert.equal(f.document.querySelectorAll('[data-rap-key]').length, 1, 'search also matches the original filename');
  f.node('#rap-search').oninput({ target: { value: '' } });
  f.node('[data-rap-filter="generated"]').click();
  assert.equal(f.document.querySelectorAll('[data-rap-key]').length, 1);
  assert.equal(card(), null);
  f.node('[data-rap-key]').click(); f.node('#rap-cancel').click();
  assert.ok(!f.node('#replica-toggle-background').hasAttribute('checked'));
  assert.match(f.node('main').textContent, /原片.mp4/);
});

test('uploading in the asset dialog applies only on confirmation and supports reference video', async t => {
  const f = await fixture(t);
  await f.open('video');
  await f.node('#rap-upload').onchange({ target: { files: [new File(['video'], '替换视频.mp4', { type: 'video/mp4' })] } });
  assert.doesNotMatch(f.node('main').textContent, /替换视频/);
  await f.node('#rap-confirm').onclick();
  assert.match(f.node('main').textContent, /替换视频/);
  assert.doesNotMatch(f.node('main').textContent, /原片.mp4/);
});

test('closing the asset dialog during download prevents late material assignment', async t => {
  let complete;
  const f = await fixture(t, { fetchMedia: () => new Promise(resolve => { complete = resolve; }) });
  await f.open('product'); f.node('[data-rap-key^="image:"]').click();
  const confirm = f.node('#rap-confirm').onclick(); await f.settle();
  f.dialog.close(); complete(new Response('image', { headers: { 'Content-Type': 'image/jpeg' } })); await confirm;
  assert.ok(!f.node('#replica-toggle-product').hasAttribute('checked'));
  assert.doesNotMatch(f.node('main').textContent, /已存人物/);
});

test('failed downloads leave the dialog open with the original reference untouched', async t => {
  const f = await fixture(t, { fetchMedia: () => new Response('', { status: 503 }) });
  await f.open('background'); await f.choose(f.node('[data-rap-key^="image:"]').dataset.rapKey);
  assert.equal(f.dialog.open, true);
  assert.match(f.node('#rap-status').textContent, /素材下载失败/);
  assert.ok(!f.node('#replica-toggle-background').hasAttribute('checked'));
});

test('classic replica asset links fill the current draft without a destination chooser', async t => {
  const f = await fixture(t);
  f.node('#replica-mode-classic').click();
  await f.node('#replica-video').onchange({ target: { files: [new File(['video'], '原版参考.mp4')] } });
  await f.open('photo'); await f.choose(photoId);
  await f.open('voice'); await f.choose(voiceId);
  assert.equal(f.dialog.open, false);
  assert.match(f.node('main').textContent, /原版参考.mp4/);
  assert.match(f.node('main').textContent, /已存人物/);
  assert.match(f.node('main').textContent, /已存声音/);
  assert.doesNotMatch(f.node('main').textContent, /深度复刻素材与设置/);
  assert.ok(f.calls.every(call => !call.options?.method || call.options.method === 'GET' || call.path.startsWith('/api/assets/materials/')));
});

for (const kind of ['photo', 'voice', 'product', 'background', 'video']) test(`${kind}: uploading then cancelling keeps the asset in the sidebar and picker`, async t => {
  const f = await fixture(t), name = `新增-${kind}`, extension = kind === 'voice' ? 'wav' : kind === 'video' ? 'mp4' : 'png';
  const file = new File([name], `${name}.${extension}`);
  await f.open(kind);
  await f.node('#rap-upload').onchange({ target: { files: [file] } });
  assert.match(f.node('#rap-status').textContent, /已存入资产库/);
  const key = f.node('[data-rap-key][aria-pressed="true"]').dataset.rapKey;
  f.node('#rap-cancel').click();
  assert.doesNotMatch(f.node('main').textContent, new RegExp(name));
  f.document.body.dataset.page = 'assets'; f.ctx.mode = 'assets';
  f.node('main').innerHTML = renderGeneratedAssets({ ...f.ctx, button: () => '' });
  bindGeneratedAssets({ ...f.ctx, button: () => '' }); await f.settle();
  assert.match(f.node('#material-assets-results').textContent, new RegExp(name));
  disposeGeneratedAssets(); f.document.body.dataset.page = 'replica'; f.ctx.mode = 'replica'; f.ctx.refresh();
  await f.open(kind);
  assert.ok(f.node(`[data-rap-key="${key}"]`));
  await f.node('#rap-upload').onchange({ target: { files: [file] } });
  assert.equal(f.document.querySelectorAll(`[data-rap-key="${key}"]`).length, 1);
  await f.node('#rap-confirm').onclick();
  assert.match(f.node('main').textContent, new RegExp(name));
  assert.ok(!f.calls.some(call => call.path.endsWith('/start')));
});

test('failed asset uploads show an error without claiming storage or replacing the selected reference', async t => {
  const f = await fixture(t, { uploadFailure: true });
  await f.open('background');
  await f.node('#rap-upload').onchange({ target: { files: [new File(['new'], '失败图片.png')] } });
  assert.match(f.node('#rap-status').textContent, /入库失败/);
  assert.equal(f.node('#rap-confirm').disabled, true);
  assert.equal(f.dialog.open, true);
  assert.match(f.node('main').textContent, /原片.mp4/);
  assert.doesNotMatch(f.node('#rap-grid').textContent, /失败图片/);
});

test('picker displays and confirms saved material while a generated source is still loading, then reopens from cache', async t => {
  let finishSlow;
  const f = await fixture(t, { fetchMetadata: path => path.startsWith('/api/restaurant/') ? new Promise(resolve => { finishSlow = resolve; }) : null });
  await f.open('product');
  assert.ok(f.node(`[data-rap-key="${photoId}"]`));
  assert.doesNotMatch(f.node('#replica-asset-picker').textContent, /暂无可用素材/);
  await f.choose(photoId);
  assert.equal(f.dialog.open, false);
  assert.ok(f.node('#replica-remove-product'));
  const requests = f.calls.length;
  f.node('[data-replica-select-background]').click();
  assert.ok(f.node(`[data-rap-key="${photoId}"]`), 'cached cards render in the click handler without a loading gap');
  assert.equal(f.calls.length, requests);
  finishSlow(Response.json({ tasks: [] })); await f.settle();
  f.node('#rap-cancel').click(); await f.open('photo');
  assert.equal(f.calls.length, requests);
  assert.equal(f.document.querySelectorAll(`[data-rap-key="${photoId}"]`).length, 1);
});

test('picker does not claim the library is empty before its metadata arrives', async t => {
  let finish;
  const f = await fixture(t, { fetchMetadata: path => path === '/api/assets/materials' ? new Promise(resolve => { finish = resolve; }) : null });
  await f.open('voice');
  assert.match(f.node('#rap-status').textContent, /正在读取资产/);
  assert.doesNotMatch(f.node('#replica-asset-picker').textContent, /暂无可用素材/);
  finish(Response.json({ materials: [] })); await f.settle();
  assert.match(f.node('#replica-asset-picker').textContent, /暂无可用素材/);
});
