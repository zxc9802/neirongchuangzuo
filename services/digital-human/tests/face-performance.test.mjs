import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

function load(cos, media) {
  const source = fs.readFileSync(new URL('../src/lib/engine/face-lipsync.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  }}).outputText;
  const dependencies = {fs, path, '../cos': {CosService:cos}, './ffmpeg':media,
    '../server/media-response': {downloadTrustedMediaToFile: async () => {throw new Error('unexpected download');}}};
  const module = {exports:{}};
  new Function('require', 'module', 'exports', compiled)(name => {
    assert.ok(name in dependencies, `Unexpected dependency ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}

test('recovery uploads overlap and all in-flight writes finish before a failure returns', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'face-uploads-'));
  const pending = [];
  let finished = false;
  const api = load({isConfigured:()=>true, uploadFile: (file, key) => new Promise((resolve,reject) => {
    pending.push({key, resolve, reject});
  })}, {execMediaCommand: async ()=>JSON.stringify({durationSeconds:3.9})});
  try {
    const running = api.prepareFaceLipsync({inputVideoPath:'video.mp4', audioPath:'voice.wav',
      durationSeconds:3, jobDir:dir, taskId:'test-task'}).finally(()=>{finished=true;});
    const rejected = assert.rejects(running, /upload failed/);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(pending.length,4, 'all four recovery writes must start together');
    pending[0].reject(new Error('upload failed'));
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(finished,false, 'failed upload must not leave writes racing task cleanup');
    pending.slice(1).forEach(item=>item.resolve());
    await rejected;
  } finally {
    pending.forEach(item=>item.resolve());
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('final video is published only after compositing and encoded-output alignment pass', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'face-final-'));
  let fail = true; const operations = []; const logs = [];
  const api = load({}, {execMediaCommand: async (_command,args) => {
    operations.push(args[1]);
    const request = JSON.parse(fs.readFileSync(args[2],'utf8'));
    if (args[1] === 'composite') return JSON.stringify({elapsedSeconds:12});
    fs.writeFileSync(request.outputPath,'encoded candidate');
    if (fail) throw new Error('LIPSYNC_ALIGNMENT: uncertain match');
    return JSON.stringify({timingsSeconds:{measureBefore:5,encode:4,measureAfter:3}});
  }, probeMedia: async file=>({durationSeconds:3,bytes:fs.statSync(file).size})});
  const params = {jobDir:dir,renderedPath:'rendered.mp4',audioPath:'voice.wav',
    outputPath:path.join(dir,'final.mp4'),onLog:message=>logs.push(message)};
  try {
    await assert.rejects(api.finalizeFaceLipsync(params), /uncertain match/);
    assert.equal(fs.existsSync(params.outputPath),false);
    assert.equal(fs.existsSync(path.join(dir,'face-final-candidate.mp4')),false);
    fail = false;
    const result = await api.finalizeFaceLipsync(params);
    assert.ok(result.bytes>0);
    assert.deepEqual(operations,['composite','align','composite','align']);
    assert.match(logs.at(-1), /成片复核 3 秒/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});


test('legacy and other-provider recovery also checks the encoded candidate without compositing a face crop', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-alignment-'));
  const api = load({}, {execMediaCommand: async (_command, args) => {
    assert.equal(args[1], 'align');
    const request = JSON.parse(fs.readFileSync(args[2], 'utf8'));
    assert.equal(request.videoPath, 'legacy-full-frame.mp4');
    fs.writeFileSync(request.outputPath, 'unreliable candidate');
    throw new Error('LIPSYNC_ALIGNMENT: encoded candidate failed');
  }});
  const outputPath = path.join(dir, 'final.mp4');
  try {
    await assert.rejects(api.finalizeFaceLipsync({jobDir: dir, renderedPath: 'legacy-full-frame.mp4',
      audioPath: 'exact.wav', outputPath, faceWorkflow: false}), {code: 'LIPSYNC_ALIGNMENT'});
    assert.equal(fs.existsSync(outputPath), false);
    assert.equal(fs.existsSync(path.join(dir, 'face-final-candidate.mp4')), false);
  } finally {fs.rmSync(dir, {recursive: true, force: true});}
});
