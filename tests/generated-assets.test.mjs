import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { collectGeneratedAssets, generatedAssetWindow, renderGeneratedAssets, bindGeneratedAssets, disposeGeneratedAssets, collectMaterialAssets, materialDestinations, handleGeneratedAssetsAction } from '../design/generated-assets.js';
import { renderVideoReplica, bindVideoReplica, disposeVideoReplica } from '../design/video-replica.js';

const now = Date.parse('2026-09-30T06:00:00Z');
const hour = 3600000;
const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const material = kind => ({ id: `${kind}-${'a'.repeat(64)}`, kind, type: kind === 'photo' ? 'image' : 'audio', name: '我的素材',
  filename: kind === 'photo' ? '我的素材.jpg' : '我的素材.wav', permanent: true, createdAt: now - 365 * 24 * hour, url: `/api/assets/materials/${kind}-${'a'.repeat(64)}/media` });

test('permanent assets survive the generated-output window and offer only compatible destinations', () => {
  assert.equal(collectMaterialAssets([material('photo'), material('voice')]).length, 2);
  assert.deepEqual(collectMaterialAssets([{ ...material('photo'), url: 'https://other.example/photo.jpg' }, { ...material('voice'), id: '../private' }]), []);
  assert.deepEqual(materialDestinations('photo').map(([target]) => target), ['replica', 'image', 'video']);
  assert.deepEqual(materialDestinations('voice').map(([target]) => target), ['replica', 'avatar', 'video']);
});

test('assets preview routes a stored photo into AI image references without submitting generation', async t => {
  const previous = { document: globalThis.document, fetch: globalThis.fetch }, nodes = new Map(), item = material('photo');
  const node = selector => { if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '' }); return nodes.get(selector); };
  globalThis.document = { body: { dataset: { page: 'assets' } }, querySelector: node };
  const calls = [];
  globalThis.fetch = async (path, options) => {
    calls.push([path, options]);
    if (path === item.url) return new Response('image', { headers: { 'Content-Type': 'image/jpeg' } });
    return Response.json(path === '/api/assets/materials' ? { configured: true, materials: [item, material('voice')] } : { tasks: [] });
  };
  t.after(() => { disposeGeneratedAssets(); Object.assign(globalThis, previous); });
  let modal, imported, destination;
  const ctx = { mode: 'assets', configs: { image: { files: ['existing'] } }, esc: value => String(value ?? ''), icon: () => '',
    button: (action, text, cls, attributes) => `<button data-action="${action}" ${attributes || ''}>${text}</button>`,
    openModal: (_title, _description, content) => { modal = content; }, toast: message => assert.fail(message),
    importBusinessAssets(files, target, selected) { imported = { files, target, selected }; return ['new-image']; },
    setImageMode: value => assert.equal(value, 'generic'), navigate: target => { destination = target; document.body.dataset.page = target; },
  };
  bindGeneratedAssets(ctx);
  for (let n = 0; n < 50 && !node('#material-assets-results').innerHTML.includes('使用到'); n++) await new Promise(resolve => setImmediate(resolve));
  assert.match(node('#material-assets-results').innerHTML, /长期保留/);
  handleGeneratedAssetsAction('material-preview', { dataset: { id: item.id } }, ctx);
  assert.match(modal, /AI 图片 · 参考图片/); assert.doesNotMatch(modal, /数字人/);
  const button = { dataset: { id: item.id, target: 'image' }, disabled: false };
  handleGeneratedAssetsAction('material-use', button, ctx);
  for (let n = 0; n < 50 && !destination; n++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(destination, 'image'); assert.equal(imported.target, 'image'); assert.equal(imported.selected, 1);
  assert.equal(imported.files[0].name, item.filename); assert.equal(imported.files[0].type, 'image/jpeg');
  assert.deepEqual(ctx.configs.image.files, ['existing', 'new-image']);
  assert.ok(calls.every(([, options]) => !options.method || options.method === 'GET'));
});

