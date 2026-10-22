import test from 'node:test';
import assert from 'node:assert/strict';
import { validateObservations, validateGrounding, applyNarrationRepair, validateQuality } from '../services/video-creator/director-quality.mjs';
import { balanceNarrationTiming } from '../services/video-creator/director-plan.mjs';
test('poster evidence cannot claim real food; generic production notes cannot become public copy',()=>{
  const observations=[{id:'poster',kinds:['poster'],facts:['墙面菜品海报'],uncertain:[]}];
  const script={kind:'script',script:{shots:[{referenceIds:['poster'],visual:'墙上菜单',evidence:[{assetId:'poster',use:'food',factIndexes:[0]}]}]}};
  assert.throws(()=>validateGrounding(script,observations),e=>e.outputIssue==='invalid_evidence');
  script.script.shots[0].evidence[0].use='poster';validateGrounding(script,observations);
  script.script.shots[0].caption='产品展示区';assert.throws(()=>validateGrounding(script,observations),e=>e.outputIssue==='internal_copy');
  script.script.shots[0].caption='';script.script.shots[0].evidence[0].factIndexes=[99];assert.throws(()=>validateGrounding(script,observations));
});
test('observation contract rejects missing, duplicate, unsupported kinds and false role metadata',()=>{
  const input={assets:[{id:'photo',type:'image',purpose:'character'}]};
  for(const rows of [[],[{id:'photo',kinds:['scene'],facts:['空间'],uncertain:[]}],[{id:'unknown',kinds:['character'],facts:['人物'],uncertain:[]}]] )assert.throws(()=>validateObservations({observations:rows},input));
});
test('a blind vision response stops explicitly instead of manufacturing a script from file names',()=>{
  assert.throws(()=>validateObservations({observations:[{id:'photo',kinds:['unknown'],facts:['看不到图片'],uncertain:[]}]},{assets:[{id:'photo',type:'image'}]}),e=>e.code==='DIRECTOR_VISION_UNAVAILABLE');
});
test('English and Malay narration use word budgets and still reject speech that cannot fit',()=>{
  const shots=[{start:0,end:3,voiceover:'This very long sentence cannot possibly fit into only three seconds without rushing the entire message'}];
  for(const language of ['en','ms']) {
    const input={planningVersion:2,settings:{language,duration:3,generateAudio:true}};
    assert.throws(()=>balanceNarrationTiming(shots,input,(message,issue)=>Object.assign(new Error(message),{issue})),e=>e.issue==='invalid_voice_timing');
    const value={script:{shots}};assert.equal(applyNarrationRepair(value,{voiceovers:['Warm lights, wooden tables.']},input).script.shots[0].voiceover,'Warm lights, wooden tables.');
  }
});
test('narration cannot silently remove mandatory offer terms and requests more duration if necessary',()=>{
  const value={kind:'script',offerFacts:{conditions:{value:'需预约，不含酒水'}},script:{shots:[{start:0,end:5,visual:'环境',voiceover:'需预约，不含酒水'}]}};
  const input={skill:'group-buy',settings:{language:'zh'}};
  assert.throws(()=>applyNarrationRepair(value,{voiceovers:['来店里看看']},input),e=>e.outputIssue==='invalid_voice_repair');
  assert.equal(applyNarrationRepair(value,{needsClarification:true},input).kind,'clarification');
  assert.equal(applyNarrationRepair(value,{voiceovers:['需预约，不含酒水']},input).script.shots[0].visual,'环境');
  assert.throws(()=>validateQuality({passed:true,issues:[{shot:1,reason:'矛盾'}]}));
});
