import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { createVideoCreatorHandler, normalizeVideoSettings } from '../services/video-creator/server.mjs';
import { createCreatorProvider, creatorConfig, creativeGenerationBody } from '../services/video-creator/provider.mjs';
import { createDirectorModel, validateDirectorResult } from '../services/video-creator/model.mjs';
import { createCreditsLedger } from '../services/credits/store.mjs';
import { VIDEO_MODELS, DEFAULT_VIDEO_SETTINGS } from '../design/video-catalog.js';
import { videoConfig } from '../services/video/provider.mjs';
import { collectGeneratedAssets } from '../design/generated-assets.js';

const settings = { ...DEFAULT_VIDEO_SETTINGS, duration: 4 };
const CONFIG = { enabled: true, publicOrigin: 'https://workspace.example', signingSecret: 'test-signing' };
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(100)]);
function script(input) {
  return { kind: 'script', text: '完成编排', assets: [], warnings: [], script: { title: '真实门店', summary: '店铺与产品', videoPrompt: '图片1慢推展示真实门店，保留原本装修。',
    shots: [{ start: 0, end: input.settings.duration, visual: '真实门店慢推', referenceIds: [input.assets[0].id], voiceover: '', caption: '', camera: '慢推' }] } };
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'video-creator-'));
  const wallet = createCreditsLedger({ storageDir: join(root, 'credits'), databaseUrl: null, costMode: true }); await wallet.ready;
  const state = { generates: 0, materialCreates: 0, scripts: 0, review: 2, done: false, failed: false, downloads: 0 };
  const provider = { async createMaterial(url) { state.materialCreates++; state.source = url; return { id: 'material-' + state.materialCreates, status: state.review }; },
    async queryMaterial() { return state.review; }, async generateCreative(input) { state.generates++; state.input = input;
      if (state.uncertain) throw new Error('Connection reset'); return { taskId: 'provider-task' }; },
    async query() { return state.failed ? { failed: true } : state.done ? { url: 'https://cdn.example/result.mp4' } : {}; } };
  let handler, app, base, clock = Date.now();
  async function open() {
    handler = createVideoCreatorHandler({ storageDir: join(root, 'creator'), config: CONFIG, provider, credits: wallet,
      director: { enabled: true, async generate(input) { state.scripts++; if (options.director) return options.director(input); return script(input); } },
      aiConfig: {}, download: async (_url, path) => { state.downloads++; if (state.downloadFailed) throw new Error('Disk full'); await writeFile(path, MP4); },
      probe: async () => ({ duration: 4, width: 720, height: 1280, audio: true }), pollIntervalMs: 15, now: () => clock });
    await handler.ready;
    app = createServer((req, res) => { req.authenticatedUserId = req.headers['x-owner'] === 'none' ? null : req.headers['x-owner'] || 'alice'; void handler(req, res); });
    app.listen(0, '127.0.0.1'); await once(app, 'listening'); base = `http://127.0.0.1:${app.address().port}`;
  }
  async function close() { await handler.shutdown(); app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); }
  await open(); t.after(async () => { await close(); await wallet.close(); await rm(root, { recursive: true, force: true }); });
  const call = (path, { body, method = body ? 'POST' : 'GET', owner = 'alice', headers = {} } = {}) => fetch(base + '/api/video-creator' + path,
    { method, headers: { 'x-owner': owner, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body && JSON.stringify(body) });
  async function init() { const id = randomUUID(), res = await call('/conversations', { body: { requestId: id, skill: 'store-discovery', settings } }); assert.equal(res.status, 201, await res.text()); return id; }
  const image = await sharp({ create: { width: 256, height: 320, channels: 3, background: '#335545' } }).jpeg().toBuffer();
  async function upload(id, asset = randomUUID()) { const res = await fetch(base + `/api/video-creator/conversations/${id}/assets/${asset}`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg', 'X-File-Name': encodeURIComponent('门店实拍.jpg') }, body: image }); assert.equal(res.status, 200, await res.text()); return asset; }
  async function current(id) { return (await (await call(`/conversations/${id}`)).json()).conversation; }
  async function until(check) { for (let i = 0; i < 300; i++) { const value = await check(); if (value) return value; await delay(12); } assert.fail('Task did not reach expected state'); }
  const generate = (id, requestId = randomUUID(), extra = {}) => call(`/conversations/${id}/generate`, { body: { requestId, settings, prompt: '图片1展示真实门店', ...extra } });
  return { state, wallet, call, init, upload, current, until, generate, close, open, root, get base() { return base; }, advance(ms) { clock += ms; } };
}

test('Seedance request matches reference repository and enforces model-specific capabilities', async () => {
  const env = { VIDEO_CREATOR_VIDEO_API_BASE_URL: 'http://upstream.example', VIDEO_CREATOR_VIDEO_PROJECT_CODE: 'project', VIDEO_CREATOR_VIDEO_ACCESS_KEY: 'access', VIDEO_CREATOR_VIDEO_SECRET_KEY: 'secret',
    VIDEO_CREATOR_STORAGE_KEY: 'storage' };
  const config = creatorConfig(env); assert.equal(config.enabled, true); assert.equal(videoConfig(env).enabled, false);
  const requests = [], p = createCreatorProvider(config, async (url, options) => { requests.push({ url: String(url), headers: options.headers, body: JSON.parse(options.body) }); return Response.json({ success: true, data: { taskId: 'paid-id' } }); });
  await p.generateCreative({ ...settings, prompt: '门店', imageIds: ['image-1', 'image-2'], audioIds: ['voice-1'] });
  assert.deepEqual(requests[0].body, { modelId: settings.model, abilityType: 'VIDEO', prompt: '门店', payload: { params: { mode: 'fusion_video', resolution: '720p', scale: '9:16', duration: 4, generateAudio: true }, resources: ['asset://image-1', 'asset://image-2'], referAudioUrl: ['asset://voice-1'] } });
  assert.equal(requests[0].headers['X-Secret-Key'], 'secret');
  assert.throws(() => creativeGenerationBody({ ...settings, model: VIDEO_MODELS[0].id, imageIds: Array(10).fill('x'), audioIds: [] }), /支持范围/);
  assert.throws(() => normalizeVideoSettings({ ...settings, model: VIDEO_MODELS[0].id, resolution: '1080p' }), /设置无效/);
  assert.throws(() => normalizeVideoSettings({ ...settings, model: VIDEO_MODELS[1].id, duration: 30 }), /设置无效/);
  const dedicated = creatorConfig({ ...env, VIDEO_CREATOR_SEEDANCE_25_PROJECT_CODE: 'different' });
  await assert.rejects(createCreatorProvider(dedicated).generateCreative({ ...settings, prompt: '门店', imageIds: ['x'], audioIds: [] }), /独立接口配置不完整/);
});

test('director validates real asset references and timeline, supports clarification and consumes streaming structured output', async () => {
  const id = randomUUID(), root = await mkdtemp(join(tmpdir(), 'director-model-')), path = join(root, 'photo.jpg');
  try {
    await sharp({ create: { width: 256, height: 256, channels: 3, background: '#445544' } }).jpeg().toFile(path);
    const input = { skill: 'group-buy', settings, message: '做一条宣传', assets: [{ id, path, type: 'image', name: '门店' }], history: [] };
    assert.equal(validateDirectorResult({ kind: 'clarification', questions: ['套餐价格和使用条件是什么？'] }, input).kind, 'clarification');
    const bad = script(input); bad.script.shots[0].referenceIds = ['invented']; assert.throws(() => validateDirectorResult(bad, input), /素材引用/);
    const timing = script(input); timing.script.shots[0].end = 15; assert.throws(() => validateDirectorResult(timing, input), /时长/);
    let sent;
    const result = await createDirectorModel({ config: { apiKey: 'private-key', baseUrl: 'https://text.example/v1', imageTextModel: 'claude-opus-5-5' }, fetchImpl: async (_url, opts) => {
      sent = JSON.parse(opts.body); return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(script(input)) } }], usage: { prompt_tokens: 100, completion_tokens: 200 } }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    } }).generate(input);
    assert.equal(result.kind, 'script'); assert.equal(result.script.shots[0].referenceIds[0], id);
    assert.equal(sent.model, 'claude-opus-5-5'); assert.equal(sent.messages[1].content.filter(x => x.type === 'image_url').length, 1);
    assert.match(sent.messages[0].content, /团购缺少套餐内容/);
  } finally { await rm(root, { force: true, recursive: true }); }
});

