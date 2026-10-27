import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { renderGeneratedAssets, bindGeneratedAssets, disposeGeneratedAssets, handleGeneratedAssetsAction, loadAssetLibrary } from '../design/generated-assets.js';

const saved = (n, name = `照片${n}`) => {
  const id = `photo-${n.toString(16).padStart(64, '0')}`;
  return { id, name, filename: name + '.png', kind: 'photo', type: 'image', permanent: true, createdAt: 1000 + n, url: `/api/assets/materials/${id}/media` };
};
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
async function fixture(t, count = 1) {
  const previous = { document: globalThis.document, fetch: globalThis.fetch, workspaceUser: globalThis.workspaceUser };
  const { document, window } = parseHTML('<html><body data-page="assets"><main></main><dialog id="modal"></dialog></body></html>');
  globalThis.document = document; globalThis.workspaceUser = { id: crypto.randomUUID() };
  const materials = Array.from({ length: count }, (_, i) => saved(i + 1)), uploaded = saved(100, '新上传素材');
  const organization = { order: materials.map(item => `material:${item.id}`), deleted: [], assignments: {} };
  let fail = false;
  globalThis.fetch = async (path, options) => {
    if (options?.method === 'POST') {
      if (fail) return Response.json({ error: '上传失败' }, { status: 503 });
      organization.assignments[uploaded.id] = new URL(path, 'http://localhost').searchParams.get('folderId');
      return Response.json({ material: uploaded, organization });
    }
    return Response.json(path === '/api/assets/materials' ? { materials, organization } : { tasks: [] });
  };
  const modal = document.querySelector('#modal');
  const ctx = { mode: 'assets', esc: value => String(value ?? ''), icon: () => '', toast() {},
    button: (action, label, cls, attrs = '') => `<button data-action="${action}" class="${cls}" ${attrs}>${label}</button>`,
    openModal(_title, _subtitle, html) { modal.innerHTML = html; modal.open = true; },
  };
  const action = (name, dataset = {}) => handleGeneratedAssetsAction(name, { dataset }, ctx);
  t.after(() => { disposeGeneratedAssets(); Object.assign(globalThis, previous); });
  document.querySelector('main').innerHTML = renderGeneratedAssets(ctx); bindGeneratedAssets(ctx); await settle();
  action('asset-category', { type: 'all' });
  const upload = async (folder = 'photos') => {
    action('asset-upload');
    // linkedom does not implement the native select value setter.
    const type = document.querySelector('#asset-upload-type');
    Object.defineProperty(type, 'value', { value: 'image', configurable: true });
    type.dispatchEvent(new window.Event('change'));
    Object.defineProperty(document.querySelector('#asset-upload-folder'), 'value', { value: folder });
    Object.defineProperty(document.querySelector('#asset-upload-files'), 'files', { value: [new File(['new'], '新上传素材.png', { type: 'image/png' })] });
    document.querySelector('#asset-upload-start').click(); await settle();
  };
  return { document, window, modal, uploaded, organization, action, upload, fail: () => { fail = true; } };
}

test('asset-page upload refreshes after initial load completed, reveals destination despite old filters, and preserves manual order', async t => {
  const f = await fixture(t, 26);
  f.action('asset-category', { type: 'audio' });
  f.action('material-filter', { kind: 'voice' });
  f.action('asset-view-deleted');
  await f.upload('people');
  assert.match(f.document.querySelector('#asset-upload-results').textContent, /上传成功/);
  const cards = [...f.document.querySelectorAll('#material-assets-results [data-asset-key]')];
  assert.equal(cards.length, 1);
  assert.equal(cards[0].dataset.assetKey, `material:${f.uploaded.id}`);
  assert.match(f.document.querySelector('#asset-folder-panel').textContent, /人物/);
  assert.deepEqual((await loadAssetLibrary()).organization.order, f.organization.order);
});

test('new upload leads first page despite legacy manual order; modal close locates it', async t => {
  const f = await fixture(t, 26);
  await f.upload();
  const cards = [...f.document.querySelectorAll('#material-assets-results [data-asset-key]')];
  assert.equal(cards.length, 24);
  assert.equal(cards[0].dataset.assetKey, `material:${f.uploaded.id}`);
  assert.deepEqual(cards.slice(1).map(card => card.dataset.assetKey), [...f.organization.order].reverse().slice(0, 23));
  assert.equal(f.document.querySelector('[data-action="asset-move-prev"]'), null);
  assert.equal(f.document.querySelector('[draggable="true"]'), null);
  let scrolled = false;
  cards[0].scrollIntoView = () => { scrolled = true; };
  f.modal.open = false; f.modal.dispatchEvent(new f.window.Event('close'));
  assert.equal(scrolled, true);
});

test('failed upload stays failed and does not add a phantom asset', async t => {
  const f = await fixture(t); f.fail(); await f.upload();
  assert.match(f.document.querySelector('#asset-upload-results').textContent, /上传失败/);
  assert.equal(f.document.querySelectorAll('#material-assets-results [data-asset-key]').length, 1);
  assert.doesNotMatch(f.document.querySelector('#material-assets-results').textContent, /新上传素材/);
});
