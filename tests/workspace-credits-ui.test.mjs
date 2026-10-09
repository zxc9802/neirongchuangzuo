import test from 'node:test';
import assert from 'node:assert/strict';
import * as credits from '../design/workspace-credits.js';
import { renderImageGenerationOptions } from '../design/image-generation.js';
import { renderDigitalHuman } from '../design/digital-human.js';

const balance = (available = 1000, held = 0, pricing = {}) => ({ initialPoints: 1000, available, balance: available, held, total: available + held, pricing: { initialPoints: 1000, imagePerUnit: 50, videoPoints: 333, videoSeconds: 30, version: '2026-10-08', ...pricing } });
const freshModule = () => import(`../design/workspace-credits.js?credits-test-${crypto.randomUUID()}`);
function workspace(t, fetch) {
  const saved = Object.fromEntries(['workspaceUser', 'fetch'].map(key => [key, globalThis[key]]));
  globalThis.workspaceUser = { id: crypto.randomUUID() };
  globalThis.fetch = fetch;
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; });
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('a shared 1000-point wallet supports twenty images or three 30-second videos with exact per-second rounding', () => {
  const snapshot = credits.normalizeCredits(balance());
  assert.equal(credits.imagePoints(20, snapshot), 1000);
  assert.equal(credits.imagePoints(6, snapshot), 300);
  assert.equal(credits.videoPoints(30, snapshot), 333);
  assert.equal(credits.videoPoints(60, snapshot), 666);
  assert.equal(credits.videoPoints(90, snapshot), 999);
  assert.equal(credits.videoPoints(31, snapshot), 345);
  assert.equal(credits.videoPoints(30.01, snapshot), 334);
  assert.equal(credits.videoPoints(0, snapshot), null);
  assert.equal(credits.imagePoints(-1, snapshot), null);
});

test('estimates use server prices and spendable balance while held points cannot fund another task', () => {
  const snapshot = credits.normalizeCredits(balance(100, 400, { imagePerUnit: 75, videoPoints: 300 }));
  assert.equal(credits.imagePoints(2, snapshot), 150);
  assert.equal(credits.videoPoints(30, snapshot), 300);
  assert.match(credits.creditInsufficiency(150, { snapshot, stale: false }), /需要 150 积分，可用 100 积分/);
  assert.equal(credits.creditInsufficiency(100, { snapshot, stale: false }), '');
  assert.equal(credits.creditInsufficiency(150, { snapshot, stale: true }), '');
});

test('only the server boolean grants unlimited points and removes insufficient balance checks', () => {
  const snapshot = credits.normalizeCredits({ ...balance(0), unlimited: true });
  assert.equal(snapshot.unlimited, true);
  assert.equal(credits.creditInsufficiency(1000000, { snapshot, stale: false }), '');
  for (const unlimited of [undefined, false, 'true', 1]) {
    const finite = credits.normalizeCredits({ ...balance(0), unlimited });
    assert.equal(finite.unlimited, false);
    assert.match(credits.creditInsufficiency(50, { snapshot: finite, stale: false }), /积分不足/);
  }
});

test('an account name or browser user flag cannot grant unlimited points', async t => {
  workspace(t, async () => Response.json(balance(0)));
  globalThis.workspaceUser = { id: crypto.randomUUID(), account: 'zxc9911', unlimited: true };
  const module = await freshModule();
  await module.refreshWorkspaceCredits();
  assert.equal(module.workspaceCreditsState().snapshot.unlimited, false);
  assert.match(module.creditInsufficiency(module.imagePoints(1)), /积分不足/);
  assert.equal(module.creditEstimateText(module.imagePoints(1)), '预计 50 积分');
});

test('incomplete, negative and fractional account balances never turn into a default balance', () => {
  assert.equal(credits.normalizeCredits({}), null);
  assert.equal(credits.normalizeCredits({ ...balance(), available: -1 }), null);
  assert.equal(credits.normalizeCredits({ ...balance(), available: 3.5 }), null);
  assert.equal(credits.normalizeCredits({ ...balance(), pricing: { imagePerUnit: 50 } }), null);
  assert.equal(credits.normalizeCredits({ credits: balance(0) }).available, 0);
});

test('failed credit lookup exposes an unknown state and never grants or invents 1000 points', async t => {
  workspace(t, async () => new Response('', { status: 503 }));
  const module = await freshModule();
  assert.equal(await module.refreshWorkspaceCredits(), null);
  assert.equal(module.workspaceCreditsState().snapshot, null);
  assert.equal(module.workspaceCreditsState().stale, true);
  assert.match(module.creditEstimateText(module.imagePoints(6)), /暂时无法读取/);
});

