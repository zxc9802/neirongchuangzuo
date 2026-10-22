import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { validateDirectorResult, createDirectorModel } from '../services/video-creator/model.mjs';
import { DEFAULT_VIDEO_SETTINGS } from '../design/video-catalog.js';
import { parseDirectorOutput } from '../services/video-creator/director-structured-output.mjs';

function sample() {
  const input = { planningVersion: 2, skill: 'store-visit', settings: { ...DEFAULT_VIDEO_SETTINGS, duration: 8 }, history: [], message: '用参考角色演示一次到店体验',
    assets: [{ id: 'unused', type: 'image', purpose: 'reference' }, { id: 'space', type: 'image', purpose: 'reference' },
      { id: 'actor', type: 'image', purpose: 'character' }, { id: 'voice', type: 'audio', purpose: 'voice' }] };
  const output = { kind: 'script', text: '完成编排', warnings: [], assets: [
    { id: 'unused', description: '重复空间', role: '不选用', adopt: '无', exclude: '重复角度' },
    { id: 'space', description: '餐位与灯光', role: '真实空间锚点', adopt: '图片2的木桌与灯光', exclude: '不照搬背景人物' },
    { id: 'actor', description: '人物参考', role: '演示角色', adopt: '图片3的人物外貌', exclude: '人像原背景' },
    { id: 'voice', description: '音色参考', role: '旁白音色', adopt: '只参考音色', exclude: '原始音频台词' }],
    script: { title: '一次轻松的到店选择', summary: '用连续体验串起真实空间', plan: {
      objective: '让附近想安静坐坐的人看懂店内餐位', audience: '下班想找座位的附近顾客', perspective: '店家安排的角色演示',
      storyArc: '好奇查看—选定餐位—放松坐下', visualStyle: '保留图片2暖黄灯光，稳定的中近景',
      cast: [{ name: '演示者', role: '查看并坐到餐位', appearance: '图片3的白色上衣与眼镜', referenceIds: ['actor'] }],
      audio: { voiceDirection: '参考声音音色，平缓自然', music: '轻柔器乐，始终低于口播', ambience: '脚步与椅子移动轻声' },
      keep: ['保留真实餐位关系'], avoid: ['不增加人群或顾客评价'] }, shots: [
        { start: 0, end: 4, intent: '从入口发现可选餐位', visual: '图片2餐位中景，图片3角色走近', action: '走到已有木桌旁', emotion: '好奇', camera: '平稳跟随', referenceIds: ['space','actor'], voiceover: '进来先看看这边', sound: '轻脚步声', caption: '' },
        { start: 4, end: 8, intent: '呈现坐下后的放松体验', visual: '同一木桌近景', action: '自然拉开椅子坐下', emotion: '放松', camera: '切中近景', referenceIds: ['space','actor'], voiceover: '', sound: '椅脚轻响', caption: '看看店内餐位' },
      ] } };
  return { input, output };
}

test('complete JSON with unescaped quoted store names is repaired locally without inventing incomplete data', () => {
  const {output}=sample(); output.text='门头中文"锦湘烤"与拼音"CHAO YAN GE GONG GUAN",落地玻璃，不添加其他店名';
  output.script.plan.keep.push('保留"锦湘烤",不用旁边店名');
  const content=JSON.stringify(output).replaceAll('\\"','"');
  const payload={choices:[{finish_reason:'stop',message:{content:'```json\n'+content+'\n```'}}]};
  const parsed=parseDirectorOutput(payload);
  assert.deepEqual(parsed.value,output); assert.equal(parsed.repair.type,'json_escaping');
  for(const source of ['{"kind": bad value}', '{"kind":"script","script":', '{"kind":"script","shots":[}']) {
    assert.throws(()=>parseDirectorOutput({choices:[{finish_reason:'stop',message:{content:source}}]}));
  }
  assert.throws(()=>parseDirectorOutput({...payload,choices:[{...payload.choices[0],finish_reason:'length'}]}),e=>e.outputIssue==='truncated');
});