for (const mode of ['classic', 'deep']) for (const kind of ['photo', 'voice']) for (const clickTarget of ['cover', 'button']) test(`selecting a ${kind} from the ${mode} replica asset ${clickTarget} returns it directly and preserves other inputs`, async t => {
  const previous = { document: globalThis.document, fetch: globalThis.fetch, workspaceUser: globalThis.workspaceUser };
  const nodes = new Map(), item = material(kind), calls = [];
  const node = selector => { if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '' }); return nodes.get(selector); };
  globalThis.workspaceUser = { id: crypto.randomUUID() };
  globalThis.document = { body: { dataset: { page: 'replica' } }, querySelector: node };
  globalThis.fetch = async (path, options) => {
    calls.push([path, options]);
    return Response.json(path === '/api/assets/materials' ? { configured: true, materials: [material('photo'), material('voice')] }
      : path.endsWith('/config') ? { enabled: true } : { tasks: [] });
  };
  t.after(() => { disposeGeneratedAssets(); disposeVideoReplica(); Object.assign(globalThis, previous); });
  let html, modalCount = 0;
  const ctx = { mode: 'replica', esc: value => String(value ?? ''), icon: () => '',
    button: (action, text, cls, attributes) => `<button data-action="${action}" ${attributes || ''}>${text}</button>`,
    openModal: () => { modalCount++; }, toast: message => assert.fail(message),
    refresh() {
      html = ctx.mode === 'replica' ? renderVideoReplica(ctx) : renderGeneratedAssets(ctx);
    },
    navigate(target) {
      if (target !== 'replica') disposeVideoReplica();
      if (target !== 'assets') disposeGeneratedAssets();
      ctx.mode = target; document.body.dataset.page = target; ctx.refresh();
      if (target === 'replica') bindVideoReplica(ctx); else bindGeneratedAssets(ctx);
    },
  };
  const settle = async () => { for (let n = 0; n < 10; n++) await new Promise(resolve => setImmediate(resolve)); };
  ctx.refresh(); bindVideoReplica(ctx); await settle();
  if (mode === 'deep') {
    node('#replica-mode-deep').onclick(); bindVideoReplica(ctx);
    for (const selectedKind of ['photo', 'voice']) node(`#replica-toggle-${selectedKind}`).onchange({ target: { checked: true } });
    bindVideoReplica(ctx); await settle();
  }
  node('#replica-video').onchange({ target: { files: [new File(['video'], 'original.mp4', { type: 'video/mp4' })] } });
  const other = kind === 'photo' ? 'voice' : 'photo', otherName = other === 'photo' ? 'keep-photo.jpg' : 'keep-voice.wav';
  node(`#replica-${other}`).onchange({ target: { files: [new File(['data'], otherName, { type: other === 'photo' ? 'image/jpeg' : 'audio/wav' })] } });
  const replica = parseHTML(html).document;
  const entry = replica.querySelector(`[data-replica-select-${kind}]`);
  assert.ok(entry, `the ${kind} entry must carry the replica selection intent`);
  assert.equal(entry.textContent, kind === 'photo' ? '从资产选择形象' : '从资产选择声音');
  let prevented = false;
  node(`[data-replica-select-${kind}]`).onclick({ preventDefault() { prevented = true; } });
  assert.ok(prevented); await settle();
  assert.equal(ctx.mode, 'assets');
  const picker = parseHTML(node('#material-assets-results').innerHTML).document;
  assert.equal(picker.querySelectorAll('.generated-asset-card').length, 1, 'only the requested material kind belongs in the picker');
  assert.match(node('#material-assets-results').innerHTML, new RegExp(kind === 'photo' ? '选择此形象' : '选择此声音'));
  assert.doesNotMatch(node('#material-assets-results').innerHTML, /使用到/);
  const cover = picker.querySelector('.generated-asset-cover'), choose = picker.querySelector('.generated-asset-footer button');
  for (const element of [cover, choose]) {
    assert.equal(element.dataset.action, 'material-use'); assert.equal(element.dataset.target, 'replica');
    assert.equal(element.dataset.id, item.id);
  }
  const clicked = clickTarget === 'cover' ? cover : choose;
  handleGeneratedAssetsAction(clicked.dataset.action, clicked, ctx); await settle();
  assert.equal(ctx.mode, 'replica'); assert.equal(modalCount, 0);
  assert.match(html, /我的素材/); assert.match(html, /original\.mp4/);
  assert.ok(html.includes(otherName), 'the other selected material must be preserved');
  assert.match(html, new RegExp(item.url));
  assert.ok(calls.every(([, options]) => !options?.method || options.method === 'GET'));

  node(`[data-replica-select-${other}]`).onclick({ preventDefault() {} }); await settle();
  const nextPicker = parseHTML(node('#material-assets-results').innerHTML).document;
  const nextChoose = nextPicker.querySelector('.generated-asset-footer button');
  assert.equal(nextChoose.dataset.id, material(other).id, 'switching entry must select the other material kind');
  handleGeneratedAssetsAction(nextChoose.dataset.action, nextChoose, ctx); await settle();
  assert.equal(ctx.mode, 'replica'); assert.equal(modalCount, 0);
  assert.match(html, /original\.mp4/);
  for (const selected of [item, material(other)]) assert.ok(html.includes(selected.url), 'both chosen assets must remain in the replica');

  ctx.navigate('assets'); await settle();
  const library = parseHTML(node('#material-assets-results').innerHTML).document;
  assert.equal(library.querySelectorAll('.generated-asset-card').length, 2, 'normal assets navigation clears the selection filter');
  handleGeneratedAssetsAction('material-preview', { dataset: { id: item.id } }, ctx);
  assert.equal(modalCount, 1, 'opening assets normally still offers destination choices');
});
const image = (overrides = {}) => ({ id, status: 'completed', createdAt: new Date(now - 74 * hour).toISOString(), completedAt: new Date(now - hour).toISOString(), images: [{ url: `/api/ai/media/${id}/result-1.png`, filename: 'result-1.png' }], prompt: '设计宣传海报\n主标题：真实工艺，看细节\n要点：打样流程', ...overrides });
const restaurant = (overrides = {}) => ({ id, status: 'completed', completedAt: now - hour, copy: { titles: ['附近午餐来吃一碗面'] }, files: [{ role: 'image', filename: '01.jpg', url: `/api/restaurant/tasks/${id}/files/01.jpg`, expiresAt: now + 2 * hour }, { role: 'zip', filename: 'package.zip', url: `/api/restaurant/tasks/${id}/files/package.zip`, expiresAt: now + 2 * hour }], sourceImages: [{ filename: 'original-1.jpg', url: `/api/restaurant/tasks/${id}/files/original-1.jpg` }], ...overrides });

