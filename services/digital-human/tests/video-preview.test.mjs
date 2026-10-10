import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execMediaCommand, probeMedia, sha256File } from '../src/lib/engine/ffmpeg.ts';
import { createVideoPreview } from '../src/lib/engine/video-preview.ts';
import { isGeneratedTaskFile } from '../src/lib/task-output-retention.ts';

test('preview reduces bytes while preserving duration, audio, and original video', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-preview-'));
  t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
  const source = path.join(dir,'final.mp4');
  await execMediaCommand('ffmpeg', ['-v','error','-y','-f','lavfi','-i','testsrc2=size=1080x1920:rate=30',
    '-f','lavfi','-i','sine=frequency=300:sample_rate=24000','-t','2','-c:v','libx264','-preset','ultrafast',
    '-crf','18','-c:a','aac','-movflags','+faststart',source]);
  const hash = await sha256File(source);
  const result = await createVideoPreview(source);
  assert.ok(result);
  const info = await probeMedia(result);
  assert.equal(info.width,720); assert.equal(info.height,1280);
  assert.ok(Math.abs(info.durationSeconds-2)<0.05);
  assert.ok(fs.statSync(result).size < fs.statSync(source).size*0.65);
  assert.equal(await sha256File(source),hash);
  for (const [name,input] of [['source',source],['preview',result]]) {
    await execMediaCommand('ffmpeg',['-v','error','-y','-i',input,'-map','0:a:0','-c:a','copy',path.join(dir,name+'.aac')]);
  }
  assert.equal(await sha256File(path.join(dir,'source.aac')),await sha256File(path.join(dir,'preview.aac')));
  const bytes=fs.readFileSync(result);
  assert.ok(bytes.indexOf(Buffer.from('moov')) < bytes.indexOf(Buffer.from('mdat')));
  assert.equal(isGeneratedTaskFile('preview.mp4'),true);
  assert.equal(await createVideoPreview(path.join(dir,'missing.mp4')),undefined,'optional preview failure must not fail generation');
});
