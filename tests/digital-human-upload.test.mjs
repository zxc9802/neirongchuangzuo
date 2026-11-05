import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { digitalHumanApi as api } from '../design/digital-human-api.js';

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

async function page(t) {
  const { document, window } = parseHTML('<html><body><main class="avatar-studio"></main></body></html>');
  const storage = new Map(), notices = [], uploads = [];
  const originals = Object.fromEntries(['document', 'window', 'localStorage'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document, window, localStorage: {
    getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value),
  } });
  t.after(() => {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  let avatar;
  t.mock.method(api, 'getSession', async () => ({ data: { user: { id: 'test' } } }));
  t.mock.method(api, 'getStatus', async () => ({ ready: true, engines: [{ id: 'b', label: 'qy-标准', available: true }] }));
  t.mock.method(api, 'listVoices', async () => []);
  t.mock.method(api, 'listLibrary', async () => ({ items: [], counts: {}, hasMore: false, selection: { avatar } }));
  const create = t.mock.method(api, 'createAvatar', async (file, options) => {
    uploads.push(file);
    options.onProgress(50);
    avatar = { id: 'uploaded', name: options.name, videoUrl: '/avatar.mp4' };
    return avatar;
  });
  const mod = await import(`../design/digital-human.js?upload=${crypto.randomUUID()}`);
  t.after(() => mod.disposeDigitalHuman());
  const ctx = { configs: { avatar: { prompt: '保留这段口播文案' } }, storeInfo: {}, esc: value => String(value ?? ''), icon: () => '',
    button: (action, label, className, attrs = '') => `<button data-action="${action}" class="${className}" ${attrs}>${label}</button>`,
    toast: text => notices.push(text) };
  const root = document.querySelector('.avatar-studio');
  root.innerHTML = mod.renderDigitalHuman(ctx);
  mod.bindDigitalHuman(ctx);
  await settle();
  return { root, uploads, notices, create, storage,
    zone: () => root.querySelector('#dh-materials [data-dh-drop="avatar"]'),
    event(type, target, fields = {}) {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { dataTransfer: { types: ['Files'], files: [], dropEffect: 'none' }, ...fields });
      target.dispatchEvent(event);
      return event;
    },
  };
}

const video = () => new File(['video'], '原始口播.mp4', { type: 'video/mp4' });
const transfer = (...files) => ({ types: ['Files'], files, dropEffect: 'none' });

test('video drop targets show feedback, retain it across children, and ignore text drags', async t => {
  const ui = await page(t), zone = ui.zone(), child = zone.querySelector('span');
  assert.match(zone.textContent, /点击或拖拽上传视频/);
  const enter = ui.event('dragenter', child);
  assert.equal(enter.defaultPrevented, true);
  assert.equal(enter.dataTransfer.dropEffect, 'copy');
  assert.equal(zone.classList.contains('is-dragover'), true);
  ui.event('dragleave', child, { relatedTarget: zone.querySelector('input') });
  assert.equal(zone.classList.contains('is-dragover'), true);
  ui.event('dragleave', zone, { relatedTarget: ui.root });
  assert.equal(zone.classList.contains('is-dragover'), false);
  const text = ui.event('dragover', zone, { dataTransfer: { types: ['text/plain'] } });
  assert.equal(text.defaultPrevented, false);
  assert.equal(zone.classList.contains('is-dragover'), false);
});

test('dropping a video uploads it once and selects it without changing the script', async t => {
  const ui = await page(t), file = video(), zone = ui.zone();
  ui.event('dragover', zone);
  const drop = ui.event('drop', zone.querySelector('input'), { dataTransfer: transfer(file) });
  assert.equal(drop.defaultPrevented, true);
  assert.equal(zone.classList.contains('is-dragover'), false);
  await settle();
  assert.deepEqual(ui.uploads, [file]);
  assert.match(ui.root.querySelector('#dh-materials').textContent, /原始口播/);
  const saved = JSON.parse(ui.storage.get('store-studio:digital-human:v1'));
  assert.equal(saved.avatarId, 'uploaded');
  assert.equal(saved.script, '保留这段口播文案');
});

test('dropping invalid, empty, or oversized videos uses the existing validation', async t => {
  const ui = await page(t), oversized = video();
  Object.defineProperty(oversized, 'size', { value: 501 * 1024 * 1024 });
  const files = [new File(['image'], '照片.png', { type: 'image/png' }), new File([], '空.mp4', { type: 'video/mp4' }), oversized];
  for (const file of files) ui.event('drop', ui.zone(), { dataTransfer: transfer(file) });
  assert.equal(ui.uploads.length, 0);
  assert.match(ui.notices[0], /请选择口播视频文件/);
  assert.match(ui.notices[1], /大于 0 且不超过 500 MB/);
  assert.match(ui.notices[2], /大于 0 且不超过 500 MB/);
});

test('uploads block duplicate drops and file drops outside upload targets cannot open the file', async t => {
  const ui = await page(t), file = video();
  let complete;
  ui.create.mock.mockImplementationOnce(() => {
    ui.uploads.push(file);
    return new Promise(resolve => { complete = () => resolve({ id: 'uploaded', name: '原始口播' }); });
  });
  ui.event('drop', ui.zone(), { dataTransfer: transfer(file) });
  const over = ui.event('dragover', ui.zone());
  assert.equal(over.dataTransfer.dropEffect, 'none');
  assert.equal(ui.zone().classList.contains('is-dragover'), false);
  ui.event('drop', ui.zone(), { dataTransfer: transfer(file) });
  const outside = ui.event('drop', ui.root, { dataTransfer: transfer(file) });
  assert.equal(outside.defaultPrevented, true);
  assert.equal(ui.uploads.length, 1);
  complete();
  await settle();
});

test('file picker changes still upload and reset the picker', async t => {
  const ui = await page(t), file = video(), input = ui.zone().querySelector('input');
  Object.defineProperty(input, 'files', { value: [file] });
  input.value = '原始口播.mp4';
  ui.event('change', input);
  assert.equal(input.value, '');
  await settle();
  assert.deepEqual(ui.uploads, [file]);
});
