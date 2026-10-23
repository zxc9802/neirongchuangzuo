import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { gunzipSync } from 'node:zlib';
import { createVideoCreatorHandler, normalizeVideoSettings } from '../services/video-creator/server.mjs';
import { createCreatorProvider, creatorConfig, creativeGenerationBody } from '../services/video-creator/provider.mjs';
import { createDirectorModel, validateDirectorResult, directorPacing } from '../services/video-creator/model.mjs';
import { createCreditsLedger } from '../services/credits/store.mjs';
import { VIDEO_MODELS, DEFAULT_VIDEO_SETTINGS, VIDEO_IMAGE_MAX_BYTES, VIDEO_AUDIO_MAX_BYTES } from '../design/video-catalog.js';
import { videoConfig } from '../services/video/provider.mjs';
import { collectGeneratedAssets } from '../design/generated-assets.js';

const settings = { ...DEFAULT_VIDEO_SETTINGS, duration: 4 };
const CONFIG = { enabled: true, publicOrigin: 'https://workspace.example', signingSecret: 'test-signing' };
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(100)]);

test('authenticated workspace API persists account data and rejects conflicts and cross-origin writes',async t=>{
  const f=await fixture(t),id=randomUUID(),change={collection:'drafts',id,revision:0,value:{id,input:'门店宣传',prompt:'',skill:'store-discovery'}};
  assert.equal((await f.call('/workspace',{owner:'none'})).status,401);
  assert.equal((await f.call('/workspace',{method:'PATCH',body:{changes:[change]},headers:{origin:'https://evil.example'}})).status,403);
  const res=await f.call('/workspace',{method:'PATCH',body:{changes:[change]}});assert.equal(res.status,200);
  assert.equal((await (await f.call('/workspace',{owner:'bob'})).json()).revision,0);
  assert.equal((await f.call('/workspace',{method:'PATCH',body:{changes:[{...change,value:{...change.value,input:'过期页面覆盖'}}]}})).status,409);
  await f.close();await f.open();assert.equal((await (await f.call('/workspace')).json()).entries['drafts/'+id].value.input,'门店宣传');
});

test('library exposes actual dimensions, real provider review status and expiry without other accounts',async t=>{
  const f=await fixture(t),id=await f.init(),photo=await f.upload(id);
  const library=async()=> (await (await f.call('/library')).json()).assets;
  let assets=await library();assert.equal(assets[0].width,256);assert.equal(assets[0].height,320);assert.equal(assets[0].review.status,'not_submitted');
  assert.deepEqual((await (await f.call('/library',{owner:'bob'})).json()).assets,[]);
  f.state.review=1;await f.generate(id);await f.until(async()=> (await library())[0]?.review.status==='pending');
  f.state.review=3;await f.until(async()=> (await library())[0]?.review.status==='rejected');
  f.advance(4*86400000);assets=await library();assert.equal(assets[0].id,photo);assert.equal(assets[0].status,'expired');assert.equal(assets[0].url,null);
});
test('reusing identical media in another draft keeps one library identity without merging character and scene purposes',async t=>{
  const f=await fixture(t),a=await f.init(),first=await f.upload(a),b=await f.init();await f.upload(b);await f.upload(b,randomUUID(),'character');
  const rows=(await (await f.call('/library')).json()).assets;
  assert.equal(rows.length,2);assert.ok(rows.some(r=>r.id===first));assert.equal(new Set(rows.map(r=>r.purpose)).size,2);
  assert.equal((await f.current(b)).assets.find(r=>r.purpose==='reference').originKey,first);
});

