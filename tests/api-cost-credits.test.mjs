import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { createCreditsLedger } from '../services/credits/store.mjs';
import { costPoints } from '../services/credits/costs.mjs';

async function fixture(t,pool) {
  const root=await mkdtemp(join(tmpdir(),'qiya-cost-')), handles=[];
  const open=()=>{const x=createCreditsLedger({storageDir:root,databaseUrl:null,costMode:true,pool});handles.push(x);return x;};
  t.after(async()=>{await Promise.all(handles.map(x=>x.close()));assert.ok(resolve(root).startsWith(resolve(tmpdir())));await rm(root,{recursive:true,force:true});});
  const ledger=open();await ledger.ready;return {ledger,open};
}
const scope={userId:'alice',taskId:'task'};
async function charged(ledger,scope,amount,id='receipt') {
  await ledger.reserveCost(scope);
  await ledger.prepareCostCall({...scope,receiptId:id,provider:'test',quoteCny:Math.max(amount,0.008)});
  await ledger.finishCostCall({...scope,receiptId:id,costCny:amount});
  return ledger.settleCost(scope);
}

test('8 CNY converts to exactly 1000 points; fractional CNY is preserved',()=>{
  assert.equal(costPoints(8),1000);assert.equal(costPoints(1),125);assert.equal(costPoints(0.148325),19);
  assert.throws(()=>costPoints(NaN));assert.throws(()=>costPoints(-1));
});
test('confirmed expense settles once and welcome grant is not reset',async t=>{
  const {ledger}=await fixture(t);const result=await charged(ledger,scope,8);
  assert.equal(result.chargedPoints,1000);assert.equal((await ledger.snapshot('alice')).available,0);
  assert.equal((await ledger.settleCost(scope)).chargedPoints,1000);
  assert.equal((await ledger.reserveCost(scope)).status,'settled');
});
test('small expenses accumulate across tasks and survive local restart',async t=>{
  const {ledger,open}=await fixture(t);let points=0;
  for(let i=0;i<4;i++)points+=(await charged(ledger,{...scope,taskId:'tiny-'+i},0.001)).chargedPoints;
  await ledger.close();const again=open();await again.ready;
  for(let i=4;i<8;i++)points+=(await charged(again,{...scope,taskId:'tiny-'+i},0.001)).chargedPoints;
  assert.equal(points,1);assert.equal((await again.snapshot('alice')).available,999);
});
test('overlapping holds prevent overspend and cancellation releases only unused quotes',async t=>{
  const {ledger}=await fixture(t);await ledger.reserveCost(scope);
  await ledger.prepareCostCall({...scope,receiptId:'a',provider:'test',quoteCny:5});
  await assert.rejects(ledger.prepareCostCall({...scope,receiptId:'b',provider:'test',quoteCny:4}),{code:'INSUFFICIENT_POINTS'});
  await ledger.finishCostCall({...scope,receiptId:'a',costCny:1});
  await ledger.prepareCostCall({...scope,receiptId:'b',provider:'test',quoteCny:7});
  await ledger.finishCostCall({...scope,receiptId:'b',costCny:0});
  assert.equal((await ledger.release(scope)).chargedPoints,125);
  assert.equal((await ledger.snapshot('alice')).available,875);
});
test('unknown provider expense cannot be refunded; later confirmation is idempotent',async t=>{
  const {ledger}=await fixture(t);await ledger.reserveCost(scope);
  await ledger.prepareCostCall({...scope,receiptId:'a',provider:'test',quoteCny:2});
  await ledger.finishCostCall({...scope,receiptId:'a',uncertain:true,providerRequestId:'remote-a'});
  await ledger.finishCostCall({...scope,receiptId:'a',uncertain:true,providerRequestId:'remote-a'});
  await assert.rejects(ledger.release(scope),{code:'COST_CONFIRMATION_PENDING'});
  await ledger.finishCostCall({...scope,receiptId:'a',costCny:1,providerRequestId:'remote-a'});
  await ledger.finishCostCall({...scope,receiptId:'a',costCny:1,providerRequestId:'remote-a'});
  await assert.rejects(ledger.finishCostCall({...scope,receiptId:'a',costCny:2}),{code:'CREDITS_REQUEST_CONFLICT'});
  assert.equal((await ledger.settleCost(scope)).chargedPoints,125);
});
test('unexpected provider overrun is saved even when funds cannot cover it',async t=>{
  const {ledger}=await fixture(t);await ledger.reserveCost(scope);
  await ledger.prepareCostCall({...scope,receiptId:'a',provider:'test',quoteCny:8});
  const actual=await ledger.finishCostCall({...scope,receiptId:'a',costCny:9});
  assert.equal(actual.shortfallPoints,125);assert.equal(actual.costItems.a.costMicros,9_000_000);
  await assert.rejects(ledger.settleCost(scope),{code:'INSUFFICIENT_POINTS'});
});
test('duration quotes extend atomically, preserve funds on rejection and cannot reopen settled calls',async t=>{
  const {ledger}=await fixture(t);await ledger.reserveCost(scope);
  await ledger.prepareCostCall({...scope,receiptId:'duration',provider:'digital-human',quoteCny:1});
  await ledger.extendCostCall({...scope,receiptId:'duration',quoteCny:3});
  assert.equal((await ledger.snapshot('alice')).held,375);
  await assert.rejects(ledger.extendCostCall({...scope,receiptId:'duration',quoteCny:9}),{code:'INSUFFICIENT_POINTS'});
  assert.equal((await ledger.reservation('alice','task')).costItems.duration.quoteMicros,3_000_000);
  await ledger.finishCostCall({...scope,receiptId:'duration',costCny:2});
  assert.equal((await ledger.settleCost(scope)).chargedPoints,250);
  await assert.rejects(ledger.extendCostCall({...scope,receiptId:'duration',quoteCny:3}),{code:'CREDITS_REQUEST_CONFLICT'});
});
test('legacy image reservations remain readable and settle at their original tariff',async t=>{
  const {ledger,open}=await fixture(t);await ledger.reserve({...scope,kind:'image',units:2});
  await ledger.close();const again=open();await again.ready;
  assert.equal((await again.settle({...scope,units:1})).chargedPoints,50);
  assert.equal((await again.snapshot('alice')).available,950);
});
test('PostgreSQL locks keep concurrent tiny expenses and mixed old reservations consistent',async t=>{
  const db=new PGlite();t.after(()=>db.close());const pool={connect:async()=>({query:(s,p)=>!p?.length&&s.includes(';')?db.exec(s).then(r=>r.at(-1)):db.query(s,p),release(){}})};
  const {ledger}=await fixture(t,pool);
  for(let i=0;i<8;i++)await charged(ledger,{...scope,taskId:'sql-'+i},0.001);
  assert.equal((await ledger.snapshot('alice')).available,999);
  await ledger.reserve({...scope,taskId:'old',kind:'image',units:2});
  await ledger.settle({...scope,taskId:'old',units:2});
  assert.equal((await ledger.snapshot('alice')).available,899);
});