test('all fifteen generated pictures enter assets while out-of-range names and originals remain excluded', () => {
  const images = Array.from({ length: 16 }, (_, index) => ({ url: `/api/ai/media/${id}/result-${index + 1}.png`, filename: `result-${index + 1}.png` }));
  images.push({ url: `/api/ai/media/${id}/source-01.jpg`, filename: 'source-01.jpg' });
  assert.equal(collectGeneratedAssets([image({ images })], [], now).length, 15);
  const files = Array.from({ length: 16 }, (_, index) => { const filename = `${String(index + 1).padStart(2, '0')}.jpg`; return { role: 'image', filename, url: `/api/restaurant/tasks/${id}/files/${filename}`, expiresAt: now + hour }; });
  const records = collectGeneratedAssets([], [], now, [restaurant({ files })]);
  assert.equal(records.length, 15); assert.ok(records.some(item => item.filename === '15.jpg'));
  assert.ok(!records.some(item => item.filename === '16.jpg'));
});

test('asset retention starts when generation completes and ends exactly at 72 hours', () => {
  assert.ok(generatedAssetWindow(image(), now));
  assert.equal(generatedAssetWindow(image({ completedAt: now - 72 * hour }), now), null);
  assert.ok(generatedAssetWindow(image({ completedAt: now - 72 * hour + 1 }), now));
  assert.equal(generatedAssetWindow(image({ completedAt: now + 1 }), now), null);
  assert.equal(generatedAssetWindow(image({ completedAt: 'invalid' }), now), null);
  assert.equal(generatedAssetWindow(image({ expiresAt: now }), now), null);
  assert.equal(generatedAssetWindow(image({ completedAt: now - 73 * hour, expiresAt: now + hour }), now), null);
});

test('only completed generated images enter assets, excluding original uploads, examples and expired results', () => {
  const records = collectGeneratedAssets([
    image(), image({ status: 'running' }), image({ status: 'failed' }), image({ status: 'expired' }),
    image({ completedAt: now - 73 * hour }),
    image({ images: [{ url: '/media/ai-industrial-poster.png' }, { url: 'blob:original' }, { url: 'https://outside.example/result.png' }] }),
    image({ images: [{ url: '/api/ai/media/another/result-1.png' }] }),
  ], [], now);
  assert.equal(records.length, 1);
  assert.equal(records[0].title, '真实工艺，看细节');
  assert.equal(records[0].type, 'image');
  assert.equal(records[0].download, `/api/ai/media/${id}/result-1.png?download=1`);
});