test('phase timings and connection recovery survive restart without duplicate generation',async t=>{
  const f=await fixture(t),id=await f.init();await f.upload(id);f.state.review=1;
  await f.generate(id);await f.until(async()=> (await f.current(id)).tasks[0]?.status==='reviewing');f.advance(5000);f.state.review=2;
  await f.until(async()=> (await f.current(id)).tasks[0]?.status==='running');f.state.queryFailed=true;
  await f.until(async()=> (await f.current(id)).tasks[0]?.events.some(e=>e.action==='query_retry'));
  await f.close();await f.open();f.advance(12000);f.state.queryFailed=false;f.state.done=true;
  const task=await f.until(async()=>{const task=(await f.current(id)).tasks[0];return task.status==='completed'&&task;});
  assert.equal(f.state.generates,1);assert.ok(task.events.some(e=>e.action==='server_resumed'));assert.ok(task.events.some(e=>e.action==='reconnected'));
  assert.ok(task.timeline.find(p=>p.phase==='reviewing').elapsedMs>=5000);assert.ok(task.timeline.find(p=>p.phase==='running').elapsedMs>=12000);
  assert.ok(task.timeline.some(p=>p.phase==='downloading'));assert.ok(task.settlement.completedAt);assert.equal(task.error,'');
});
function script(input) {
  return { kind: 'script', text: '完成编排', assets: [], warnings: [], script: { title: '真实门店', summary: '店铺与产品', videoPrompt: '图片1慢推展示真实门店，保留原本装修。',
    shots: [{ start: 0, end: input.settings.duration, visual: '真实门店慢推', referenceIds: [input.assets[0].id], voiceover: '', caption: '', camera: '慢推' }] } };
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'video-creator-'));
  const wallet = createCreditsLedger({ storageDir: join(root, 'credits'), databaseUrl: null, costMode: true }); await wallet.ready;
  const state = { generates: 0, materialCreates: 0, scripts: 0, review: 2, done: false, failed: false, downloads: 0, diagnosticErrors: [], sources: [] };
  const provider = { async createMaterial(url) { state.materialCreates++; state.source = url; state.sources.push(url); if (options.createMaterial) return options.createMaterial(url); return { id: 'material-' + state.materialCreates, status: state.review }; },
    async queryMaterial() { return state.review; }, async generateCreative(input) { state.generates++; state.input = input;
      if (state.uncertain) throw new Error('Connection reset'); return { taskId: 'provider-task' }; },
    async query() { if (state.queryFailed) throw Object.assign(new Error('连接中断'),{code:'TEST_CONNECTION_RESET'}); return state.failed ? { failed: true } : state.done ? { url: 'https://cdn.example/result.mp4' } : {}; } };
  let handler, app, base, clock = Date.now();
  async function open() {
    handler = createVideoCreatorHandler({ storageDir: join(root, 'creator'), config: CONFIG, provider, credits: wallet,
      director: { enabled: true, async generate(input, hooks) { state.scripts++; if (options.director) return options.director(input, hooks); return script(input); } },
      logger: { error: (...items) => state.diagnosticErrors.push(items) },
      aiConfig: {}, download: async (_url, path) => { state.downloads++; if (state.downloadFailed) throw new Error('Disk full'); await writeFile(path, MP4); },
      probe: async () => ({ duration: 4, width: 720, height: 1280, audio: true }), ...(options.voice ? { voice: options.voice } : {}), pollIntervalMs: 15, now: () => clock });
    await handler.ready;
    app = createServer((req, res) => { req.authenticatedUserId = req.headers['x-owner'] === 'none' ? null : req.headers['x-owner'] || 'alice'; void handler(req, res); });
    app.listen(0, '127.0.0.1'); await once(app, 'listening'); base = `http://127.0.0.1:${app.address().port}`;
  }
  async function close() { await handler.shutdown(); app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); }
  await open(); t.after(async () => { await close(); await wallet.close(); await rm(root, { recursive: true, force: true }); });
  const call = (path, { body, method = body ? 'POST' : 'GET', owner = 'alice', headers = {} } = {}) => fetch(base + '/api/video-creator' + path,
    { method, headers: { 'x-owner': owner, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body && JSON.stringify(body) });
  async function init(skill = 'store-discovery') { const id = randomUUID(), res = await call('/conversations', { body: { requestId: id, skill, settings } }); assert.equal(res.status, 201, await res.text()); return id; }
  const image = await sharp({ create: { width: 256, height: 320, channels: 3, background: '#335545' } }).jpeg().toBuffer();
  async function upload(id, asset = randomUUID(), purpose) { const res = await fetch(base + `/api/video-creator/conversations/${id}/assets/${asset}`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg', 'X-File-Name': encodeURIComponent('门店实拍.jpg'), ...(purpose ? { 'X-Asset-Purpose': purpose } : {}) }, body: image }); assert.equal(res.status, 200, await res.text()); return asset; }
  async function current(id) { return (await (await call(`/conversations/${id}`)).json()).conversation; }
  async function until(check) { for (let i = 0; i < 300; i++) { const value = await check(); if (value) return value; await delay(12); } assert.fail('Task did not reach expected state'); }
  const generate = (id, requestId = randomUUID(), extra = {}) => call(`/conversations/${id}/generate`, { body: { requestId, settings, prompt: '图片1展示真实门店', ...extra } });
  return { state, wallet, call, init, upload, current, until, generate, close, open, root, image, get base() { return base; }, advance(ms) { clock += ms; } };
}

test('reference purposes persist after restart, reach the director, enforce limits and cannot change on upload replay', async t => {
  let directorInput;
  const f = await fixture(t, { director(input) { directorInput = input; return script(input); } }), id = await f.init();
  const photo = await f.upload(id), character = await f.upload(id, randomUUID(), 'character');
  await f.upload(id, character, 'character');
  let c = await f.current(id); assert.equal(c.assets.length, 2); assert.equal(c.assets.find(a=>a.id===photo).purpose,'reference'); assert.equal(c.assets.find(a=>a.id===character).purpose,'character');
  const put = (asset, purpose) => fetch(f.base+`/api/video-creator/conversations/${id}/assets/${asset}`, {method:'PUT',headers:{'Content-Type':'image/jpeg','X-Asset-Purpose':purpose},body:f.image});
  assert.equal((await put(randomUUID(),'voice')).status,400); assert.equal((await put(randomUUID(),'arbitrary')).status,400);
  await f.close(); await f.open(); c=await f.current(id); assert.equal(c.assets.find(a=>a.id===character).purpose,'character');
  const response = await f.call(`/conversations/${id}/script`,{body:{requestId:randomUUID(),message:'让角色介绍门店',settings}}); assert.equal(response.status,202);
  await f.until(async()=> (await f.current(id)).operations.some(o=>o.status==='completed'));
  assert.equal(directorInput.assets.find(a=>a.id===character).purpose,'character');
  assert.equal(directorInput.planningVersion, 2);
  for(let i=0;i<9;i++) await f.upload(id,randomUUID(),'character');
  assert.equal((await put(randomUUID(),'character')).status,400);
  const changed = await put(character,'reference'); assert.equal(changed.status,409);
  assert.equal(f.state.generates,0);
});

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

test('new video requests accept 480p and 720p but still reject 1080p', async t => {
  assert.equal(DEFAULT_VIDEO_SETTINGS.resolution, '720p');
  const f = await fixture(t), id = await f.init(); await f.upload(id);
  for (const model of VIDEO_MODELS) {
    assert.deepEqual(model.resolutions, ['480p', '720p']);
    assert.equal(normalizeVideoSettings({ ...settings, model: model.id, resolution: '480p' }).resolution, '480p');
    for (const resolution of ['1080p']) {
      const input = { ...settings, model: model.id, resolution };
      assert.throws(() => normalizeVideoSettings(input), /设置无效/);
      assert.equal((await f.call('/quote', { body: { settings: input } })).status, 400);
      assert.equal((await f.generate(id, randomUUID(), { settings: input })).status, 400);
      assert.equal((await f.call(`/conversations/${id}/script`, { body: { requestId: randomUUID(), message: '介绍门店', settings: input } })).status, 400);
    }
  }
  assert.equal(f.state.generates, 0);
  assert.equal(creativeGenerationBody({ ...settings, resolution: '480p', prompt: '已提交的旧任务', imageIds: ['x'], audioIds: [] }).payload.params.resolution, '480p');
});

test('480p survives director, quote and provider submission for every video model', async t => {
  for (const model of VIDEO_MODELS) {
    const f = await fixture(t); f.state.done = true;
    const id = await f.init(); await f.upload(id);
    const selected = { ...settings, model: model.id, resolution: '480p' };
    assert.equal((await f.call('/quote', { body: { settings: selected } })).status, 200);
    const opId = randomUUID();
    assert.equal((await f.call(`/conversations/${id}/script`, { body: { requestId: opId, message: '介绍门店', settings: selected } })).status, 202);
    const op = await f.until(async () => (await f.current(id)).operations.find(o => o.id === opId && o.status === 'completed'));
    assert.equal(op.settings.resolution, '480p');
    assert.equal((await f.generate(id, randomUUID(), { settings: selected, scriptId: opId })).status, 202);
    const task = await f.until(async () => (await f.current(id)).tasks.find(t => t.status === 'completed'));
    assert.equal(task.settings.resolution, '480p');
    assert.equal(f.state.input.resolution, '480p');
    assert.equal(creativeGenerationBody(f.state.input).payload.params.resolution, '480p');
  }
});

test('image uploads accept just under 50MB, reject the exact boundary and preserve the audio limit', async t => {
  const f = await fixture(t), id = await f.init();
  const config = await (await f.call('/config')).json();
  assert.equal(config.limits.imageBytes, VIDEO_IMAGE_MAX_BYTES - 1);
  assert.equal(config.limits.audioBytes, VIDEO_AUDIO_MAX_BYTES);
  const large = Buffer.alloc(VIDEO_IMAGE_MAX_BYTES - 1); f.image.copy(large);
  const asset = randomUUID(), target = `/api/video-creator/conversations/${id}/assets/${asset}`;
  const accepted = await fetch(f.base + target, { method:'PUT', headers:{'Content-Type':'image/jpeg'}, body:large });
  assert.equal(accepted.status, 200, await accepted.text());
  const saved = (await f.current(id)).assets.find(a => a.id === asset); assert.equal(saved.size, large.length);
  const photo = await fetch(f.base + target); assert.equal(photo.status, 200); assert.ok((await photo.arrayBuffer()).byteLength < 1024 * 1024);
  const tooLarge = (type, size) => new Promise((resolve,reject) => {
    const req = httpRequest(f.base + `/api/video-creator/conversations/${id}/assets/${randomUUID()}`, {method:'PUT',headers:{'Content-Type':type,'Content-Length':size}},res=>{
      let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));
    });req.on('error',reject);req.flushHeaders();
  });
  const exact = await tooLarge('image/jpeg', VIDEO_IMAGE_MAX_BYTES); assert.equal(exact.status,413); assert.match(exact.body.error,/小于50MB/);
  assert.equal((await tooLarge('image/jpeg', VIDEO_IMAGE_MAX_BYTES + 1)).status,413);
  assert.equal((await tooLarge('audio/wav', VIDEO_AUDIO_MAX_BYTES + 1)).status,413);
  assert.equal((await f.current(id)).assets.length,1); assert.equal(f.state.generates,0);
});

