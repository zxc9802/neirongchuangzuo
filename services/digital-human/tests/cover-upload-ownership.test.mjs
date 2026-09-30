import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import test from "node:test";
import {NextRequest} from "next/server";

const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cover-upload-owner-"));
process.chdir(tmp);
process.env.DISABLE_SSO = "true";
process.env.NODE_ENV = "development";
delete process.env.COS_SECRET_ID;
delete process.env.COS_SECRET_KEY;
test.after(() => {process.chdir(cwd); fs.rmSync(tmp, {recursive:true, force:true});});

test("server-generated covers keep the same owner as the video in local mode", async () => {
  const {AvatarStore} = await import("../src/lib/store/avatar-store.ts");
  const {localUploadPath, ownerKeyFor} = await import("../src/lib/server/upload-policy.ts");
  const {POST} = await import("../src/app/api/avatars/extract-cover/route.ts");
  const {GET} = await import("../src/app/api/avatars/[id]/media/route.ts");
  const videoPath = localUploadPath(`uploads/users/${ownerKeyFor(null)}/videos/test.mp4`);
  fs.mkdirSync(path.dirname(videoPath), {recursive:true});
  const made = spawnSync("ffmpeg", ["-v","error","-f","lavfi","-i","testsrc2=size=160x120:rate=5","-t","2","-c:v","libx264",videoPath], {encoding:"utf8"});
  assert.equal(made.status, 0, made.stderr);
  const avatar = AvatarStore.create({name:"cover test",videoUrl:videoPath,videoPath,durationSeconds:2,width:160,height:120,fileSize:fs.statSync(videoPath).size});
  const response = await POST(new NextRequest("http://localhost/api/avatars/extract-cover", {
    method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:avatar.id,timestamp:1}),
  }));
  assert.equal(response.status, 200);
  const cover = await GET(new NextRequest(`http://localhost/api/avatars/${avatar.id}/media?kind=cover`), {params:Promise.resolve({id:avatar.id})});
  assert.equal(cover.status, 200, "A successfully generated cover must actually be readable");
  assert.ok((await cover.arrayBuffer()).byteLength > 500);
});
