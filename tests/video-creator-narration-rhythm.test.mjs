import test from 'node:test';
import assert from 'node:assert/strict';
import { narrationTarget, narrationDirection } from '../services/video-creator/narration-budget.mjs';
import { balanceNarrationTiming } from '../services/video-creator/director-plan.mjs';
import { applyNarrationRepair } from '../services/video-creator/director-quality.mjs';
const input={planningVersion:2,settings:{duration:30,language:'zh',generateAudio:true}};
const fail=(message,issue)=>Object.assign(new Error(message),{issue});
test('150 Chinese characters across 30 seconds survive timing and corrective repair without dilution',()=>{
 const line='想找个地方和朋友坐坐这里有咖啡和简餐来看看';
 const voice=(line.repeat(2)).slice(0,25);
 const shots=Array.from({length:6},(_,i)=>({start:i*5,end:(i+1)*5,voiceover:voice,visual:'原实拍画面',referenceIds:['original']}));
 assert.equal(voice.length*shots.length,150);
 assert.deepEqual(balanceNarrationTiming(shots,input,fail),shots);
 const repaired=applyNarrationRepair({script:{shots}}, {voiceovers:shots.map(s=>s.voiceover)},input);
 assert.deepEqual(repaired.script.shots,shots);
 assert.throws(()=>balanceNarrationTiming(shots.map(s=>({...s,voiceover:voice.repeat(2)})),input,fail),e=>e.issue==='invalid_voice_timing');
});
test('spoken targets scale with duration and are absent for muted and non-Chinese video',()=>{
 assert.deepEqual(narrationTarget(input.settings),{min:140,max:160});
 assert.deepEqual(narrationTarget({...input.settings,duration:15}),{min:70,max:80});
 assert.equal(narrationDirection({...input.settings,generateAudio:false}),'');
 assert.equal(narrationTarget({...input.settings,language:'en'}),null);
});