test('full workflow: upload, director, apply, single idempotent render, correct MP4 download and cost settlement', async t => {
  const f = await fixture(t), id = await f.init(), asset = await f.upload(id); await f.upload(id, asset);
  assert.equal((await f.current(id)).assets.length, 1);
  const opid = randomUUID(), input = { requestId: opid, message: '重点展示门店和招牌', settings, expectedScriptId: null };
  assert.equal((await f.call(`/conversations/${id}/script`, { body: input })).status, 202);
  const op = await f.until(async () => (await f.current(id)).operations.find(o => o.status === 'completed'));
  assert.equal(op.result.script.title, '真实门店');
  assert.equal((await f.call(`/conversations/${id}/script`, { body: input })).status, 202); assert.equal(f.state.scripts, 1);
  assert.equal((await f.call(`/conversations/${id}/script`, { body: { ...input, settings: { ...settings, duration: 5 } } })).status, 409);
  const tid = randomUUID(); assert.equal((await f.generate(id, tid, { scriptId: opid })).status, 202);
  await f.until(() => f.state.generates === 1); assert.equal((await f.wallet.snapshot('alice')).held, 500);
  assert.equal((await f.generate(id, tid, { scriptId: opid })).status, 202); assert.equal(f.state.generates, 1);
  assert.equal((await f.generate(id, tid, { prompt: 'different', scriptId: opid })).status, 409);
  const signed = new URL(f.state.source); const publicSource = await fetch(f.base + signed.pathname + signed.search, { headers: { 'x-owner': 'none' } }); assert.equal(publicSource.status, 200);
  assert.equal((await fetch(f.base + signed.pathname + '?expires=1&signature=' + 'a'.repeat(64))).status, 403);
  f.state.done = true;
  const task = await f.until(async () => (await f.current(id)).tasks.find(x => x.status === 'completed'));
  assert.equal(task.billing.chargedPoints, 500); assert.equal((await f.wallet.snapshot('alice')).available, 500);
  const response = await f.call(`/tasks/${tid}/result?download=1`); assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.match(response.headers.get('content-disposition'), /qiya-video\.mp4/); assert.deepEqual(Buffer.from(await response.arrayBuffer()), MP4);
  assert.equal((await f.call(`/tasks/${tid}/result`, { headers: { Range: 'bytes=0-7' } })).status, 206);
  assert.equal((await f.call(`/tasks/${tid}`, { owner: 'bob' })).status, 404);
  assert.equal((await f.call(`/conversations/${id}`, { owner: 'bob' })).status, 404);
  assert.equal((await f.call('/config', { owner: 'none' })).status, 401);
  assert.equal((await f.call(`/conversations/${id}`, { method: 'PATCH', body: { skill: 'signature', settings }, headers: { Origin: 'https://attacker.example' } })).status, 403);
  const assets = collectGeneratedAssets([], [], Date.now(), [], [], [task]); assert.equal(assets.length, 1); assert.equal(assets[0].source, 'AI 视频');
});