test('a failed refresh retains only a marked stale snapshot instead of displaying a new zero balance', async t => {
  let successful = true;
  workspace(t, async () => successful ? Response.json(balance(250, 300)) : new Response('', { status: 500 }));
  const module = await freshModule();
  await module.refreshWorkspaceCredits(); successful = false;
  await module.refreshWorkspaceCredits();
  assert.equal(module.workspaceCreditsState().snapshot.available, 250);
  assert.equal(module.workspaceCreditsState().stale, true);
  assert.match(module.creditEstimateText(module.imagePoints(6)), /余额待刷新/);
  assert.equal(module.creditInsufficiency(300), '');
});

test('an account handoff discards the previous account response and restores only the new server wallet', async t => {
  let resolveFirst, calls = 0;
  workspace(t, () => ++calls === 1 ? new Promise(resolve => { resolveFirst = resolve; }) : Promise.resolve(Response.json(balance(700))));
  const module = await freshModule();
  const oldRequest = module.refreshWorkspaceCredits(); await tick();
  globalThis.workspaceUser = { id: crypto.randomUUID() };
  await module.refreshWorkspaceCredits();
  resolveFirst(Response.json(balance(10))); await oldRequest;
  assert.equal(module.workspaceCreditsState().snapshot.available, 700);
  assert.equal(module.workspaceCreditsState().stale, false);
});

test('a task settlement during an existing balance lookup queues one authoritative follow-up and stable polls do not repeat it', async t => {
  let resolveFirst, calls = 0;
  workspace(t, () => ++calls === 1 ? new Promise(resolve => { resolveFirst = resolve; }) : Promise.resolve(Response.json(balance(500))));
  const module = await freshModule();
  const first = module.refreshWorkspaceCredits(); await tick();
  module.observeCreditTask({ id: 'image-task', status: 'completed', billing: { chargedPoints: 500 } });
  resolveFirst(Response.json(balance(1000))); await first; await tick(); await tick();
  assert.equal(calls, 2);
  assert.equal(module.workspaceCreditsState().snapshot.available, 500);
  module.observeCreditTask({ id: 'image-task', status: 'completed', billing: { chargedPoints: 500 } });
  await tick(); assert.equal(calls, 2);
});

test('a synchronous network failure releases the request slot and can be retried', async t => {
  let fail = true;
  workspace(t, () => { if (fail) throw new Error('连接断开'); return Response.json(balance(300)); });
  const module = await freshModule();
  await module.refreshWorkspaceCredits(); fail = false;
  await module.refreshWorkspaceCredits();
  assert.equal(module.workspaceCreditsState().snapshot.available, 300);
});

test('billing receipts use actual server settlement including partial success and failure releases', () => {
  assert.equal(credits.billingPointsText({ status: 'completed', partial: true, billing: { reservedPoints: 300, chargedPoints: 50 } }), '已使用 50 积分');
  assert.equal(credits.billingPointsText({ status: 'failed', billing: { chargedPoints: 0, reservedPoints: 300 } }), '未扣积分');
  assert.equal(credits.billingPointsText({ status: 'running', billing: { reservedPoints: 300 } }), '已冻结 300 积分');
  assert.equal(credits.billingPointsText({ status: 'completed' }), '');
  for (const status of ['running', 'completed', 'failed']) {
    assert.equal(credits.billingPointsText({ status, billing: { exempt: true, status: 'released', reservedPoints: 0, chargedPoints: 0 } }), '');
  }
  assert.equal(credits.billingPointsText({ status: 'completed', billing: { exempt: false, reservedPoints: 300, chargedPoints: 50 } }), '已使用 50 积分');
});

const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const button = (action, label, className, extra = '') => `<button data-action="${action}" class="${className}" ${extra}>${label}</button>`;

test('generic image controls quote one, six or fifteen outputs from the authenticated server wallet', async t => {
  workspace(t, async () => Response.json(balance()));
  await credits.refreshWorkspaceCredits();
  const ctx = { esc, button, configs: { image: { generationMode: 'series', count: '6' } } };
  assert.match(renderImageGenerationOptions(ctx), /预计 300 积分/);
  ctx.configs.image.count = '15'; assert.match(renderImageGenerationOptions(ctx), /预计 750 积分/);
  ctx.configs.image.generationMode = 'single'; assert.match(renderImageGenerationOptions(ctx), /预计 50 积分/);
});

