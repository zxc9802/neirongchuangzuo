import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_VIDEO_SETTINGS, VIDEO_MODELS, VIDEO_IMAGE_MAX_BYTES, VIDEO_AUDIO_MAX_BYTES } from '../design/video-catalog.js';
import { accountStorageKey } from '../design/account-storage.js';

async function fixture(t, api) {
  const names = ['document', 'workspaceUser', 'fetch', 'setInterval', 'clearInterval', 'EventSource', 'SpeechRecognition', 'webkitSpeechRecognition', 'FormData', 'localStorage', 'innerWidth', 'innerHeight'];
  const old = Object.fromEntries(names.map(k => [k, globalThis[k]])), nodes = new Map();
  const node = k => {
    if (!nodes.has(k)) nodes.set(k, { id: k.startsWith('#') ? k.slice(1) : '', clicks: 0, dataset: {}, style: {}, childNodes: [], classList: {add(){},remove(){},toggle(){},contains(){return false;}},
      click() { this.clicks++; }, close() { this.open=false; }, remove(){}, focus(){}, contains(){return false;},
      setAttribute(){}, getBoundingClientRect(){return {left:10,top:40,bottom:60,height:200,width:300};},
      querySelector(){return null;}, querySelectorAll(){return [];},
      addEventListener(type, callback) { if (!['close','click'].includes(type)) this[type] = callback; }
    });
    return nodes.get(k);
  };
  let poll, html, modal;
  globalThis.workspaceUser = { id: crypto.randomUUID() };
  const store=new Map(); globalThis.localStorage={getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v)};
  globalThis.innerWidth=1920;globalThis.innerHeight=900;
  globalThis.document = { body: { dataset: { page: 'video' },append(n){nodes.set('.vc-popover',n);} },
    addEventListener(){},querySelectorAll(){return [];},createElement(){return node('created-'+crypto.randomUUID());},
    querySelector:k=>['#vc-result-video','.vc-conversation','.vc-task-list','#modal[open]'].includes(k)?null:node(k) };

  globalThis.EventSource = undefined;
  globalThis.setInterval = cb => { poll = cb; return 1; }; globalThis.clearInterval = () => {};
  globalThis.fetch = async (path, options) => path === '/api/workspace/credits' ? Response.json({ unlimited: true }) : api(path, options);
  const module = await import('../design/video-creator.js?test=' + crypto.randomUUID());
  const ctx = { esc: x => String(x ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'), icon: () => '', mode: 'video', button: (action, text, _class, attrs = '') => `<button data-action="${action}" ${attrs}>${text}</button>`,
    configs: { video: { prompt: '', files: [] } }, assets: [], toast() {}, openModal(title, _subtitle, content) { modal = { title, content }; }, refresh() { html = module.renderVideoCreator(ctx); } };
  ctx.refresh(); module.bindVideoCreator(ctx);
  t.after(() => { module.disposeVideoCreator(); for (const key of names) { if (old[key] === undefined) delete globalThis[key]; else globalThis[key] = old[key]; } });
  await delay(15);
  return { node, ctx, useMaterial: module.useVideoMaterial, html: () => html, modal: () => modal, popover:()=>node('.vc-popover').innerHTML, action: (name, data = {}, actionContext = ctx) => module.handleVideoCreatorAction(name, { dataset: data, getBoundingClientRect(){return {left:10,top:600,bottom:630};},setAttribute(){} }, actionContext), async poll() { await poll(); await delay(5); } };
}

function composerApi() {
  const data = { conversation: null, scriptCalls: 0, uploads: [], tasks: [] };
  data.api = async (path, options) => {
    if (path === '/uploaded') return new Response('photo', {headers:{'Content-Type':'image/jpeg'}});
    const body = options?.body && options.method !== 'PUT' ? JSON.parse(options.body) : null;
    if (path.endsWith('/config')) return Response.json({ directorEnabled: true, generationEnabled: true });
    if (path.endsWith('/quote')) return Response.json({ points: 1000, affordable: true });
    if (path.endsWith('/tasks')) return Response.json({ tasks: data.tasks });
    if (path.endsWith('/conversations') && body) { data.conversation = { id: body.requestId, version: 1, skill: body.skill, settings: body.settings, assets: [], operations: [], tasks: [] }; return Response.json({ conversation: data.conversation }); }
    if (path.endsWith('/conversations')) return Response.json({ conversations: [] });
    if (options?.method === 'PUT') { data.uploads.push(options); data.conversation.assets.push({ id: crypto.randomUUID(), name: decodeURIComponent(options.headers['X-File-Name']), type: options.headers['Content-Type'].startsWith('audio') ? 'audio' : 'image', purpose: options.headers['X-Asset-Purpose'], url: '/uploaded' }); return Response.json({ conversation: data.conversation }); }
    if (path.endsWith('/script')) { data.scriptCalls++; return Response.json({ error: '不应触发生成' }, { status: 400 }); }
    return Response.json({ conversation: data.conversation });
  };
  return data;
}