test('switching to muted generation keeps the uploaded voice but sends no audio material upstream', async t => {
  const f = await fixture(t, {voice:async (_input,path)=>{await writeFile(path,Buffer.from('test-wav'));return {duration:4};}}), id=await f.init();
  const image=await f.upload(id), audio=randomUUID();
  const upload=await fetch(f.base+`/api/video-creator/conversations/${id}/assets/${audio}`,{method:'PUT',headers:{'Content-Type':'audio/wav','X-Asset-Purpose':'voice'},body:Buffer.from('test-wav')});
  assert.equal(upload.status,200);
  const response=await f.generate(id,randomUUID(),{settings:{...settings,generateAudio:false},referenceImageIds:[image]});
  assert.equal(response.status,202,await response.text());
  await f.until(()=>f.state.generates===1);
  assert.deepEqual(f.state.input.audioIds,[]); assert.equal(f.state.materialCreates,1);
  assert.equal((await f.current(id)).assets.some(a=>a.id===audio),true);
});

test('director validates real asset references and timeline, supports clarification and consumes streaming structured output', async () => {
  const id = randomUUID(), root = await mkdtemp(join(tmpdir(), 'director-model-')), path = join(root, 'photo.jpg');
  try {
    await sharp({ create: { width: 320, height: 160, channels: 3, background: '#445544' } }).withMetadata({ orientation: 6 }).jpeg().toFile(path);
    const input = { skill: 'store-discovery', settings, message: '做一条宣传', assets: [{ id, path, type: 'image', purpose: 'character', name: '角色' }], history: [] };
    assert.equal(validateDirectorResult({ kind: 'clarification', questions: ['套餐价格和使用条件是什么？'] }, input).kind, 'clarification');
    const bad = script(input); bad.script.shots[0].referenceIds = ['invented']; assert.throws(() => validateDirectorResult(bad, input), /素材引用/);
    const timing = script(input); timing.script.shots[0].end = 15; assert.throws(() => validateDirectorResult(timing, input), /时长/);
    let sent;
    const result = await createDirectorModel({ config: { apiKey: 'private-key', baseUrl: 'https://text.example/v1', imageTextModel: 'claude-opus-5-5' }, fetchImpl: async (_url, opts) => {
      sent = JSON.parse(opts.body); const output = script(input); delete output.script.videoPrompt; output.script.globalDirection = '保留真实装修与暖色灯光。';
      return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 100, completion_tokens: 200 } }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    } }).generate(input);
    assert.equal(result.kind, 'script'); assert.equal(result.script.shots[0].referenceIds[0], id);
    assert.equal(sent.model, 'claude-opus-5-5'); assert.equal(sent.messages[1].content.filter(x => x.type === 'image_url').length, 1);
    const prepared = sent.messages[1].content.find(x => x.type === 'image_url').image_url.url.split(',')[1];
    const photo = await sharp(Buffer.from(prepared, 'base64')).metadata();
    assert.equal(photo.width, 160); assert.equal(photo.height, 320); assert.equal(photo.orientation, undefined);
    assert.match(sent.messages[0].content, /团购缺少套餐内容/);
    assert.equal(JSON.parse(sent.messages[1].content[0].text).assets[0].purpose, 'character');
    assert.match(sent.messages[0].content, /不把角色照片的背景当作真实门店/);
    assert.equal(JSON.parse(sent.messages[1].content[0].text).pacing.duration, settings.duration);
    assert.ok(result.script.videoPrompt.includes(`镜头1｜0–${settings.duration}秒｜参考图片1`));
  } finally { await rm(root, { force: true, recursive: true }); }
});