test('unlimited image and video estimates show no charge while unavailable services remain disabled', async t => {
  workspace(t, async () => Response.json({ ...balance(0), unlimited: true }));
  const saved = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  t.after(() => { if (saved === undefined) delete globalThis.localStorage; else globalThis.localStorage = saved; });
  await credits.refreshWorkspaceCredits();
  const image = renderImageGenerationOptions({ esc, button, configs: { image: { generationMode: 'series', count: '15' } } });
  assert.match(image, /无限积分/);
  assert.doesNotMatch(image, /预计 \d+ 积分/);
  const video = renderDigitalHuman({ esc, button, icon: () => '', storeInfo: {}, configs: { avatar: { prompt: '真'.repeat(120) } } });
  assert.match(video, /约 30 秒 · 无限积分/);
  assert.doesNotMatch(video, /预计 \d+ 积分|按实际时长/);
  assert.match(video, /data-action="dh-generate"[^>]*disabled/);
  assert.equal(credits.videoCreditEstimateText(null), '无限积分');
});

test('account balance and pricing labels follow the server unlimited flag and preserve stale lookup state', async t => {
  workspace(t, async () => new Response('', { status: 401 }));
  const saved = Object.fromEntries(['document', 'location'].map(key => [key, globalThis[key]]));
  const strong = {}, small = {};
  const nodes = {
    '#workspace-credits': { querySelector: selector => selector === 'strong' ? strong : small },
    '#account-credit-summary': {}, '#account-credit-rules': {}, '#account-credit-error': {},
  };
  globalThis.document = { querySelector: selector => nodes[selector] };
  globalThis.location = { pathname: '/', search: '', hash: '', replace() {} };
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; });
  const { paintCredits } = await import(`../design/workspace-account.js?wallet-labels-${crypto.randomUUID()}`);
  const snapshot = credits.normalizeCredits({ ...balance(0, 50), unlimited: true });
  paintCredits({ snapshot, stale: false, error: '' });
  assert.equal(strong.textContent, '∞');
  assert.equal(small.textContent, '无限积分');
  assert.equal(nodes['#account-credit-summary'].textContent, '无限积分');
  assert.equal(nodes['#account-credit-rules'].textContent, '');
  paintCredits({ snapshot, stale: true, error: '连接中断' });
  assert.match(nodes['#account-credit-summary'].textContent, /无限积分.*待刷新/);
  assert.equal(nodes['#account-credit-error'].textContent, '连接中断');
  paintCredits({ snapshot: credits.normalizeCredits(balance(0, 50)), stale: false, error: '' });
  assert.equal(strong.textContent, '0');
  assert.equal(small.textContent, '可用积分');
  assert.match(nodes['#account-credit-summary'].textContent, /可用 0 积分 · 冻结 50 积分/);
  assert.match(nodes['#account-credit-rules'].textContent, /图片 50 积分\/张/);
});

test('digital-human estimates quote a 30-second script and show actual-duration settlement without claiming an unavailable service is ready', async t => {
  workspace(t, async () => Response.json(balance()));
  const saved = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  t.after(() => { if (saved === undefined) delete globalThis.localStorage; else globalThis.localStorage = saved; });
  await credits.refreshWorkspaceCredits();
  const html = renderDigitalHuman({ esc, button, icon: () => '', storeInfo: {}, configs: { avatar: { prompt: '真'.repeat(120) } } });
  assert.match(html, /约 30 秒 · 预计 333 积分 · 按实际时长/);
  assert.match(html, /data-action="dh-generate"[^>]*disabled/);
  assert.doesNotMatch(html, /20.*积分.*秒/);
});

test('speech previews use the selected playback speed and leave an empty script unpriced', () => {
  assert.equal(credits.estimatedSpeechSeconds('字'.repeat(120)), 30);
  assert.equal(credits.estimatedSpeechSeconds('字'.repeat(120), 1.2), 25);
  assert.equal(credits.estimatedSpeechSeconds('   '), null);
});