test('a completed director script disables empty resubmission and stays applied through polling', async t => {
  const data = composerApi(), base = data.api; let submissions = 0;
  data.api = async (path, options) => {
    if (path.endsWith('/script')) {
      submissions++; const body = JSON.parse(options.body);
      const operation = { id: body.requestId, skill: data.conversation.skill, status: 'completed', settings: body.settings, message: body.message,
        result: { script: { title: '一品厨', videoPrompt: '本轮门店视频', shots: [] } } };
      data.conversation.operations.push(operation); data.conversation.version++;
      return Response.json({ operation });
    }
    return base(path, options);
  };
  const f = await fixture(t, data.api);
  await f.useMaterial(new File(['photo'], '门店.jpg', { type: 'image/jpeg' }), 'photo');
  f.action('vc-send'); await delay(20);
  assert.equal(submissions, 1);
  assert.match(f.html(), /data-action="vc-send"[^>]*disabled/);
  assert.match(f.html(), /应用最新脚本/);
  f.action('vc-send'); await delay(10); assert.equal(submissions, 1);
  f.action('vc-apply', { id: data.conversation.operations[0].id }); await f.poll();
  assert.match(f.html(), /视频提示词/); assert.match(f.html(), /本轮门店视频/);
  f.action('vc-stage-director'); f.node('#vc-message').input({ target: { value: '口播更自然' } });
  assert.equal(f.node('[data-action="vc-send"]').disabled, false);
  f.action('vc-send'); await delay(20); assert.equal(submissions, 2);
});

test('current director completion is not blocked by a slow history list and late queued replies never rewind the editor', async t => {
  const data = composerApi(), base = data.api; let releasePost, releaseHistory, stallHistory = false, operation;
  data.api = async (path, options) => {
    if (path.endsWith('/tasks') && stallHistory) return new Promise(resolve => { releaseHistory = () => resolve(Response.json({ tasks: [] })); });
    if (path.endsWith('/script')) {
      const body = JSON.parse(options.body);
      operation = { id: body.requestId, skill: data.conversation.skill, status: 'queued', message: body.message, settings: body.settings };
      data.conversation.operations.push(operation); data.conversation.version++;
      const queued = structuredClone(operation);
      return new Promise(resolve => { releasePost = () => resolve(Response.json({ operation: queued })); });
    }
    return base(path, options);
  };
  const f = await fixture(t, data.api);
  await f.useMaterial(new File(['photo'], '门店.jpg', { type: 'image/jpeg' }), 'photo');
  f.action('vc-send'); await delay(10);
  Object.assign(operation, { status: 'completed', completedAt: Date.now(), result: { script: { title: '新脚本', videoPrompt: '已完成的分镜', shots: [] } } }); data.conversation.version++;
  stallHistory = true; const polling = f.poll(); await delay(15);
  assert.match(f.html(), /应用最新脚本/);
  f.action('vc-apply', { id: operation.id }); assert.match(f.html(), /已完成的分镜/);
  releasePost(); await delay(15); assert.match(f.html(), /视频提示词/); assert.doesNotMatch(f.html(), /正在分析素材/);
  releaseHistory(); await polling;
});

test('a lost accepted video response recovers the matching task without a second generation request', async t => {
  const data = composerApi(), base = data.api; let operation, generationCalls = 0;
  data.api = async (path, options) => {
    if (path.endsWith('/script')) {
      const body = JSON.parse(options.body);
      operation = { id: body.requestId, skill: data.conversation.skill, status: 'completed', settings: body.settings, message: body.message,
        result: { script: { title: '一品厨', videoPrompt: '顾客到店介绍', shots: [] } } };
      data.conversation.operations.push(operation); return Response.json({ operation });
    }
    if (path.endsWith('/generate')) {
      generationCalls++; const body = JSON.parse(options.body);
      const task = { id: body.requestId, conversationId: data.conversation.id, status: 'running', title: '一品厨', createdAt: Date.now(), settings: body.settings, prompt: body.prompt };
      data.tasks = [task]; data.conversation.tasks = [task]; throw new TypeError('Failed to fetch');
    }
    return base(path, options);
  };
  const f = await fixture(t, data.api);
  await f.useMaterial(new File(['photo'], '门店.jpg', { type: 'image/jpeg' }), 'photo');
  f.action('vc-send'); await delay(15); f.action('vc-apply', { id: operation.id }); await delay(10);
  f.action('vc-generate'); await delay(15); await f.poll();
  assert.equal(generationCalls, 1); assert.match(f.html(), /生成中/); assert.doesNotMatch(f.html(), /Failed to fetch/);
});