test('director pacing adapts to duration without imposing a fixed shot count', () => {
  assert.deepEqual(directorPacing({ duration: 30 }).suggestedShots, { min: 8, max: 10 });
  for (const model of VIDEO_MODELS) for (const duration of model.durations) {
    const { min, max } = directorPacing({ duration }).suggestedShots;
    assert.ok(min >= 1 && max >= min && max <= 15);
  }
  const input = { settings: { ...settings, duration: 30 }, assets: [{ id: 'room', type: 'image' }] };
  assert.equal(validateDirectorResult(script(input), input).script.shots.length, 1);
});

test('applied director prompt retains every planned shot and maps references by image order', () => {
  const input = { settings: { ...settings, duration: 30, language: 'en' }, assets: [
    { id: 'voice', type: 'audio' }, { id: 'room', type: 'image' }, { id: 'bar', type: 'image' }, { id: 'stage', type: 'image' },
  ] };
  const shots = Array.from({ length: 8 }, (_, i) => ({ start: i * 3.75, end: (i + 1) * 3.75,
    visual: `展示重点${i + 1}`, referenceIds: [['room', 'bar', 'stage'][i % 3]], camera: `衔接${i + 1}`, voiceover: 'Voice', caption: '' }));
  const value = { kind: 'script', script: { title: '门店', globalDirection: '暖黄灯光与粉紫舞台色保持一致。', shots,
    videoPrompt: '旧版只写了0到10秒，不应采用' } };
  const result = validateDirectorResult(value, input).script;
  assert.equal(result.shots.length, 8);
  for (let i = 0; i < 8; i++) {
    assert.ok(result.videoPrompt.includes(`镜头${i + 1}｜${shots[i].start}–${shots[i].end}秒`));
    assert.ok(result.videoPrompt.includes(shots[i].visual));
    assert.ok(result.videoPrompt.includes(`参考图片${i % 3 + 1}`));
  }
  assert.match(result.videoPrompt, /旁白语言：英文/);
  assert.doesNotMatch(result.videoPrompt, /旧版|room|bar|stage|voice/);
  const muted = validateDirectorResult(value, { ...input, settings: { ...input.settings, generateAudio: false } }).script;
  assert.match(muted.videoPrompt, /静音视频/); assert.doesNotMatch(muted.videoPrompt, /旁白：Voice/);
  const incomplete = structuredClone(value); incomplete.script.shots.pop();
  assert.throws(() => validateDirectorResult(incomplete, input), /总时长/);
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
  const saved = JSON.parse(await readFile(join(f.root, 'creator', id, 'state.json'), 'utf8'));
  const legacyFingerprint = createHash('sha256').update(JSON.stringify({ settings, prompt: '图片1展示真实门店', scriptId: opid, assetIds: [asset] })).digest('hex');
  assert.equal(saved.tasks.find(t => t.id === tid).fingerprint, legacyFingerprint);
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

test('director meters regular and unlimited accounts, replays once and restores historical usage from its ledger', async t => {
  for (const unlimited of [false, true]) await t.test(unlimited ? 'unlimited' : 'regular', async t => {
    const opid = randomUUID(); let f;
    f = await fixture(t, { director: async input => {
      const scope = { userId: 'alice', taskId: `director:${opid}`, receiptId: 'analysis-and-planning' };
      await f.wallet.prepareCostCall({ ...scope, provider: 'test', quoteCny: .2 });
      await f.wallet.finishCostCall({ ...scope, costCny: .16 });
      return script(input);
    } });
    await f.wallet.setUnlimited('alice', unlimited);
    const id = await f.init(); await f.upload(id);
    const input = { requestId: opid, message: '编排实拍素材', settings, expectedScriptId: null };
    assert.equal((await f.call(`/conversations/${id}/script`, { body: input })).status, 202);
    const op = await f.until(async () => (await f.current(id)).operations.find(o => o.status === 'completed' && o.billing?.status === 'settled'));
    assert.equal(op.billing.usagePoints, 20);
    assert.equal(op.billing.chargedPoints, unlimited ? 0 : 20);
    assert.equal((await f.wallet.snapshot('alice')).available, unlimited ? 1000 : 980);
    await f.call(`/conversations/${id}/script`, { body: input });
    assert.equal(f.state.scripts, 1);
    await f.close();
    const path = join(f.root, 'creator', id, 'state.json'), saved = JSON.parse(await readFile(path, 'utf8'));
    delete saved.operations[0].billing.usagePoints;
    await writeFile(path, JSON.stringify(saved)); await f.open();
    assert.equal((await f.current(id)).operations[0].billing.usagePoints, 20);
    assert.equal((await f.wallet.snapshot('alice')).available, unlimited ? 1000 : 980);
  });
});

test('switching modules keeps materials while isolating director history and rejecting an old applied script', async t => {
  const inputs = [], f = await fixture(t, { director: async input => { inputs.push(structuredClone(input)); return script(input); } });
  const id = await f.init('store-visit'); await f.upload(id);
  async function direct(message) {
    const c = await f.current(id), opId = randomUUID();
    const res = await f.call(`/conversations/${id}/script`, { body: { requestId: opId, settings, message,
      expectedScriptId: c.operations.findLast(o => o.status === 'completed')?.id || null } });
    assert.equal(res.status, 202);
    await f.until(async () => (await f.current(id)).operations.find(o => o.id === opId && o.status === 'completed'));
    return opId;
  }
  const visitId = await direct('展示进店与体验');
  await f.call(`/conversations/${id}`, { method: 'PATCH', body: { skill: 'signature', settings } });
  assert.equal((await f.current(id)).assets.length, 1);
  const stale = await f.generate(id, randomUUID(), { scriptId: visitId });
  assert.equal(stale.status, 409); assert.equal(f.state.generates, 0);
  await direct('主推可见产品'); assert.equal(inputs.at(-1).skill, 'signature'); assert.deepEqual(inputs.at(-1).history, []);
  await f.call(`/conversations/${id}`, { method: 'PATCH', body: { skill: 'store-visit', settings } });
  await direct('保留上次动线，增加细节');
  const history = inputs.at(-1).history;
  assert.equal(history.length, 2); assert.equal(history[0].content, '展示进店与体验');
  assert.ok(!JSON.stringify(history).includes('主推可见产品'));
});

test('only planned images reach material preparation and reopening a result preserves that selection', async t => {
  const f = await fixture(t, { director: async input => {
    const out = script(input); out.script.referenceImageIds = input.assets.slice(1).map(a => a.id);
    out.script.shots[0].referenceIds = out.script.referenceImageIds; out.script.videoPrompt = '图片1展示食品，图片2展示桌面'; return out;
  } });
  const id = await f.init('signature'), person = await f.upload(id), food = await f.upload(id), room = await f.upload(id), opId = randomUUID();
  const res = await f.call(`/conversations/${id}/script`, { body: { requestId: opId, message: '只展示产品，不用人物照片', settings, expectedScriptId: null } });
  assert.equal(res.status, 202); await f.until(async () => (await f.current(id)).operations.find(o => o.id === opId && o.status === 'completed'));
  const wrong = await f.generate(id, randomUUID(), { scriptId: opId, referenceImageIds: [person, food] });
  assert.equal(wrong.status, 409); assert.equal(f.state.generates, 0);
  const invalid = await f.generate(id, randomUUID(), { referenceImageIds: [randomUUID()] }); assert.equal(invalid.status, 400);
  assert.equal((await f.generate(id, randomUUID(), { scriptId: opId, referenceImageIds: [food, room] })).status, 202);
  await f.until(() => f.state.generates === 1);
  assert.equal(f.state.materialCreates, 2); assert.deepEqual(f.state.input.imageIds, ['material-1', 'material-2']);
  assert.ok(f.state.sources.some(s => new URL(s).pathname.endsWith(food))); assert.ok(f.state.sources.some(s => new URL(s).pathname.endsWith(room)));
  assert.ok(f.state.sources.every(s => !new URL(s).pathname.endsWith(person)));
  f.state.done = true;
  const task = await f.until(async () => (await f.current(id)).tasks.find(t => t.status === 'completed'));
  assert.equal(task.scriptId, opId); assert.deepEqual(task.referenceImageIds, [food, room]); assert.equal(task.materialProgress.total, 2);
  assert.equal((await f.current(id)).assets.length, 3);
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

test('lost material-create response reconciles the accepted asset before retrying and ignores expired URL signatures', async () => {
  const config = { material: { base: 'https://supplier.example', project: 'project', access: 'access', secret: 'secret' } };
  const url = 'https://workspace.example/source/immutable-photo?signature=new'; let creates = 0, lists = 0;
  const provider = createCreatorProvider(config, async (target, opts) => {
    if (new URL(target).pathname.endsWith('/create')) { creates++; throw new Error('Accepted upstream but connection reset'); }
    lists++;
    return Response.json({ success: true, data: { records: lists === 1 ? [] : [
      { materialId: 'foreign', originalUrl: 'https://other.example/source/immutable-photo', status: 2, fileType: 1 },
      { materialId: 'accepted', originalUrl: 'https://workspace.example/source/immutable-photo?signature=previous', status: 2, fileType: 1 },
    ] } });
  });
  assert.deepEqual(await provider.createMaterial(url, 'photo'), { id: 'accepted', status: 2 }); assert.equal(creates, 1); assert.equal(lists, 2);
  assert.deepEqual(await provider.createMaterial(url, 'photo'), { id: 'accepted', status: 2 }); assert.equal(creates, 1);
});

test('material preparation runs at most three requests together and preserves image reference order', async t => {
  const pending = [];
  const f = await fixture(t, { createMaterial: url => new Promise(resolve => pending.push({ url, resolve })) });
  const id = await f.init(), images = [];
  for (let i = 0; i < 4; i++) images.push(await f.upload(id));
  await f.generate(id); await f.until(() => pending.length === 3);
  assert.equal(f.state.materialCreates, 3);
  const resolve = item => item.resolve({ id: 'material-' + new URL(item.url).pathname.split('/').at(-1), status: 2 });
  resolve(pending[2]); await f.until(() => pending.length === 4); resolve(pending[3]); resolve(pending[1]); resolve(pending[0]);
  await f.until(() => f.state.generates === 1); assert.deepEqual(f.state.input.imageIds, images.map(id => 'material-' + id));
});

test('director diagnostics persist privately across restart and expire with media without losing summaries', async t => {
  const f = await fixture(t, { director: async (input, hooks) => {
    await hooks.onAttempt({ attempt: 1, status: 'failed', startedAt: 1, completedAt: 2, maxOutputTokens: 16384, finishReason: 'length',
      rawResponse: 'private partial response', responseContent: 'private partial content', error: { code: 'DIRECTOR_OUTPUT_TRUNCATED', issue: 'truncated', phase: 'parse', message: '输出截断', detail: 'specific parser error' } });
    await hooks.onAttempt({ attempt: 2, status: 'completed', startedAt: 3, completedAt: 4, maxOutputTokens: 32768, finishReason: 'stop',
      rawResponse: 'private complete response', parsedResponse: { private: 'content' }, usage: { completion_tokens: 2500 } });
    return script(input);
  } });
  const id = await f.init(); await f.upload(id); const op = randomUUID();
  assert.equal((await f.call(`/conversations/${id}/script`, { body: { requestId: op, message: '新的编导', settings } })).status, 202);
  await f.until(async () => (await f.current(id)).operations[0]?.status === 'completed');
  const path = join(f.root, 'creator', id, `director-${op}.json.gz`);
  const diagnostic = JSON.parse(gunzipSync(await readFile(path)).toString());
  assert.equal(diagnostic.attempts.length, 2); assert.equal(diagnostic.attempts[0].rawResponse, 'private partial response');
  assert.equal(diagnostic.attempts[1].finishReason, 'stop');
  const current = await f.current(id); assert.equal(current.operations[0].diagnostics.attempts[0].error.issue, 'truncated');
  assert.ok(current.operations[0].completedAt >= current.operations[0].startedAt);
  assert.equal(current.operations[0].diagnostics.rawAvailable, true); assert.ok(!JSON.stringify(current).includes('private'));
  assert.equal(f.state.diagnosticErrors.length, 1); assert.match(JSON.stringify(f.state.diagnosticErrors), /specific parser error/);
  assert.equal((await f.call(`/conversations/${id}/assets/director-${op}.json.gz`)).status, 404);
  await f.close(); await f.open(); assert.equal((await f.current(id)).operations[0].diagnostics.attempts.length, 2);
  f.advance(3 * 86400000 + 1);
  await f.until(async () => (await f.current(id)).operations[0].diagnostics.rawAvailable === false);
  await assert.rejects(readFile(path), { code: 'ENOENT' });
  assert.equal((await f.current(id)).operations[0].diagnostics.attempts[1].finishReason, 'stop');
});


test('an applied 15-second director script can switch provider models without bypassing content-setting checks', async t => {
  const f = await fixture(t); await f.wallet.setUnlimited('alice', true); f.state.done = true;
  const id = await f.init(); await f.upload(id);
  const planned = { ...settings, duration: 15 }, opId = randomUUID();
  assert.equal((await f.call(`/conversations/${id}/script`, { body: { requestId: opId, message: '15秒门店', settings: planned } })).status, 202);
  await f.until(async () => (await f.current(id)).operations.find(o => o.id === opId && o.status === 'completed'));
  for (const model of VIDEO_MODELS) for (const resolution of ['480p', '720p']) {
    const taskId = randomUUID(), selected = { ...planned, model: model.id, resolution };
    assert.equal((await f.generate(id, taskId, { settings: selected, scriptId: opId })).status, 202);
    await f.until(async () => (await f.current(id)).tasks.find(t => t.id === taskId && t.status === 'completed'));
    assert.equal(f.state.input.resolution, resolution); assert.equal(f.state.input.model, model.id); assert.equal(f.state.input.duration, 15);
  }
  for (const change of [{ duration: 10 }, { language: 'en' }, { ratio: '16:9' }, { generateAudio: false }]) {
    const res = await f.generate(id, randomUUID(), { settings: { ...planned, ...change }, scriptId: opId });
    assert.equal(res.status, 409); assert.equal((await res.json()).code, 'SCRIPT_SETTINGS_CHANGED');
  }
  assert.equal(f.state.scripts, 1);
});