test('PostgreSQL receipt timing updates never insert the uncertain ledger event twice',async t=>{
  const db=new PGlite();t.after(()=>db.close());const pool={connect:async()=>({query:(s,p)=>!p?.length&&s.includes(';')?db.exec(s).then(r=>r.at(-1)):db.query(s,p),release(){}})};
  const {ledger}=await fixture(t,pool);await ledger.reserveCost(scope);
  await ledger.prepareCostCall({...scope,receiptId:'stream',provider:'openlux',quoteCny:.1,metadata:{group:'auto',model:'gpt',startedAt:1000}});
  await ledger.finishCostCall({...scope,receiptId:'stream',uncertain:true,providerRequestId:'stream-id'});
  const before=(await db.query('SELECT count(*)::int AS n FROM workspace_credits.ledger')).rows[0].n;
  await ledger.finishCostCall({...scope,receiptId:'stream',uncertain:true,providerRequestId:'stream-id',responseAt:2000});
  await ledger.finishCostCall({...scope,receiptId:'stream',uncertain:true,providerRequestId:'stream-id',responseAt:3000});
  assert.equal((await db.query('SELECT count(*)::int AS n FROM workspace_credits.ledger')).rows[0].n,before);
  assert.equal((await ledger.reservation(scope.userId,scope.taskId)).costItems.stream.responseAt,2000);
  await ledger.finishCostCall({...scope,receiptId:'stream',providerRequestId:'stream-id',costCny:.008,evidence:{quota:400,logIds:'42',groups:'routed-group'}});
  assert.equal((await ledger.settleCost(scope)).chargedPoints,1);
  assert.equal((await ledger.settleCost(scope)).chargedPoints,1);
});