test('server expiry replaces a completed cached task instead of retaining an expired video', async t => {
  const data = composerApi();
  data.tasks = [{ id: crypto.randomUUID(), conversationId: crypto.randomUUID(), status: 'completed', title: '到期测试', createdAt: Date.now(), settings: DEFAULT_VIDEO_SETTINGS, resultUrl: '/result.mp4' }];
  const f = await fixture(t, data.api);
  assert.match(f.html(), /title="到期测试 · 已完成"/);
  data.tasks[0] = { ...data.tasks[0], status: 'expired', resultUrl: null };
  await f.poll(); assert.match(f.html(), /title="到期测试 · 已过期"/);
});

test('a full history and favorites do not preload completed video streams', async t => {
  const data = composerApi();
  data.tasks = Array.from({ length: 50 }, (_, i) => ({
    id: crypto.randomUUID(), conversationId: crypto.randomUUID(), referenceImageIds: [crypto.randomUUID()],
    title: '历史视频' + i, status: 'completed', createdAt: Date.now() - i, duration: 30,
    settings: DEFAULT_VIDEO_SETTINGS, resultUrl: '/api/video-creator/tasks/' + crypto.randomUUID() + '/result',
  }));
  const f = await fixture(t, data.api);
  assert.equal((f.html().match(/decoding="async"/g) || []).length, 50);
  assert.doesNotMatch(f.html(), /<video|#t=0\.1/);
  for (const task of data.tasks.slice(0, 10)) f.action('vc-favorite', { id: task.id });
  f.action('vc-preview', { value: 'favorites' });
  assert.equal((f.html().match(/decoding="async"/g) || []).length, 60);
  assert.doesNotMatch(f.html(), /<video|#t=0\.1/);
  assert.match(f.html(), new RegExp(data.tasks[0].conversationId + '/assets/' + data.tasks[0].referenceImageIds[0]));
});

test('saved photos and voices enter the AI video character and voice inputs without generating', async t => {
  const data = composerApi(), f = await fixture(t, data.api);
  await f.useMaterial(new File(['photo'], '形象.jpg', { type: 'image/jpeg' }), 'photo');
  await f.useMaterial(new File(['voice'], '声音.wav', { type: 'audio/wav' }), 'voice');
  assert.deepEqual(data.uploads.map(item => item.headers['X-Asset-Purpose']), ['character', 'voice']);
  assert.equal(data.scriptCalls, 0); assert.equal(data.tasks.length, 0);
});

test('resolution chooser only exposes 720p for every model and legacy scripts require a matching new plan', async t => {
  const data = composerApi(), f = await fixture(t, data.api);
  f.action('vc-settings');
  assert.match(f.popover(), /720p/);
  assert.doesNotMatch(f.popover(), /480p|1080p|<select/);
  f.action('vc-close-popover');
  for (const model of VIDEO_MODELS) {
    f.action('vc-setting-choice',{field:'model',value:model.id});
    f.action('vc-settings'); assert.match(f.popover(),/720p/);assert.doesNotMatch(f.popover(),/480p|1080p/); f.action('vc-close-popover');
  }
  f.node('#vc-images').onchange({ target:{files:[new File(['photo'],'餐位.jpg',{type:'image/jpeg'})]} }); await delay(25);
  data.conversation.operations=[{id:'legacy',status:'completed',skill:'store-discovery',settings:{...DEFAULT_VIDEO_SETTINGS,resolution:'480p'},message:'介绍门店',
    result:{script:{title:'旧版脚本',shots:[],videoPrompt:'旧480p生成提示词',referenceImageIds:data.conversation.assets.map(a=>a.id)}}}];
  await f.poll(); f.action('vc-apply',{id:'legacy'});
  assert.match(f.html(), /编导要求/); assert.match(f.html(), /按720p重新输出上一版完整脚本/);
  f.action('vc-stage-generation'); assert.doesNotMatch(f.html(), /旧480p生成提示词/);
  assert.match(f.html(), /9:16 · 720p/); assert.equal(data.scriptCalls, 0);
});

test('client applies the exclusive 50MB image boundary to both image groups without increasing audio size', async t => {
  const data=composerApi(),f=await fixture(t,data.api);
  const select = async (input,size,type='image/jpeg') => {
    const file=new File(['test'],'素材.'+(type.startsWith('image')?'jpg':'wav'),{type});Object.defineProperty(file,'size',{value:size});
    f.node(input).onchange({target:{files:[file]}});await delay(20);
  };
  await select('#vc-images',VIDEO_IMAGE_MAX_BYTES);assert.equal(data.uploads.length,0);assert.match(f.html(),/小于50MB/);
  await select('#vc-images',VIDEO_IMAGE_MAX_BYTES-1);assert.equal(data.uploads.length,1);
  await select('#vc-characters',VIDEO_IMAGE_MAX_BYTES);assert.equal(data.uploads.length,1);
  await select('#vc-characters',VIDEO_IMAGE_MAX_BYTES-1);assert.equal(data.uploads.length,2);
  await select('#vc-audio',VIDEO_AUDIO_MAX_BYTES+1,'audio/wav');assert.equal(data.uploads.length,2);assert.match(f.html(),/15MB/);
  assert.equal(data.scriptCalls,0);
});

test('changing referenced materials forks the conversation, keeps old scripts intact and deduplicates library copies', async t => {
  const data=composerApi(),f=await fixture(t,data.api);
  f.node('#vc-images').onchange({target:{files:['a.jpg','b.jpg'].map(name=>new File(['photo'],name,{type:'image/jpeg'}))}});await delay(30);
  const original=data.conversation;
  original.operations=[{id:'original-script',skill:'store-discovery',status:'completed',settings:DEFAULT_VIDEO_SETTINGS,message:'原方案',result:{script:{title:'原方案',shots:[],videoPrompt:'@图片1 @图片2'}}}];
  await f.poll();
  f.action('vc-reference-group',{purpose:'reference'});
  f.action('vc-library-toggle',{id:original.assets[0].id});
  f.action('vc-confirm-library');await delay(50);
  assert.notEqual(data.conversation.id,original.id);assert.equal(data.conversation.assets.length,1);assert.equal(data.conversation.assets[0].name,'b.jpg');
  assert.equal(original.assets.length,2);assert.equal(original.operations[0].id,'original-script');
  f.action('vc-reference-group',{purpose:'reference'});
  assert.equal((f.node('#vc-library-grid').innerHTML.match(/data-action="vc-library-toggle"/g)||[]).length,2);
  assert.equal(data.scriptCalls,0);
});

test('unsubmitted director and generation drafts survive new creation and reopen with the same settings and references', async t => {
  const data = composerApi(), f = await fixture(t, data.api);
  f.node('#vc-images').onchange({target:{files:[new File(['photo'],'门头.jpg',{type:'image/jpeg'})]}}); await delay(25);
  f.node('#vc-message').input({target:{value:'门头之后展示@图片1'}});
  f.action('vc-stage-generation'); f.node('#vc-prompt').input({target:{value:'手工调整的镜头 @图片1'}});
  const key = accountStorageKey('video-creator-ui-drafts');
  const draft = JSON.parse(localStorage.getItem(key))[0];
  assert.equal(draft.input,'门头之后展示@图片1'); assert.equal(draft.stage,'generation');
  f.action('vc-new'); assert.match(f.html(),/打开草稿/);
  f.action('vc-open-local-draft',{id:draft.id}); await delay(25);
  assert.match(f.html(),/手工调整的镜头/); assert.match(f.html(),/720p/);
  f.action('vc-stage-director'); assert.match(f.html(),/门头之后展示/);
  assert.equal(data.scriptCalls,0);
});

test('inline removal preserves wording, marks removed references and leaves old conversation intact', async t => {
  const data = composerApi(), f = await fixture(t, data.api);
  f.node('#vc-images').onchange({target:{files:['a.jpg','b.jpg'].map(name=>new File(['photo'],name,{type:'image/jpeg'}))}}); await delay(25);
  const old = data.conversation;
  f.node('#vc-message').input({target:{value:'先@图片1，再@图片2，保持原计划'}});
  f.action('vc-inline-remove',{id:old.assets[0].id}); await delay(35);
  assert.equal(old.assets.length,2); assert.equal(data.conversation.assets.length,1);
  assert.match(f.html(),/\[已移除图片1\]/); assert.match(f.html(),/保持原计划/);
  assert.match(f.html(),/data-action="vc-send"[^>]*disabled/);
  const draft = JSON.parse(localStorage.getItem(accountStorageKey('video-creator-ui-drafts')))[0];
  assert.equal(draft.input,'先[已移除图片1]，再@图片1，保持原计划');
});

test('failed material replacement leaves the previous draft and references available', async t => {
  const data = composerApi(), base = data.api; let fail = false;
  data.api = (path, options) => fail && options?.method === 'PUT' ? Response.json({error:'上传失败'},{status:500}) : base(path, options);
  const f = await fixture(t, data.api);
  f.node('#vc-images').onchange({target:{files:['a.jpg','b.jpg'].map(name=>new File(['photo'],name,{type:'image/jpeg'}))}}); await delay(25);
  const original = data.conversation;
  f.node('#vc-message').input({target:{value:'不要丢失 @图片2'}}); fail = true;
  f.action('vc-inline-remove',{id:original.assets[0].id}); await delay(35);
  const draft = JSON.parse(localStorage.getItem(accountStorageKey('video-creator-ui-drafts')))[0];
  assert.equal(draft.conversationId,original.id); assert.equal(draft.input,'不要丢失 @图片2');
  assert.match(f.html(),/上传失败/); assert.match(f.html(),/预览 a.jpg/); assert.match(f.html(),/预览 b.jpg/);
});

test('favorites and recoverable task removal are browser presentation changes and never delete server tasks', async t => {
  const data=composerApi(),f=await fixture(t,data.api),task={id:'finished',conversationId:'saved',status:'completed',title:'验收视频',duration:30,createdAt:Date.now(),settings:DEFAULT_VIDEO_SETTINGS,resultUrl:'/result.mp4'};
  data.tasks=[task];await f.poll();
  f.action('vc-favorite',{id:task.id});f.action('vc-preview',{value:'favorites'});assert.match(f.html(),/取消收藏 验收视频/);
  f.action('vc-hide-task',{id:task.id});assert.match(f.modal().content,/当前浏览器列表/);
  f.action('vc-confirm-hide',{kind:'task',id:task.id});assert.doesNotMatch(f.html(),/data-action="vc-select-task"[^>]*data-id="finished"/);assert.equal(data.tasks.length,1);
  f.action('vc-restore-record',{kind:'task',id:task.id});assert.match(f.html(),/data-action="vc-select-task"[^>]*data-id="finished"/);assert.equal(data.tasks.length,1);
});

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
  f.action('vc-setting-choice',{field:'language',value:'zh'});
  assert.match(f.html(), /视频提示词/); assert.match(f.html(), /原25秒完整提示词/);
  f.action('vc-setting-choice',{field:'generateAudio',value:'false'});
  assert.match(f.html(), /编导要求/); assert.match(f.html(), /按当前25秒、中文、静音设置调整上一版脚本/);
  f.action('vc-stage-generation'); assert.doesNotMatch(f.html(), /原25秒完整提示词/);
  f.node('#vc-prompt').childNodes=[{nodeType:3,nodeValue:'自主填写的提示词'}];f.node('#vc-prompt').input();
  f.action('vc-setting-choice',{field:'ratio',value:'16:9'});
  assert.match(f.html(), /自主填写的提示词/); assert.match(f.html(), /视频提示词/);

});

