import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createHash } from 'node:crypto';
import { renderGeneratedAssets, bindGeneratedAssets, disposeGeneratedAssets } from '../design/generated-assets.js';

const photoId = `photo-${'a'.repeat(64)}`, voiceId = `voice-${'b'.repeat(64)}`;
const stored = (kind, id, name) => ({ kind, id, name, filename: name + (kind === 'photo' ? '.jpg' : kind === 'voice' ? '.wav' : '.mp4'), type: kind === 'photo' ? 'image' : kind === 'voice' ? 'audio' : 'video', permanent: true, createdAt: Date.now(), url: `/api/assets/materials/${id}/media` });
const assets = [stored('photo', photoId, '已存人物'), stored('voice', voiceId, '已存声音')];
const generatedId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

async function fixture(t, { fetchMedia, materials = [...assets], uploadFailure = false } = {}) {
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
    if (path === '/api/assets/materials') return Response.json({ materials });
    if (path.startsWith('/api/ai/images')) return Response.json({ tasks: [{ id: generatedId, status: 'completed', completedAt: Date.now(), prompt: '生成背景', images: [{ url: `/api/ai/media/${generatedId}/result-1.png`, filename: '背景.png' }] }] });
    return Response.json(path.endsWith('/config') ? { enabled: true, voiceEnabled: true } : { tasks: [] });
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