test('digital assets include only settled final video and generated voice, never source media', () => {
  const task = { id: 'avatar-task', status: 'completed', createdAt: now - 2 * hour, completedAt: now - hour, inputs: { scriptText: '介绍真实加工过程' }, results: { finalVideoUrl: '/api/tasks/avatar-task/media/final', exactAudioUrl: '/api/tasks/avatar-task/media/voice', originalVideoUrl: '/api/tasks/avatar-task/media/original', audioFormat: 'mp3' } };
  const records = collectGeneratedAssets([], [task], now);
  assert.deepEqual(records.map(item => item.type), ['video', 'audio']);
  assert.equal(records[0].download, '/api/tasks/avatar-task/download/final.mp4');
  assert.equal(records[1].download, '/api/tasks/avatar-task/download/voice-track.mp3');
  const labeled = collectGeneratedAssets([], [{ ...task, inputs: { ...task.inputs, engine: 'b' }, results: { ...task.results, engine: 'e' } }], now);
  assert.equal(labeled[0].modelLabel, 'qy-至臻');
  assert.equal(labeled[1].modelLabel, undefined, 'the lipsync model is not a voice model');
  assert.equal(collectGeneratedAssets([], [{ ...task, inputs: { engine: 'b' }, results: { ...task.results, engine: null } }], now)[0].modelLabel, '未记录');
  assert.equal(collectGeneratedAssets([], [{ ...task, results: { ...task.results, engine: 'e', deliveryMode: 'narration_fallback' } }], now)[0].modelLabel, '基础配音（未对口型）');
  for (const source of ['https://outside.example/result.mp4', '//outside.example/result.mp4', '/api/tasks/other/media/final']) {
    assert.equal(collectGeneratedAssets([], [{ ...task, results: { finalVideoUrl: source } }], now).length, 0);
  }
  assert.equal(collectGeneratedAssets([], [{ ...task, billing: { isExternalUser: true, status: 'pending' } }], now).length, 0);
  assert.equal(collectGeneratedAssets([], [{ ...task, expired: true }], now).length, 0);
});

