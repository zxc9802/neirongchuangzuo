import test from 'node:test';
import assert from 'node:assert/strict';
import { mapConcurrent } from '../design/async-pool.js';

test('bounded parallel work preserves input order despite reversed completion', async () => {
  let active=0, peak=0;
  const result=await mapConcurrent([30,10,20,5],3,async(ms,index)=>{
    active++;peak=Math.max(peak,active);
    await new Promise(r=>setTimeout(r,ms));active--;return index;
  });
  assert.equal(peak,3);
  assert.deepEqual(result,[0,1,2,3]);
});
test('failure stops scheduling and drains in-flight writes before rejecting',async()=>{
  const started=[],finished=[];
  await assert.rejects(mapConcurrent([0,1,2,3],2,async n=>{
    started.push(n);
    if(n===0)throw new Error('upload failed');
    await new Promise(r=>setTimeout(r,20));finished.push(n);
  }),/upload failed/);
  assert.deepEqual(started,[0,1]);assert.deepEqual(finished,[1]);
});