test('composer groups real image, character and voice uploads and keeps drafts when leaving the director', async t => {
  const data = composerApi(), f = await fixture(t, data.api);
  assert.match(f.html(), /退出编导/); assert.match(f.html(), /添加角色/); assert.match(f.html(), /已消耗 0 积分/); assert.match(f.html(), /aria-label="语音输入"/);
  f.action('vc-reference-group', { purpose: 'character' }); assert.equal(f.modal().title,'选择素材'); f.action('vc-library-upload'); assert.equal(f.node('#vc-characters').clicks,1);
  for (const [input, purpose, name, type] of [['#vc-images','reference','门店.jpg','image/jpeg'], ['#vc-characters','character','角色.jpg','image/jpeg'], ['#vc-audio','voice','参考.mp3','audio/mpeg']]) {
    f.node(input).onchange({ target: { files: [new File(['test'], name, { type })] } }); await delay(20);
    assert.equal(data.uploads.at(-1).headers['X-Asset-Purpose'], purpose);
  }
  assert.equal(data.conversation.assets.length, 3);
  f.action('vc-reference-group', { purpose: 'character' }); assert.equal(f.modal().title, '选择素材'); assert.match(f.node('#vc-library-grid').innerHTML, /角色.jpg/); assert.doesNotMatch(f.node('#vc-library-grid').innerHTML, /门店.jpg/); f.action('vc-cancel-library');
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
  f.action('vc-voice'); assert.match(f.html(), /原要求<br>增加门店介绍。等一下。/); assert.doesNotMatch(f.html(), /增加门店介绍。增加/); assert.equal(data.scriptCalls, 0);
  f.action('vc-voice'); engines.at(-1).onerror({error:'not-allowed'});
  assert.match(f.html(), /请允许浏览器使用麦克风/); assert.match(f.html(), /原要求<br>增加门店介绍。等一下。/); assert.doesNotMatch(f.html(), /停止语音输入/);
  f.action('vc-voice'); const old = engines.at(-1); f.action('vc-new'); assert.equal(old.aborted, true);
  old.onresult({results:[result('旧录音不得进入新创作',true)]}); assert.doesNotMatch(f.html(), /旧录音不得进入新创作/);
});

