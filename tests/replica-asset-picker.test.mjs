import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const photoId = `photo-${'a'.repeat(64)}`, voiceId = `voice-${'b'.repeat(64)}`;
const stored = (kind, id, name) => ({ kind, id, name, filename: name + (kind === 'photo' ? '.jpg' : '.wav'), type: kind === 'photo' ? 'image' : 'audio', permanent: true, createdAt: Date.now(), url: `/api/assets/materials/${id}/media` });
const assets = [stored('photo', photoId, '已存人物'), stored('voice', voiceId, '已存声音')];
const generatedId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

async function fixture(t, { fetchMedia, materials = assets } = {}) {
  const previous = { document: globalThis.document, fetch: globalThis.fetch, workspaceUser: globalThis.workspaceUser };
  const { document, window } = parseHTML('<html><body data-page="replica"><main></main><dialog id="modal"><div id="modal-body"></div></dialog></body></html>');
  globalThis.document = document; globalThis.workspaceUser = { id: crypto.randomUUID() };
  const calls = [], dialog = document.querySelector('#modal');
  Object.defineProperty(dialog, 'open', { get: () => dialog.hasAttribute('open') });
  dialog.close = () => { dialog.removeAttribute('open'); dialog.dispatchEvent(new window.Event('close')); };
  globalThis.fetch = async (path, options) => {
    calls.push({ path, options });
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
  if (['product', 'background'].includes(kind)) assert.ok(f.calls.some(call => call.path === assets[0].url));
  else assert.ok(!f.calls.some(call => call.path === assets.find(item => item.kind === kind).url), 'owned photo/voice IDs need no media download');
  f.node(`#replica-remove-${kind}`).click();
  assert.ok(!f.node(`#replica-toggle-${kind}`).hasAttribute('checked'));
  assert.doesNotMatch(f.node('main').textContent, /已存人物|已存声音/);
  f.node(`#replica-toggle-${kind}`).onchange({ target: { checked: true } });
  assert.doesNotMatch(f.node('main').textContent, /已存人物|已存声音/, 'cleared material must not reappear when enabled again');
  assert.ok(f.calls.every(call => !call.options?.method || call.options.method === 'GET'), 'picking and removing local materials never submits generation');
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
  f.node('#rap-upload').onchange({ target: { files: [new File(['video'], '替换视频.mp4', { type: 'video/mp4' })] } });
  assert.doesNotMatch(f.node('main').textContent, /替换视频/);
  await f.node('#rap-confirm').onclick();
  assert.match(f.node('main').textContent, /替换视频.mp4/);
  assert.doesNotMatch(f.node('main').textContent, /原片.mp4/);
});

test('closing the asset dialog during download prevents late material assignment', async t => {
  let complete;
  const f = await fixture(t, { fetchMedia: () => new Promise(resolve => { complete = resolve; }) });
  await f.open('product'); f.node(`[data-rap-key="${photoId}"]`).click();
  const confirm = f.node('#rap-confirm').onclick(); await f.settle();
  f.dialog.close(); complete(new Response('image', { headers: { 'Content-Type': 'image/jpeg' } })); await confirm;
  assert.ok(!f.node('#replica-toggle-product').hasAttribute('checked'));
  assert.doesNotMatch(f.node('main').textContent, /已存人物/);
});

test('failed downloads leave the dialog open with the original reference untouched', async t => {
  const f = await fixture(t, { fetchMedia: () => new Response('', { status: 503 }) });
  await f.open('background'); await f.choose(photoId);
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
  assert.ok(f.calls.every(call => !call.options?.method || call.options.method === 'GET'));
});