test('server expiry caps lifetime and mixed outputs are sorted by completion rather than submission', () => {
  const records = collectGeneratedAssets([image({ expiresAt: now + 2 * hour }), image({ id: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee', completedAt: now - 2 * hour, images: [{ url: '/api/ai/media/bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee/result-1.png' }] })], [], now);
  assert.equal(records[0].expires, now + 2 * hour);
  assert.ok(records[0].completed > records[1].completed);
  assert.equal(collectGeneratedAssets([image(), image()], [], now).length, 1);
});

test('restaurant assets include only completed unexpired processed photos, never originals or ZIP files', () => {
  const records = collectGeneratedAssets([], [], now, [restaurant(), restaurant({ status: 'awaiting_confirmation' }), restaurant({ status: 'failed' }), restaurant({ filesExpired: true }), restaurant({ review: { status: 'blocked' } }), restaurant({ completedAt: now - 73 * hour })]);
  assert.equal(records.length, 1);
  assert.equal(records[0].source, '餐饮小红书');
  assert.equal(records[0].title, '附近午餐来吃一碗面');
  assert.equal(records[0].download, `/api/restaurant/tasks/${id}/files/01.jpg`);
  assert.equal(records[0].expires, now + 2 * hour);
  assert.equal(records[0].filename, '01.jpg');
  assert.equal(collectGeneratedAssets([], [], now, [restaurant(), restaurant()]).length, 1);
});

test('restaurant file expiry and task identity are independently enforced at the three-day boundary', () => {
  const good = restaurant().files[0];
  const badFiles = [
    { ...good, expired: true }, { ...good, expiresAt: now }, { ...good, expiresAt: 'invalid' },
    { ...good, role: 'original' }, { ...good, filename: 'original-1.jpg', url: `/api/restaurant/tasks/${id}/files/original-1.jpg` },
    { ...good, url: 'https://outside.example' + good.url }, { ...good, url: '//outside.example' + good.url },
    { ...good, url: good.url + '?download=1' }, { ...good, url: good.url + '#x' },
    { ...good, url: '/api/restaurant/tasks/aaaaaaaa-bbbb-cccc-dddd-ffffffffffff/files/01.jpg' },
    { ...good, filename: '02.jpg' }, { ...good, url: good.url.replace('files/', 'files/../files/') },
  ];
  for (const file of badFiles) assert.equal(collectGeneratedAssets([], [], now, [restaurant({ files: [file] })]).length, 0);
  assert.equal(collectGeneratedAssets([], [], now, [restaurant({ completedAt: now - 72 * hour, files: [{ ...good, expiresAt: now + hour }] })]).length, 0);
  const capped = collectGeneratedAssets([], [], now, [restaurant({ completedAt: now - 71 * hour, files: [{ ...good, expiresAt: now + 10 * hour }] })]);
  assert.equal(capped[0].expires, now + hour);
});

test('asset loading paginates restaurant metadata without paid calls and keeps existing source error handling', async () => {
  const original = Object.fromEntries(['document', 'fetch'].map(key => [key, globalThis[key]]));
  let markup = '';
  const calls = [];
  const host = { set innerHTML(value) { markup = value; } };
  globalThis.document = { body: { dataset: { page: 'assets' } }, querySelector: selector => selector === '#generated-assets-results' ? host : null };
  const current = Date.now();
  const pageTask = (taskId, title) => restaurant({ id: taskId, completedAt: current - 1000, copy: { titles: [title] }, files: [{ role: 'image', filename: '01.jpg', url: `/api/restaurant/tasks/${taskId}/files/01.jpg`, expiresAt: current + hour }] });
  globalThis.fetch = async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET' });
    if (path.startsWith('/api/ai/images')) return Response.json({ tasks: [image({ completedAt: current - 2000, expiresAt: current + hour })] });
    if (path.startsWith('/api/tasks?')) return Response.json({}, { status: 503 });
    if (path.startsWith('/api/restaurant/tasks?')) {
      const query = new URL(path, 'http://localhost').searchParams;
      assert.equal(query.get('limit'), '50'); assert.equal(query.get('completed'), 'true');
      assert.ok(Number(query.get('completedAfter')) <= current);
      if (!query.get('cursor')) return Response.json({ tasks: [pageTask(id, '餐饮第一页')], nextCursor: 'older-cursor' });
      assert.equal(query.get('cursor'), 'older-cursor');
      return Response.json({ tasks: [pageTask('aaaaaaaa-bbbb-cccc-dddd-ffffffffffff', '餐饮第二页')], nextCursor: null });
    }
    throw new Error('Unexpected request');
  };
  const ctx = { mode: 'assets', esc: value => String(value), icon: () => '', button: (action, label) => `<button data-action="${action}">${label}</button>` };
  try {
    bindGeneratedAssets(ctx);
    for (let count = 0; count < 50 && !markup.includes('餐饮第二页'); count++) await new Promise(resolve => setImmediate(resolve));
    assert.match(markup, /餐饮第一页/); assert.match(markup, /餐饮第二页/);
    assert.match(markup, /真实工艺，看细节/);
    assert.match(markup, /数字人作品暂时无法加载/);
    assert.equal(calls.filter(call => call.path.startsWith('/api/restaurant/')).length, 2);
    assert.ok(calls.every(call => call.method === 'GET'));
    assert.ok(!calls.some(call => /generate|\/status|\/profile|\/usage/.test(call.path)));
    assert.ok(!markup.includes(`/api/restaurant/tasks/${id}/files/01.jpg?download=1`));
  } finally {
    disposeGeneratedAssets();
    for (const [key, value] of Object.entries(original)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
});

test('the assets entry presents retention and generated type filters without an upload flow', () => {
  const ctx = { esc: value => String(value), icon: () => '', button: (action, label) => `<button data-action="${action}">${label}</button>` };
  const html = renderGeneratedAssets(ctx);
  assert.match(html, /保留 <strong>3 天<\/strong>，请及时下载/);
  assert.match(html, /及时下载/);
  assert.match(html, /成品类型/);
  assert.doesNotMatch(html, /type="file"|确认选择|本地上传/);
});
test('image assets use the same business title or generation-mode fallback as the work page', () => {
  assert.equal(collectGeneratedAssets([image({ prompt: '设计3:4工厂海报\n主标题：真实样件，看细节' })], [], now)[0].title, '真实样件，看细节');
  assert.equal(collectGeneratedAssets([image({ prompt: '内部排版与制作约束', generationMode: 'series' })], [], now)[0].title, '统一风格套图');
});