test('lost director response retries identical operation and original expected revision after polling receives completed script', async t => {
  let conversation, calls = [], first = true;
  const f = await fixture(t, async (path, options) => {
    const body = options?.body && options.method !== 'PUT' ? JSON.parse(options.body) : null;
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
  assert.match(f.html(), /Connection lost/);
  f.action('vc-send'); await delay(20);
  await f.poll(); assert.equal(calls.length, 2); assert.deepEqual(calls[1], calls[0]); assert.equal(calls[1].expectedScriptId, null);
  f.action('vc-apply', { id: calls[0].requestId });
  assert.match(f.html(), /视频提示词/); assert.match(f.html(), /真实素材/); assert.match(f.html(), /video-max/);
  assert.equal(f.action('vc-send', {}, { ...f.ctx, mode: 'replica' }), false);
});

test('each module uses its own initial request, and switching direction prevents applying another module script', async t => {
  let conversation, sent = [];
  const f = await fixture(t, async (path, options) => {
    const body = options?.body && options.method !== 'PUT' ? JSON.parse(options.body) : null;
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
    assert.match(f.html(), /分析素材，并生成脚本/);
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
    const body = options?.body && options.method !== 'PUT' ? JSON.parse(options.body) : null;
    if (path.endsWith('/config')) return Response.json({ directorEnabled: true, generationEnabled: true });
    if (path.endsWith('/quote')) return Response.json({ unlimited: true, affordable: true });
    if (path.endsWith('/tasks')) { if (failPoll) throw new Error('Temporary connection failure'); return Response.json({ tasks: [] }); }
    if (path.endsWith('/conversations') && body) { conversation = { id: body.requestId, version: 1, skill: body.skill, settings: body.settings, operations: [], tasks: [], assets: [] }; return Response.json({ conversation }); }
    if (path.endsWith('/conversations')) return Response.json({ conversations: [] });
    if (options?.method === 'PUT') { conversation.assets.push({ id: crypto.randomUUID(), name: '实拍.jpg', type: 'image', url: '/photo' }); return Response.json({ conversation }); }
    if (path.endsWith('/script')) return Response.json({ error: '请确认主推产品。' }, { status: 400 });
    return Response.json({ conversation });
  });
  failPoll = true; await f.poll(); assert.match(f.html(), /Temporary connection failure/);
  failPoll = false; await f.poll(); assert.doesNotMatch(f.html(), /Temporary connection failure/);
  await f.useMaterial(new File(['photo'], '实拍.jpg', { type: 'image/jpeg' }), 'photo');
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
  assert.doesNotMatch(f.html(), /alt="person.jpg"/); assert.match(f.html(), /alt="food.jpg"/); assert.match(f.html(), /2<\/span>/);
  f.action('vc-generate'); await delay(25); assert.deepEqual(submitted.referenceImageIds,op.result.script.referenceImageIds);
  f.action('vc-new'); f.action('vc-select-task',{id:task.id}); await delay(25);
  assert.doesNotMatch(f.html(), /alt="person.jpg"/);
  f.action('vc-generate'); await delay(25); assert.equal(submitted.scriptId,op.id); assert.deepEqual(submitted.referenceImageIds,op.result.script.referenceImageIds);
});
