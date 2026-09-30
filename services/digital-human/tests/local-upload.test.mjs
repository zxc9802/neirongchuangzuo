import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import test from 'node:test';
import {NextRequest} from 'next/server';
import {getCloneableBody} from 'next/dist/server/body-streams.js';
import {unstable_doesMiddlewareMatch} from 'next/experimental/testing/server';

const cwd=process.cwd(),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'local-upload-test-'));
const keys=['MAIN_APP_SSO_CLIENT_SECRET','APP_SESSION_SECRET','COS_SECRET_ID','COS_SECRET_KEY','DISABLE_SSO'];
const env=Object.fromEntries(keys.map(key=>[key,process.env[key]])),originalFetch=globalThis.fetch;
process.chdir(tmp);
Object.assign(process.env,{MAIN_APP_SSO_CLIENT_SECRET:'test-sso',APP_SESSION_SECRET:'test-session'});
for(const key of ['COS_SECRET_ID','COS_SECRET_KEY','DISABLE_SSO'])delete process.env[key];
globalThis.fetch=async(_url,init)=>{
  const id=new Headers(init?.headers).get('Authorization')?.replace('Bearer ','');
  return Response.json({success:true,data:{user:{id,account:id,nickname:id,role:'member'}}});
};
const {config}=await import('../src/middleware.ts');
const {POST}=await import('../src/app/api/upload/route.ts');
const sso=await import('../src/lib/main-app-sso.ts');
const policy=await import('../src/lib/server/upload-policy.ts');
const matches=url=>unstable_doesMiddlewareMatch({config,url});
async function upload(bytes,user='alice',declaredSize=bytes.length){
  const headers={'Content-Type':'video/mp4','Content-Length':String(declaredSize)};
  if(user){
    const cookie=await sso.createMainAppSessionCookie({token:user,user:{id:user,account:user,nickname:user,role:'member'},expiresAt:Date.now()+60000,validatedAt:Date.now()});
    headers.Cookie=`${sso.getMainAppSessionCookieName()}=${cookie}`;
  }
  const url='http://localhost/api/upload?folder=videos&fileName=large.mp4';
  const stream=Readable.from((function*(){for(let offset=0;offset<bytes.length;offset+=65536)yield bytes.subarray(offset,offset+65536);})());
  // Exercise Next's actual body clone when the real middleware matcher selects this route.
  const body=matches(url)?getCloneableBody(stream).cloneBodyStream():stream;
  const response=await POST(new NextRequest(url,{method:'POST',headers,body:Readable.toWeb(body),duplex:'half'}));
  return {response,data:await response.json()};
}
test.after(()=>{
  globalThis.fetch=originalFetch;process.chdir(cwd);fs.rmSync(tmp,{recursive:true,force:true});
  for(const key of keys){if(env[key]===undefined)delete process.env[key];else process.env[key]=env[key];}
});

test('raw upload bypasses body cloning while upload control endpoints retain middleware',()=>{
  for(const url of ['/api/upload','/api/upload/','/api/upload?folder=videos&fileName=demo.mp4'])assert.equal(matches(url),false,url);
  for(const url of ['/api/upload/direct','/api/upload/complete','/api/upload/other','/api/uploads','/api/motion'])assert.equal(matches(url),true,url);
});

test('an 11 MiB video reaches authenticated local storage intact and remains account scoped',async()=>{
  const bytes=Buffer.alloc(11*1024*1024,91),{response,data}=await upload(bytes);
  assert.equal(response.status,200,JSON.stringify(data));
  const stored=fs.readFileSync(policy.localUploadPath(data.uploadKey));
  const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
  assert.equal(stored.length,bytes.length);assert.equal(hash(stored),hash(bytes));
  assert.equal(policy.getPendingUpload(data.uploadKey,'alice').stored,true);
  assert.equal(policy.getPendingUpload(data.uploadKey,'bob'),null);
});

test('the raw upload route independently rejects anonymous users and incomplete file bodies',async()=>{
  assert.equal((await upload(Buffer.from('video'),null)).response.status,401);
  const {response,data}=await upload(Buffer.from('partial'),'alice',100);
  assert.equal(response.status,400);assert.match(data.error,/上传未完成/);
  assert.equal(data.code,'UPLOAD_CONTENT_MISMATCH');
});