test('complete plan, material responsibilities, acting and audio reach the actual video prompt with selected-image numbering', () => {
  const { input, output } = sample(), result = validateDirectorResult(output, input), prompt = result.script.videoPrompt;
  assert.equal(result.script.planningVersion, 2);
  assert.deepEqual(result.script.referenceImageIds, ['space','actor']);
  for (const phrase of ['到店理由：让附近', '目标顾客：下班', '叙事视角：店家', '体验与情绪推进：好奇',
    '采用：图片1的木桌与灯光', '形象保持：图片2的白色上衣与眼镜', '参考图片2', '背景音乐：轻柔', '环境声与拟音：脚步',
    '镜头目的：从入口', '动作与表演：自然拉开椅子坐下', '情绪：放松', '轻脚步声', '保持：保留真实餐位关系',
    '禁止：不增加人群', '声音参考1：旁白音色']) assert.ok(prompt.includes(phrase), phrase);
  assert.doesNotMatch(prompt, /图片3|图片0|重复空间|重复角度/);
  assert.equal((prompt.match(/镜头1｜/g) || []).length, 1);
  assert.equal(result.script.shots[0].visual, output.script.shots[0].visual, 'UI retains upload numbering; compiled prompt uses selected numbering');
});

test('muted planning removes audio instructions, voice reference and shot sound while keeping visual actions', () => {
  const { input, output } = sample(); input.settings.generateAudio = false;
  const result = validateDirectorResult(output, input);
  assert.deepEqual(result.script.plan.audio, { voiceDirection:'', music:'', ambience:'' });
  assert.equal(result.script.shots[0].voiceover, ''); assert.equal(result.script.shots[0].sound, undefined);
  assert.doesNotMatch(result.script.videoPrompt, /轻脚步声|声音参考1|轻柔器乐|进来先看看/);
  assert.match(result.script.videoPrompt, /静音视频/); assert.match(result.script.videoPrompt, /自然拉开椅子坐下/);
});

test('v2 rejects incomplete plans, missing material roles, missing intent and invented or unused cast references', () => {
  for (const [mutate, issue] of [
    [o => { delete o.script.plan; o.script.globalDirection = '暖光'; }, 'invalid_plan'],
    [o => { o.script.plan.storyArc = ''; }, 'invalid_plan'],
    [o => { o.script.plan.cast[0].referenceIds = ['invented']; }, 'invalid_plan'],
    [o => { o.script.plan.cast[0].referenceIds = ['unused']; }, 'invalid_plan'],
    [o => { o.assets.pop(); }, 'invalid_schema'],
    [o => { o.assets[1].adopt = ''; }, 'invalid_schema'],
    [o => { o.assets[0] = o.assets[1]; }, 'invalid_schema'],
    [o => { delete o.script.shots[1].intent; }, 'invalid_schema'],
  ]) {
    const { input, output } = sample(); mutate(output);
    assert.throws(() => validateDirectorResult(output, input), e => e.outputIssue === issue, String(mutate));
  }
  const { input, output } = sample(); delete input.planningVersion; delete output.script.plan;
  output.script.globalDirection = '旧版全片设定'; output.assets = [];
  assert.match(validateDirectorResult(output, input).script.videoPrompt, /旧版全片设定/);
});

test('unused references can have empty adoption details without retrying or entering the video prompt', () => {
  const {input,output}=sample();output.assets[0].adopt='';
  const result=validateDirectorResult(output,input);
  assert.equal(result.assets[0].role,'不选用');assert.equal(result.assets[0].adopt,'');
  assert.deepEqual(result.script.referenceImageIds,['space','actor']);assert.doesNotMatch(result.script.videoPrompt,/重复空间|重复角度/);
  output.assets[1].adopt='';
  assert.throws(()=>validateDirectorResult(output,input),e=>e.outputIssue==='invalid_schema'&&e.validationIssue.includes('space')&&e.validationIssue.includes('adopt'));
});

