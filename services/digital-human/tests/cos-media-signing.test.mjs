import assert from 'node:assert/strict';
import test from 'node:test';
Object.assign(process.env, {COS_SECRET_ID:'test-access-id', COS_SECRET_KEY:'test-signing-key',
  COS_BUCKET:'test-bucket-12345', COS_REGION:'ap-singapore'});
const {CosService} = await import('../src/lib/cos.ts');

test('private playback and download signatures preserve disposition, type, HTTPS and method', async () => {
  const key='jobs/test_task/preview.mp4';
  const preview=new URL(await CosService.getDownloadUrl(key,undefined,30,{inline:true,contentType:'video/mp4'}));
  const download=new URL(await CosService.getDownloadUrl(key,'digital-human-video.mp4',30));
  const head=new URL(await CosService.getDownloadUrl(key,undefined,30,{inline:true,contentType:'video/mp4',method:'HEAD'}));
  assert.equal(preview.protocol,'https:');
  assert.equal(preview.searchParams.get('response-content-disposition'),'inline; filename="preview.mp4"');
  assert.equal(preview.searchParams.get('response-content-type'),'video/mp4');
  assert.equal(download.searchParams.get('response-content-disposition'),'attachment; filename="digital-human-video.mp4"');
  assert.notEqual(preview.searchParams.get('q-signature'),head.searchParams.get('q-signature'));
  assert.equal(CosService.getManagedObjectKey(preview.href),key);
});
