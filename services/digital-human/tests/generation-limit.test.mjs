import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("failed/released jobs and module reloads cannot reset the external generation quota", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "generation-limit-test-"));
  const saved = process.env.GENERATION_LIMIT_PATH;
  const clock = Date.now;
  let now = clock();
  process.env.GENERATION_LIMIT_PATH = path.join(tmp, "limits.json");
  Date.now = () => now;
  try {
    const { acquireGenerationSlot } = await import("../src/lib/server/generation-limit.ts");
    const release = acquireGenerationSlot("user-a");
    assert.throws(() => acquireGenerationSlot("user-a"), e => e.status === 429);
    release(); release();
    for (let i = 1; i < 6; i++) acquireGenerationSlot("user-a")();
    assert.throws(() => acquireGenerationSlot("user-a"), e => e.status === 429);
    const restarted = await import("../src/lib/server/generation-limit.ts?restart");
    assert.throws(() => restarted.acquireGenerationSlot("user-a"), e => e.status === 429);
    now += 60 * 60 * 1000 + 1;
    restarted.acquireGenerationSlot("user-a")();
    fs.writeFileSync(process.env.GENERATION_LIMIT_PATH, "corrupt");
    assert.throws(() => restarted.acquireGenerationSlot("user-b"), e => e.status === 503);
  } finally {
    Date.now = clock;
    if (saved === undefined) delete process.env.GENERATION_LIMIT_PATH;
    else process.env.GENERATION_LIMIT_PATH = saved;
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

test("global concurrency and the shared hourly budget also bound multiple external accounts", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "generation-global-test-"));
  const saved = process.env.GENERATION_LIMIT_PATH;
  process.env.GENERATION_LIMIT_PATH = path.join(tmp, "limits.json");
  const releases = [];
  try {
    const { acquireGenerationSlot } = await import("../src/lib/server/generation-limit.ts?global");
    for (let i = 0; i < 4; i++) releases.push(acquireGenerationSlot(`user-${i}`));
    assert.throws(() => acquireGenerationSlot("fifth"), e => e.status === 429);
    releases.forEach(release => release());
    for (let i = 4; i < 30; i++) acquireGenerationSlot(`user-${i}`)();
    assert.throws(() => acquireGenerationSlot("last"), e => e.status === 429);
  } finally {
    releases.forEach(release => release());
    if (saved === undefined) delete process.env.GENERATION_LIMIT_PATH;
    else process.env.GENERATION_LIMIT_PATH = saved;
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

test("internal motion operations retain per-user and global concurrency without consuming external quota", async () => {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"generation-internal-test-"));
  const saved=process.env.GENERATION_LIMIT_PATH;
  process.env.GENERATION_LIMIT_PATH=path.join(tmp,"limits.json");
  const releases=[];
  try {
    const ledger=Array.from({length:30},()=>({userId:"external",at:Date.now()}));
    fs.writeFileSync(process.env.GENERATION_LIMIT_PATH,JSON.stringify(ledger));
    const {acquireGenerationSlot}=await import("../src/lib/server/generation-limit.ts?internal");
    const options={enforceHourlyLimit:false};
    for(let i=0;i<4;i++)releases.push(acquireGenerationSlot(`internal-${i}`,options));
    assert.throws(()=>acquireGenerationSlot("internal-0",options),e=>e.status===429);
    assert.throws(()=>acquireGenerationSlot("internal-fifth",options),e=>e.status===429);
    releases.forEach(release=>release());
    for(let i=0;i<8;i++)acquireGenerationSlot("internal-0",options)();
    assert.deepEqual(JSON.parse(fs.readFileSync(process.env.GENERATION_LIMIT_PATH,"utf8")),ledger);
  } finally {
    releases.forEach(release=>release());
    if(saved===undefined)delete process.env.GENERATION_LIMIT_PATH;else process.env.GENERATION_LIMIT_PATH=saved;
    fs.rmSync(tmp,{recursive:true,force:true});
  }
});