test('provider failure releases held points and ambiguous submission survives restart without replay or refund', async t => {
  const f = await fixture(t), first = await f.init(); await f.upload(first);
  assert.equal((await f.generate(first)).status, 202); await f.until(() => f.state.generates === 1); f.state.failed = true;
  await f.until(async () => (await f.current(first)).tasks.find(x => x.status === 'failed'));
  assert.equal((await f.wallet.snapshot('alice')).available, 1000);
  f.state.failed = false; f.state.uncertain = true;
  const second = await f.init(); await f.upload(second); await f.generate(second);
  await f.until(async () => (await f.current(second)).tasks.find(x => x.status === 'uncertain'));
  assert.equal((await f.wallet.snapshot('alice')).held, 500);
  await f.close(); await f.open(); await delay(80);
  assert.equal(f.state.generates, 2); assert.equal((await f.wallet.snapshot('alice')).held, 500);
});

test('running tasks resume query after restart, failed save can recover without paying for a new render', async t => {
  const f = await fixture(t), id = await f.init(); await f.upload(id); await f.generate(id); await f.until(() => f.state.generates === 1);
  await f.close(); await f.open(); f.state.done = true; f.state.downloadFailed = true;
  const failed = await f.until(async () => (await f.current(id)).tasks.find(x => x.status === 'failed' && x.billing?.status === 'settled'));
  assert.equal(failed.canRecover, true); assert.equal(failed.billing.chargedPoints, 500);
  f.state.downloadFailed = false; assert.equal((await f.call(`/tasks/${failed.id}/recover`, { body: {} })).status, 202);
  await f.until(async () => (await f.current(id)).tasks.find(x => x.status === 'completed'));
  assert.equal(f.state.generates, 1); assert.equal((await f.wallet.snapshot('alice')).available, 500);
});

