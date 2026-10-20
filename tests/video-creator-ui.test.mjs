import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_VIDEO_SETTINGS } from '../design/video-catalog.js';

async function fixture(t, api) {
  const names = ['document', 'workspaceUser', 'fetch', 'setInterval', 'clearInterval', 'EventSource', 'SpeechRecognition', 'webkitSpeechRecognition', 'FormData'];
  const old = Object.fromEntries(names.map(k => [k, globalThis[k]])), nodes = new Map();
  const node = k => { if (!nodes.has(k)) nodes.set(k, { clicks: 0, click() { this.clicks++; }, close() {}, addEventListener(type, callback) { this[type] = callback; } }); return nodes.get(k); };
  let poll, html, modal;
  globalThis.workspaceUser = { id: crypto.randomUUID() };
  globalThis.document = { body: { dataset: { page: 'video' } }, querySelector: node };
  globalThis.EventSource = undefined;
  globalThis.setInterval = cb => { poll = cb; return 1; }; globalThis.clearInterval = () => {};
  globalThis.fetch = async (path, options) => path === '/api/workspace/credits' ? Response.json({ unlimited: true }) : api(path, options);
  const module = await import('../design/video-creator.js?test=' + crypto.randomUUID());
  const ctx = { esc: x => String(x ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'), icon: () => '', mode: 'video', button: (action, text, _class, attrs = '') => `<button data-action="${action}" ${attrs}>${text}</button>`,
    configs: { video: { prompt: '', files: [] } }, assets: [], toast() {}, openModal(title, _subtitle, content) { modal = { title, content }; }, refresh() { html = module.renderVideoCreator(ctx); } };
  ctx.refresh(); module.bindVideoCreator(ctx);
  t.after(() => { module.disposeVideoCreator(); for (const key of names) { if (old[key] === undefined) delete globalThis[key]; else globalThis[key] = old[key]; } });
  await delay(15);
  return { node, ctx, html: () => html, modal: () => modal, action: (name, data = {}, actionContext = ctx) => module.handleVideoCreatorAction(name, { dataset: data }, actionContext), async poll() { await poll(); await delay(5); } };
}

function composerApi() {
  const data = { conversation: null, scriptCalls: 0, uploads: [] };
  data.api = async (path, options) => {
    const body = options?.body && options.method !== 'PUT' ? JSON.parse(options.body) : null;
    if (path.endsWith('/config')) return Response.json({ directorEnabled: true, generationEnabled: true });
    if (path.endsWith('/quote')) return Response.json({ points: 1000, affordable: true });
    if (path.endsWith('/tasks')) return Response.json({ tasks: [] });
    if (path.endsWith('/conversations') && body) { data.conversation = { id: body.requestId, version: 1, skill: body.skill, settings: body.settings, assets: [], operations: [], tasks: [] }; return Response.json({ conversation: data.conversation }); }
    if (path.endsWith('/conversations')) return Response.json({ conversations: [] });
    if (options?.method === 'PUT') { data.uploads.push(options); data.conversation.assets.push({ id: crypto.randomUUID(), name: decodeURIComponent(options.headers['X-File-Name']), type: options.headers['Content-Type'].startsWith('audio') ? 'audio' : 'image', purpose: options.headers['X-Asset-Purpose'], url: '/uploaded' }); return Response.json({ conversation: data.conversation }); }
    if (path.endsWith('/script')) { data.scriptCalls++; return Response.json({ error: '不应触发生成' }, { status: 400 }); }
    return Response.json({ conversation: data.conversation });
  };
  return data;
}

test('creative plan exposes material decisions, cast continuity and actionable shots without executing model markup', async t => {
  const data = composerApi(), f = await fixture(t, data.api);
  f.node('#vc-images').onchange({ target:{ files:[new File(['photo'],'餐位.jpg',{type:'image/jpeg'})] } }); await delay(25);
  const id = data.conversation.assets[0].id;
  data.conversation.operations = [{ id:'plan', status:'completed', skill:'store-discovery', settings:DEFAULT_VIDEO_SETTINGS, message:'介绍门店',
    result:{ assets:[{id,role:'真实餐位',adopt:'木桌与灯光',exclude:'不照搬背景人物'}], script:{ title:'门店体验', referenceImageIds:[id],
      plan:{objective:'下班来坐坐',audience:'附近顾客',perspective:'店家展示',storyArc:'查看到放松',visualStyle:'暖光',
        cast:[{name:'演示者',role:'选餐位',appearance:'保持白色衣服'}],audio:{voiceDirection:'自然',music:'轻柔器乐',ambience:'脚步'},keep:['原店布局'],avoid:['<script>bad()</script>']},
      shots:[{start:0,end:25,intent:'看懂餐位',visual:'木桌中景',action:'拉椅坐下',emotion:'放松',sound:'椅脚轻响',referenceIds:[id]}] } } }];
  await f.poll();
  for (const phrase of ['到店理由','下班来坐坐','素材与职责','不照搬背景人物','保持白色衣服','轻柔器乐','看懂餐位','拉椅坐下','椅脚轻响','&lt;script&gt;bad()&lt;/script&gt;']) assert.ok(f.html().includes(phrase),phrase);
  assert.doesNotMatch(f.html(), /<script>bad/);
});

test('changing applied script settings returns to the director while unchanged settings preserve the exact prompt', async t => {
  const data = composerApi(), f = await fixture(t, data.api);
  f.node('#vc-images').onchange({ target:{files:[new File(['photo'],'餐位.jpg',{type:'image/jpeg'})]} }); await delay(25);
  const op = {id:'applied',status:'completed',skill:'store-discovery',settings:{...DEFAULT_VIDEO_SETTINGS},message:'介绍门店',
    result:{script:{title:'原脚本',shots:[],videoPrompt:'原25秒完整提示词',referenceImageIds:data.conversation.assets.map(a=>a.id)}}};
  data.conversation.operations=[op]; await f.poll(); f.action('vc-apply',{id:op.id}); await delay(10);
  const form = f.node('#vc-settings-form');
  form.elements=Object.fromEntries(Object.entries(DEFAULT_VIDEO_SETTINGS).map(([key,value])=>[key,{value:String(value)}]));
  globalThis.FormData = class { constructor(form) { this.form=form; } *[Symbol.iterator]() { for(const [key,item] of Object.entries(this.form.elements)) yield [key,item.value]; } };
  f.action('vc-settings'); form.onsubmit({preventDefault(){}});
  assert.match(f.html(), /视频提示词/); assert.match(f.html(), /原25秒完整提示词/);
  form.elements.duration.value='15'; form.elements.generateAudio.value='false';
  f.action('vc-settings'); form.onsubmit({preventDefault(){}});
  assert.match(f.html(), /编导要求/); assert.match(f.html(), /按当前15秒、中文、静音设置调整上一版脚本/);
  f.action('vc-stage-generation'); assert.doesNotMatch(f.html(), /原25秒完整提示词/);
  f.node('#vc-prompt').input({target:{value:'自主填写的提示词'}});
  f.action('vc-settings'); form.elements.ratio.value='16:9'; form.onsubmit({preventDefault(){}});
  assert.match(f.html(), /自主填写的提示词/); assert.match(f.html(), /视频提示词/);
});

test('composer groups real image, character and voice uploads and keeps drafts when leaving the director', async t => {
  const data = composerApi(), f = await fixture(t, data.api);
  assert.match(f.html(), /退出编导/); assert.match(f.html(), /添加角色/); assert.match(f.html(), /已消耗 0 积分/); assert.match(f.html(), /aria-label="语音输入"/);
  f.action('vc-reference-group', { purpose: 'character' }); assert.equal(f.node('#vc-characters').clicks, 1);
  for (const [input, purpose, name, type] of [['#vc-images','reference','门店.jpg','image/jpeg'], ['#vc-characters','character','角色.jpg','image/jpeg'], ['#vc-audio','voice','参考.mp3','audio/mpeg']]) {
    f.node(input).onchange({ target: { files: [new File(['test'], name, { type })] } }); await delay(20);
    assert.equal(data.uploads.at(-1).headers['X-Asset-Purpose'], purpose);
  }
  assert.equal(data.conversation.assets.length, 3);
  f.action('vc-reference-group', { purpose: 'character' }); assert.equal(f.modal().title, '角色参考'); assert.match(f.modal().content, /角色.jpg/); assert.doesNotMatch(f.modal().content, /门店.jpg/);
  f.node('#vc-message').input({ target: { value: '保留这段编导要求' } });
  f.action('vc-stage-generation'); assert.match(f.html(), /视频提示词/);
  f.action('vc-stage-director'); assert.match(f.html(), /保留这段编导要求/); assert.equal(data.conversation.assets.length, 3);
  data.conversation.operations = [
    { id:'one', status:'completed', message:'一次', billing:{status:'settled',chargedPoints:13}, result:{kind:'clarification',text:'补充',questions:[]} },
    { id:'two', status:'failed', message:'失败', billing:{status:'settled',chargedPoints:2}, error:'失败' },
    { id:'three', status:'settling', message:'核对', billing:{status:'pending',chargedPoints:1000} },
  ];
  await f.poll(); assert.match(f.html(), /已消耗 15 积分 · 核对中/); assert.doesNotMatch(f.html(), /已消耗 1,015/);
  assert.equal(data.scriptCalls, 0);
});

test('voice input keeps final transcripts exactly once, never submits automatically, and preserves text on permission denial', async t => {
  const data = composerApi(), f = await fixture(t, data.api), engines = [];
  globalThis.SpeechRecognition = class {
    constructor() { engines.push(this); }
    start() { this.started = true; }
    stop() { this.onend?.(); }
    abort() { this.aborted = true; this.onend?.(); }
  };
  f.node('#vc-message').input({ target: { value: '原要求' } }); f.action('vc-voice');
  const engine = engines.at(-1); assert.equal(engine.started, true); assert.equal(engine.lang, 'zh-CN'); assert.match(f.html(), /停止语音输入/);
  const result = (text, isFinal) => Object.assign([{ transcript: text }], { isFinal });
  engine.onresult({results:[result('增加门店介绍。',true),result('等',false)]});
  engine.onresult({results:[result('增加门店介绍。',true),result('等一下。',true)]});
  f.action('vc-voice'); assert.match(f.html(), /原要求\n增加门店介绍。等一下。/); assert.doesNotMatch(f.html(), /增加门店介绍。增加/); assert.equal(data.scriptCalls, 0);
  f.action('vc-voice'); engines.at(-1).onerror({error:'not-allowed'});
  assert.match(f.html(), /请允许浏览器使用麦克风/); assert.match(f.html(), /原要求\n增加门店介绍。等一下。/); assert.doesNotMatch(f.html(), /停止语音输入/);
  f.action('vc-voice'); const old = engines.at(-1); f.action('vc-new'); assert.equal(old.aborted, true);
  old.onresult({results:[result('旧录音不得进入新创作',true)]}); assert.doesNotMatch(f.html(), /旧录音不得进入新创作/);
});

test('lost director response retries identical operation and original expected revision after polling receives completed script', async t => {
  let conversation, calls = [], first = true;
  const f = await fixture(t, async (path, options) => {
    const body = options?.body ? JSON.parse(options.body) : null;
    if (path.endsWith('/config')) return Response.json({ directorEnabled: true, generationEnabled: true });
    if (path.endsWith('/quote')) return Response.json({ points: 1000, unlimited: true, affordable: true });
    if (path.endsWith('/tasks')) return Response.json({ tasks: [] });
    if (path.endsWith('/conversations') && body) { conversation = { id: body.requestId, version: 1, skill: body.skill, settings: body.settings, operations: [], tasks: [], assets: [] }; return Response.json({ conversation }); }
    if (path.endsWith('/conversations')) return Response.json({ conversations: [] });
    if (options?.method === 'PUT') { conversation.assets.push({ id: crypto.randomUUID(), type: 'image', name: '实拍', url: '/photo' }); return Response.json({ conversation }); }
    if (path.endsWith('/script')) {
      calls.push(body);
      if (first) { first = false; conversation.version++; conversation.operations.push({ id: body.requestId, status: 'completed', message: body.message, skill: conversation.skill, settings: body.settings,
        result: { kind: 'script', script: { title: '脚本', shots: [], videoPrompt: '真实素材' }, warnings: [] } }); throw new Error('Connection lost after acceptance'); }
      return Response.json({ operation: conversation.operations[0] });
    }
    return Response.json({ conversation });
  });
  f.node('#vc-images').onchange({ target: { files: [new File(['test'], '实拍.jpg', { type: 'image/jpeg' })] } }); await delay(20);
  f.node('#vc-message').input({ target: { value: '介绍门店' } }); f.action('vc-send'); await delay(20);
  assert.match(f.html(), /Connection lost/); await f.poll();
  f.action('vc-send'); await delay(20);
  assert.equal(calls.length, 2); assert.deepEqual(calls[1], calls[0]); assert.equal(calls[1].expectedScriptId, null);
  f.action('vc-apply', { id: calls[0].requestId });
  assert.match(f.html(), /视频提示词/); assert.match(f.html(), /真实素材/); assert.match(f.html(), /Max模型/);
  assert.equal(f.action('vc-send', {}, { ...f.ctx, mode: 'replica' }), false);
});

test('each module uses its own initial request, and switching direction prevents applying another module script', async t => {
  let conversation, sent = [];
  const f = await fixture(t, async (path, options) => {
    const body = options?.body ? JSON.parse(options.body) : null;
    if (path.endsWith('/config')) return Response.json({ directorEnabled: true, generationEnabled: true });
    if (path.endsWith('/quote')) return Response.json({ unlimited: true, affordable: true });
    if (path.endsWith('/tasks')) return Response.json({ tasks: [] });
    if (path.endsWith('/conversations') && body) { conversation = { id: body.requestId, version: 1, skill: body.skill, settings: body.settings, operations: [], tasks: [], assets: [] }; return Response.json({ conversation }); }
    if (path.endsWith('/conversations')) return Response.json({ conversations: [] });
    if (options?.method === 'PATCH') { conversation.skill = body.skill; conversation.version++; return Response.json({ conversation }); }
    if (options?.method === 'PUT') { conversation.assets.push({ id: crypto.randomUUID(), type: 'image', name: '实拍', url: '/photo' }); return Response.json({ conversation }); }
    if (path.endsWith('/script')) {
      sent.push(body); const op = { id: body.requestId, status: 'completed', skill: conversation.skill, message: body.message, settings: body.settings,
        result: { kind: 'script', script: { title: '仅当前方向', summary: '当前方向的内容', shots: [], videoPrompt: conversation.skill + '的脚本' }, warnings: [] } };
      conversation.operations.push(op); return Response.json({ operation: op });
    }
    return Response.json({ conversation });
  });
  for (const [skill, words, placeholder] of [['store-visit', '到店实录', '一次到店体验'], ['signature', '主推产品', '主推哪款'], ['group-buy', '套餐资料', '套餐内容、价格']]) {
    f.action('vc-new'); f.action('vc-skill', { value: skill }); await delay(15);
    assert.match(f.html(), new RegExp(placeholder));
    f.node('#vc-images').onchange({ target: { files: [new File(['photo'], '实拍.jpg', { type: 'image/jpeg' })] } }); await delay(20);
    f.action('vc-send'); await delay(20);
    assert.match(sent.at(-1).message, new RegExp(words));
  }
  const oldOp = conversation.operations[0];
  f.action('vc-skill', { value: 'store-visit' }); await delay(15);
  f.action('vc-apply', { id: oldOp.id }); assert.doesNotMatch(f.html(), /<label for="vc-prompt">/);
  assert.match(f.html(), new RegExp(`data-id="${oldOp.id}" disabled`));
});

test('successful polling clears a recovered connection error without clearing a user action error', async t => {
  let failPoll = false, conversation;
  const f = await fixture(t, async (path, options) => {
    const body = options?.body ? JSON.parse(options.body) : null;
    if (path.endsWith('/config')) return Response.json({ directorEnabled: true, generationEnabled: true });
    if (path.endsWith('/quote')) return Response.json({ unlimited: true, affordable: true });
    if (path.endsWith('/tasks')) { if (failPoll) throw new Error('Temporary connection failure'); return Response.json({ tasks: [] }); }
    if (path.endsWith('/conversations') && body) { conversation = { id: body.requestId, version: 1, skill: body.skill, settings: body.settings, operations: [], tasks: [], assets: [] }; return Response.json({ conversation }); }
    if (path.endsWith('/conversations')) return Response.json({ conversations: [] });
    if (path.endsWith('/script')) return Response.json({ error: '请确认主推产品。' }, { status: 400 });
    return Response.json({ conversation });
  });
  failPoll = true; await f.poll(); assert.match(f.html(), /Temporary connection failure/);
  failPoll = false; await f.poll(); assert.doesNotMatch(f.html(), /Temporary connection failure/);
  f.action('vc-send'); await delay(20); assert.match(f.html(), /请确认主推产品/);
  failPoll = true; await f.poll(); assert.match(f.html(), /请确认主推产品/); assert.doesNotMatch(f.html(), /Temporary connection failure/);
  failPoll = false; await f.poll(); assert.match(f.html(), /请确认主推产品/);
});

test('applying and reopening a video keeps the exact planned images in the editor and generation request', async t => {
  let conversation, op, task, submitted;
  const f = await fixture(t, async (path, options) => {
    const body = options?.body && options?.method !== 'PUT' ? JSON.parse(options.body) : null;
    if (path.endsWith('/config')) return Response.json({ directorEnabled: true, generationEnabled: true });
    if (path.endsWith('/quote')) return Response.json({ unlimited: true, affordable: true });
    if (path.endsWith('/tasks')) return Response.json({ tasks: task ? [task] : [] });
    if (path.endsWith('/conversations') && body) { conversation = { id: body.requestId, version: 1, skill: body.skill, settings: body.settings, operations: [], tasks: [], assets: [] }; return Response.json({ conversation }); }
    if (path.endsWith('/conversations')) return Response.json({ conversations: [] });
    if (options?.method === 'PUT') { const name = decodeURIComponent(options.headers['X-File-Name']); conversation.assets.push({ id: crypto.randomUUID(), name, type: 'image', url: '/'+name }); return Response.json({ conversation }); }
    if (path.endsWith('/script')) { op = { id: body.requestId, status: 'completed', skill: conversation.skill, settings: body.settings, message: body.message,
      result: { kind: 'script', script: { title: '只用产品与环境', shots: [], videoPrompt: '图片1是产品，图片2是环境', referenceImageIds: conversation.assets.slice(1).map(a => a.id) }, warnings: [] } };
      conversation.operations=[op]; return Response.json({ operation: op }); }
    if (path.endsWith('/generate')) { submitted=body; task={id:body.requestId,conversationId:conversation.id,status:'completed',title:'产品',duration:25,createdAt:Date.now(),settings:body.settings,scriptId:op.id,referenceImageIds:body.referenceImageIds,prompt:body.prompt,resultUrl:'/result.mp4'};conversation.tasks=[task];return Response.json({task}); }
    return Response.json({ conversation });
  });
  f.node('#vc-images').onchange({ target: { files: ['person.jpg','food.jpg','space.jpg'].map(n => new File(['photo'],n,{type:'image/jpeg'})) } }); await delay(25);
  f.action('vc-send'); await delay(25); f.action('vc-apply',{id:op.id}); await delay(10);
  assert.doesNotMatch(f.html(), /alt="person.jpg"/); assert.match(f.html(), /alt="food.jpg"/); assert.match(f.html(), /alt="space.jpg"/);
  f.action('vc-generate'); await delay(25); assert.deepEqual(submitted.referenceImageIds,op.result.script.referenceImageIds);
  f.action('vc-new'); f.action('vc-select-task',{id:task.id}); await delay(25);
  assert.doesNotMatch(f.html(), /alt="person.jpg"/);
  f.action('vc-generate'); await delay(25); assert.equal(submitted.scriptId,op.id); assert.deepEqual(submitted.referenceImageIds,op.result.script.referenceImageIds);
});