test('Chinese narration must fit each shot rather than cramming all offer restrictions into the closing seconds', () => {
  const {input,output}=sample();
  output.script.shots[1].voiceover='周一至周四使用，需提前一天预约，不含酒水，查看套餐详情，确认后到店使用。';
  assert.throws(()=>validateDirectorResult(output,input),e=>e.outputIssue==='invalid_voice_timing' && e.validationIssue.includes('minimumDuration'));
  output.script.shots[1].voiceover='需预约，不含酒水。';
  assert.equal(validateDirectorResult(output,input).script.shots.length,2);
});

test('narration redistributes spare time without another model call, dropping restrictions or changing the planned shots', () => {
  const {input,output}=sample(); input.settings.duration=30;
  output.script.shots[0].end=25; output.script.shots[1].start=25; output.script.shots[1].end=30;
  output.script.shots[1].voiceover='周一至周四使用，需提前一天预约，不含酒水，查看套餐详情，确认后到店使用。';
  const result=validateDirectorResult(output,input);
  assert.equal(result.script.timingAdjusted,true); assert.equal(result.script.shots.length,2);
  assert.equal(result.script.shots[0].start,0); assert.equal(result.script.shots[1].end,30);
  assert.equal(result.script.shots[0].end,result.script.shots[1].start);
  assert.ok(result.script.shots[1].end-result.script.shots[1].start>5);
  for(let i=0;i<2;i++) for(const key of ['visual','referenceIds','voiceover','action']) assert.deepEqual(result.script.shots[i][key],output.script.shots[i][key]);
  assert.match(result.script.videoPrompt,/提前一天预约/);
});

test('legacy plan keeps its one-call path and invalid plans get one bounded corrective retry', async t => {
  const root = await mkdtemp(join(tmpdir(), 'director-plan-')); t.after(() => rm(root, { recursive:true, force:true }));
  const path = join(root,'photo.jpg'); await sharp({ create:{ width:80, height:80, channels:3, background:'#625342' } }).jpeg().toFile(path);
  const { input, output } = sample(); input.assets.forEach(a => { a.path = path; a.name = a.id; });
  const config = { apiKey:'test', baseUrl:'https://model.example/v1', imageTextModel:'claude-opus-5-5' };
  for (const broken of [null, 'plan', 'escaping']) {
    const sent = [], attempts = [];
    const model = createDirectorModel({ config, fetchImpl: async (_url, opts) => {
      sent.push(JSON.parse(opts.body)); const value = structuredClone(output);
      if (broken === 'plan' && sent.length === 1) delete value.script.plan.storyArc;
      if (broken === 'escaping') value.text='店名"锦湘烤"';
      const serialized=JSON.stringify(value);
      return Response.json({ choices:[{ message:{ content:broken==='escaping'?serialized.replace('\\"锦湘烤\\"','"锦湘烤"'):serialized }, finish_reason:'stop' }], usage:{ prompt_tokens:5, completion_tokens:5 } });
    } });
    const result = await model.generate(input, { onAttempt: entry => attempts.push(entry) });
    assert.equal(sent.length, broken === 'plan' ? 2 : 1); assert.equal(result.script.plan.cast.length, 1);
    const meta = JSON.parse(sent[0].messages[1].content[0].text); assert.equal(meta.planningVersion, 2);
    assert.match(sent[0].messages[0].content, /合理演示动作/);
    if (broken === 'escaping') { assert.equal(result.text,'店名"锦湘烤"'); assert.equal(attempts.at(-1).formatRepair.type,'json_escaping'); }
    else if (broken) {
      assert.match(sent[1].messages[1].content.at(-1).text, /invalid_plan.*plan.storyArc/);
      assert.equal(attempts.filter(a => a.status === 'failed').length, 1);
    }
  }
});