test('insufficient points and stale script are rejected before upstream generation', async t => {
  const f = await fixture(t), id = await f.init(); await f.upload(id);
  assert.equal((await f.call(`/conversations/${id}/script`, { body: { requestId: randomUUID(), message: '修改脚本', settings, expectedScriptId: randomUUID() } })).status, 409);
  const res = await f.generate(id, randomUUID(), { settings: { ...settings, duration: 15 } }); assert.equal(res.status, 402); assert.equal(f.state.generates, 0);
  assert.equal((await f.wallet.snapshot('alice')).held, 0);
});

test('expiry blocks uploads and downloads while keeping text records for thirty days', async t => {
  const f = await fixture(t), id = await f.init(); const asset = await f.upload(id); await f.generate(id); await f.until(() => f.state.generates === 1); f.state.done = true;
  const task = await f.until(async () => (await f.current(id)).tasks.find(x => x.status === 'completed'));
  f.advance(3 * 86400000 + 1000); await delay(50);
  assert.equal((await f.call(`/tasks/${task.id}/result`)).status, 410);
  assert.equal((await f.call(`/conversations/${id}/assets/${asset}`)).status, 410);
  assert.equal((await f.current(id)).tasks[0].status, 'expired');
  const disk = JSON.parse(await readFile(join(f.root, 'creator', id, 'state.json'), 'utf8'));
  assert.equal(disk.tasks[0].prompt, '图片1展示真实门店');
  f.advance(28 * 86400000); await f.until(async () => (await f.call(`/conversations/${id}`)).status === 404);
});

test('a task interrupted during reservation releases its hold without dispatching after restart', async t => {
  const f = await fixture(t), id = await f.init(); await f.upload(id); await f.close();
  const tid = randomUUID(), scope = { userId: 'alice', taskId: 'video:' + tid };
  await f.wallet.reserveCost(scope); await f.wallet.prepareCostCall({ ...scope, receiptId: 'render', quoteCny: 4, provider: 'seedance' });
  const path = join(f.root, 'creator', id, 'state.json'), record = JSON.parse(await readFile(path, 'utf8'));
  record.tasks.push({ id: tid, settings, prompt: '门店', status: 'reserving', skill: record.skill, createdAt: Date.now(), startedAt: Date.now() });
  await writeFile(path, JSON.stringify(record)); await f.open();
  const task = (await f.current(id)).tasks[0]; assert.equal(task.status, 'failed'); assert.equal(task.billing.status, 'settled');
  assert.equal((await f.wallet.snapshot('alice')).available, 1000); assert.equal(f.state.generates, 0);
});

test('task identifiers cannot share a billing reservation across different conversations', async t => {
  const f = await fixture(t), first = await f.init(), second = await f.init(); await f.upload(first); await f.upload(second);
  const id = randomUUID(); assert.equal((await f.generate(first, id)).status, 202);
  assert.equal((await f.generate(second, id)).status, 409); await f.until(() => f.state.generates === 1);
  assert.equal((await f.current(second)).tasks.length, 0); assert.equal((await f.wallet.snapshot('alice')).held, 500);
});