async function restaurantView(t, { available = 1000, unlimited = false, photos = 12, count = 9, taskOverrides = {} } = {}) {
  const taskId = crypto.randomUUID();
  const saved = Object.fromEntries(['document', 'sessionStorage', 'location', 'matchMedia'].map(key => [key, globalThis[key]]));
  const usable = Array.from({ length: photos }, (_, index) => ({ imageId: `photo-${index + 1}`, usable: true, imageType: 'food', privacyRisk: 'none', textRisk: 'none', qualityScore: 80 }));
  // The two unusable images are present in the upload but cannot increase the cost estimate.
  const analysis = [...usable, { imageId: 'unusable-1', usable: false }, { imageId: 'unusable-2', usable: false }];
  const task = { id: taskId, status: 'awaiting_selection', createdAt: Date.now(), outputCount: count,
    analysis, directions: [{ id: 'meal', label: '真实午餐', supportingImageIds: usable.map(item => item.imageId), missingFacts: [] }],
    sourceImages: analysis.map(item => ({ id: item.imageId, expiresAt: Date.now() + 60000, url: `/api/restaurant/tasks/${taskId}/files/${item.imageId}.jpg` })), ...taskOverrides };
  let markup = '', countListener;
  const control = { disabled: false, innerHTML: '', title: '' };
  const estimate = { set outerHTML(value) { markup = markup.replace(/<p id="restaurant-credit-estimate"[\s\S]*?<\/p>/, value); } };
  const root = { contains: () => false, querySelector: selector => selector === '#restaurant-output-count' ? { addEventListener(event, handler) { countListener = handler; } } : null,
    querySelectorAll: () => [], set outerHTML(value) { markup = value; } };
  globalThis.document = { activeElement: null, querySelector: selector => selector === '#restaurant-workspace' ? root : selector === '#restaurant-credit-estimate' ? estimate : selector === '[data-action="rest-generate"]' ? control : null, getElementById: () => null };
  globalThis.location = { origin: 'http://127.0.0.1:5173' };
  globalThis.matchMedia = () => ({ matches: true });
  globalThis.sessionStorage = { getItem: key => key.startsWith('restaurant-active-task') ? taskId : null, setItem() {}, removeItem() {} };
  const calls = [];
  workspace(t, async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    if (url.endsWith('/credits')) return Response.json({ ...balance(available), unlimited });
    if (url.endsWith('/status')) return Response.json({ enabled: true });
    if (url.endsWith('/profile')) return Response.json({ profile: { name: '真实店铺', city: '杭州', address: '街道1号', category: '餐饮' } });
    if (url.endsWith('/usage')) return Response.json({ usage: { limit: 20, remaining: 20 } });
    return Response.json(url.endsWith('/' + taskId) ? { task } : { tasks: [task] });
  });
  // Account storage uses the authenticated owner suffix, so let the task history open its saved task explicitly.
  await credits.refreshWorkspaceCredits();
  const module = await import(`../design/restaurant.js?wallet-view-${crypto.randomUUID()}`);
  t.after(() => { module.disposeRestaurant(); for (const [key, value] of Object.entries(saved)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; });
  const ctx = { icon: () => '', toast() {} };
  module.renderRestaurant(ctx); module.bindRestaurant(ctx);
  for (let i = 0; i < 30 && !markup.includes('我的图文任务'); i++) await tick();
  module.handleRestaurantAction('rest-open-task', { dataset: { id: taskId } }, ctx);
  const marker = task.status === 'failed' ? 'restaurant-failure' : 'restaurant-credit-estimate';
  for (let i = 0; i < 30 && !markup.includes(marker); i++) await tick();
  assert.ok(markup.includes(marker));
  return { html: () => markup, module, ctx, control, calls, count: number => countListener({ target: { value: String(number) } }) };
}

test('restaurant estimates reflect selected deliverable count and changing the count updates price without extra uploads', async t => {
  const view = await restaurantView(t);
  assert.match(view.html(), /预计 450 积分/);
  assert.doesNotMatch(view.html(), /次图片额度|发布包扣 1 次|全站今日剩余/);
  view.count(6); assert.match(view.html(), /预计 300 积分/);
  assert.equal(view.calls.filter(call => call.method === 'POST').length, 0);
});

test('restaurant prevents a known insufficient wallet from posting a package, while reducing output can restore the button', async t => {
  const view = await restaurantView(t, { available: 300 });
  assert.match(view.html(), /需要 450 积分，可用 300 积分/);
  view.module.handleRestaurantAction('rest-generate', { dataset: {} }, view.ctx);
  await tick(); assert.equal(view.calls.filter(call => call.method === 'POST').length, 0);
  view.count(6); assert.equal(view.control.disabled, false);
  assert.match(view.control.innerHTML, /生成图文发布包/);
});

test('restaurant accepts a server unlimited wallet with zero balance without quoting a charge', async t => {
  const view = await restaurantView(t, { available: 0, unlimited: true });
  assert.match(view.html(), /无限积分/);
  assert.doesNotMatch(view.html(), /积分不足|预计 \d+ 积分/);
  view.count(9);
  assert.equal(view.control.disabled, false);
  view.module.handleRestaurantAction('rest-generate', { dataset: {} }, view.ctx);
  await tick();
  assert.equal(view.calls.filter(call => call.method === 'POST').length, 1);
});

test('restaurant exempt failures do not promise to refund frozen points', async t => {
  const view = await restaurantView(t, { unlimited: true, taskOverrides: { status: 'failed', billing: { exempt: true, reservedPoints: 0, chargedPoints: 0 } } });
  assert.match(view.html(), /这次没有完成发布包/);
  assert.doesNotMatch(view.html(), /冻结积分|扣积分/);
});

test('a sparse two-photo restaurant package costs two image units and never the uploaded or fixed package count', async t => {
  const view = await restaurantView(t, { photos: 2, count: 2 });
  assert.match(view.html(), /预计 100 积分/);
  assert.doesNotMatch(view.html(), /预计 200 积分|扣 1 次/);
});