test('overlong narration repairs only voiceovers and leaves every visual, reference and scene plan intact',async t=>{
  const root=await mkdtemp(join(tmpdir(),'director-narration-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'photo.jpg');await sharp({create:{width:80,height:80,channels:3,background:'#625342'}}).jpeg().toFile(path);
  const {input,output}=sample();input.assets.forEach(a=>{a.path=path;a.name=a.id;});
  output.script.shots[0].voiceover='这一段很长很长的旁白不可能在四秒钟内读完，我们要把店内每一个具体区域的细节都讲出来。';
  const sent=[],attempts=[];
  const model=createDirectorModel({config:{apiKey:'test',baseUrl:'https://model.example/v1',imageTextModel:'claude'},fetchImpl:async(_u,opts)=>{
    sent.push(JSON.parse(opts.body));return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(sent.length===1?output:{voiceovers:['木桌暖灯，坐坐吧','']})}}]});
  }});
  const result=await model.generate(input,{onAttempt:e=>attempts.push(e)});
  assert.equal(sent.length,2);assert.equal(typeof sent[1].messages[1].content,'string');assert.ok(!sent[1].messages[1].content.includes('data:image'));
  assert.equal(result.narrationRepaired,true);assert.equal(result.script.shots[0].visual,output.script.shots[0].visual);
  assert.deepEqual(result.script.shots[0].referenceIds,output.script.shots[0].referenceIds);assert.ok(attempts.some(a=>a.stage==='narration_repair'));
});

test('grounded director runs observation before planning and repairs a rejected promotional draft once',async t=>{
  const root=await mkdtemp(join(tmpdir(),'director-grounding-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'photo.jpg');await sharp({create:{width:80,height:80,channels:3,background:'#625342'}}).jpeg().toFile(path);
  const {input,output}=sample();input.groundingVersion=1;input.assets.forEach(a=>{a.path=path;a.name=a.id;});
  const observations=input.assets.map(a=>({id:a.id,kinds:[a.type==='audio'?'voice':a.purpose==='character'?'character':'scene'],facts:[a.type==='audio'?'音色参考':a.purpose==='character'?'人物肖像':'木桌暖灯'],uncertain:[]}));
  output.script.shots.forEach(s=>{s.evidence=s.referenceIds.map(id=>({assetId:id,factIndexes:[0],use:id==='actor'?'character':'scene'}));});
  const replies=[{observations},output,{passed:false,issues:[{shot:2,reason:'与前一镜头重复，需用餐位细节展示具体特点'}]},output,{passed:true,issues:[]}],sent=[],attempts=[];
  const model=createDirectorModel({config:{apiKey:'test',baseUrl:'https://model.example/v1',imageTextModel:'claude-opus-5-5'},fetchImpl:async(_u,opts)=>{sent.push(JSON.parse(opts.body));return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(replies.shift())}}]});}});
  const result=await model.generate(input,{onAttempt:e=>attempts.push(e)});
  assert.equal(sent.length,5);assert.deepEqual(result.observations,observations);assert.equal(result.quality.passed,true);
  assert.match(sent[3].messages[1].content.at(-1).text,/quality_rejected/);
  assert.equal(attempts.filter(a=>a.stage==='observation'&&a.status==='completed').length,1);
  assert.equal(sent[0].model,'gpt-6-luna');
  assert.equal(sent[0].messages[1].content.filter(p=>p.type==='image_url').length,3);
  assert.deepEqual(JSON.parse(sent[1].messages[1].content[1].text).observations[0].facts,[{index:0,text:observations[0].facts[0]}]);
  for(const body of sent.slice(1)) {
    assert.equal(body.model,'claude-opus-5-5');
    assert.doesNotMatch(JSON.stringify(body),/data:image/);
    assert.match(JSON.stringify(body),/木桌暖灯/);
  }
  assert.ok(attempts.some(a=>a.stage==='planning'&&a.inputImageCount===0&&a.sourceImageCount===3));
});

test('unavailable vision does not proceed to Claude planning and records the actual vision model',async t=>{
  const root=await mkdtemp(join(tmpdir(),'director-vision-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'photo.jpg');await sharp({create:{width:80,height:80,channels:3,background:'#625342'}}).jpeg().toFile(path);
  const input={groundingVersion:1,skill:'store-discovery',settings:DEFAULT_VIDEO_SETTINGS,history:[],message:'门店介绍',assets:[{id:'a',type:'image',purpose:'reference',path}]};
  const calls=[],attempts=[];
  const model=createDirectorModel({config:{apiKey:'test',baseUrl:'https://model.example/v1',imageTextModel:'claude-opus-5-5',videoObservationModel:'configured-vision'},fetchImpl:async(_url,opts)=>{
    calls.push(JSON.parse(opts.body));return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({observations:[{id:'a',kinds:['unknown'],facts:['未收到图片'],uncertain:[]}]})}}]});
  }});
  await assert.rejects(model.generate(input,{onAttempt:e=>attempts.push(e)}),e=>e.code==='DIRECTOR_VISION_UNAVAILABLE');
  assert.equal(calls.length,1);assert.equal(calls[0].model,'configured-vision');assert.equal(attempts.at(-1).model,'configured-vision');
});

test('narration correction receives exact overruns and preserves visuals without rerunning planning',async t=>{
  const root=await mkdtemp(join(tmpdir(),'director-voice-budget-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'photo.jpg');await sharp({create:{width:80,height:80,channels:3,background:'#625342'}}).jpeg().toFile(path);
  const {input,output}=sample();input.assets.forEach(a=>{a.path=path;});
  output.script.shots[0].voiceover='这一段很长很长的旁白不可能在四秒钟内读完，我们要把店内每一个具体区域的细节都讲出来。';
  const responses=[output,{voiceovers:[output.script.shots[0].voiceover,'']},{voiceovers:['木桌暖灯，进来坐坐','']}],sent=[];
  const model=createDirectorModel({config:{apiKey:'test',baseUrl:'https://model.example/v1',imageTextModel:'claude'},fetchImpl:async(_u,o)=>{
    sent.push(JSON.parse(o.body));return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(responses.shift())}}]});
  }});
  const result=await model.generate(input);
  assert.equal(sent.length,3);assert.match(sent[2].messages[1].content,/validationFeedback.*maximum.*actual/);
  assert.equal(result.script.shots[0].visual,output.script.shots[0].visual);assert.equal(result.script.shots[0].voiceover,'木桌暖灯，进来坐坐');
});

test('HTTP 200 audit stream with upstream timeout retries only audit, preserving the approved vision and plan',async t=>{
  const root=await mkdtemp(join(tmpdir(),'director-audit-network-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'photo.jpg');await sharp({create:{width:80,height:80,channels:3,background:'#625342'}}).jpeg().toFile(path);
  const {input,output}=sample();input.groundingVersion=1;input.assets.forEach(a=>{a.path=path;});
  const observations=input.assets.map(a=>({id:a.id,kinds:[a.type==='audio'?'voice':a.purpose==='character'?'character':'scene'],facts:['可见素材事实'],uncertain:[]}));
  output.script.shots.forEach(s=>{s.evidence=s.referenceIds.map(id=>({assetId:id,factIndexes:[0],use:id==='actor'?'character':'scene'}));});
  const sent=[],attempts=[];
  const model=createDirectorModel({config:{apiKey:'test',baseUrl:'https://model.example/v1',imageTextModel:'claude'},fetchImpl:async(_u,o)=>{
    sent.push(JSON.parse(o.body));
    if(sent.length===3)return new Response('data: {"error":{"message":"The upstream service timed out. Please try again later."}}\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
    return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(sent.length===1?{observations}:sent.length===2?output:{passed:true,issues:[]})}}]});
  }});
  const result=await model.generate(input,{onAttempt:a=>attempts.push(a)});
  assert.equal(sent.length,4);assert.deepEqual(sent[2],sent[3]);assert.equal(sent[2].max_tokens,4096);
  assert.equal(new Set(attempts.filter(a=>a.stage==='planning').map(a=>a.attempt)).size,1);
  assert.equal(result.quality.passed,true);assert.equal(result.script.shots[0].visual,output.script.shots[0].visual);
});
