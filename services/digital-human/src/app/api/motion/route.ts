import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { canAccessTask, resolveAccessContext, unauthorizedResponse } from "@/lib/access-control";
import { claimPendingUpload, resolveOwnedUpload } from "@/lib/server/upload-policy";
import { acquireGenerationSlot, GenerationLimitError } from "@/lib/server/generation-limit";
import { isExternallyBilledUser } from "@/lib/main-app-billing";
import { logServerError } from "@/lib/server/safe-log";
import { MotionInputError, MAX_MOTION_SECONDS, validateMotionEdit } from "@/lib/motion/contract";
import { MotionStore, publicMotion } from "@/lib/motion/store";
import { runMotion } from "@/lib/motion/pipeline";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  const access = await resolveAccessContext(req);
  if (access.isolated && !access.userId) return unauthorizedResponse();
  try {
    const projects = (await MotionStore.list()).filter(p => canAccessTask(access, p)).map(publicMotion);
    return NextResponse.json({projects}, {headers: {"Cache-Control": "no-store"}});
  } catch (err) {logServerError("motion.list", err); return NextResponse.json({error: "动效任务加载失败"}, {status: 500});}
}
export async function POST(req: NextRequest) {
  const access = await resolveAccessContext(req);
  if (access.isolated && !access.userId) return unauthorizedResponse();
  let release: (() => void) | undefined;
  try {
    const raw = await req.text();
    if (raw.length > 300_000) throw new MotionInputError("提交内容过大");
    const body = JSON.parse(raw);
    const edit = validateMotionEdit({...body, scenes: []}, MAX_MOTION_SECONDS);
    if (edit.effect) await (await import("@/lib/motion-library/service")).ownedEffectVersion(edit.effect, access);
    const source = await resolveOwnedUpload({key: body.uploadKey, userId: access.userId, folder: "videos"});
    if (!source) throw new MotionInputError("视频上传凭证无效，请重新上传");
    release = acquireGenerationSlot(`motion:${access.userId || "local"}`, {enforceHourlyLimit: isExternallyBilledUser(access.session?.user) || access.session?.user.billingAudience === "standalone"});
    if (!claimPendingUpload({key: body.uploadKey, userId: access.userId})) throw new MotionInputError("上传凭证已过期或已使用，请重新上传");
    const project = await MotionStore.save({...edit, id: `motion_${crypto.randomUUID()}`, userId: access.userId || undefined,
      name: typeof body.name === "string" ? body.name.slice(0, 120) : "数字人动效", createdAt: Date.now(), updatedAt: Date.now(), source: source.source,
      duration: 0, status: "analyzing", progress: 0, message: "正在读取最终剪辑版"});
    MotionStore.claim(project.id);
    const done = release; release = undefined;
    void runMotion(project.id, "analyze").catch(err => logServerError("motion.crashed", err)).finally(() => {done(); MotionStore.release(project.id);});
    return NextResponse.json({project: publicMotion(project)}, {status: 202});
  } catch (err) {
    if (err instanceof MotionInputError || err instanceof SyntaxError) return NextResponse.json({error: err instanceof SyntaxError ? "提交格式无效" : err.message}, {status: 400});
    if (err instanceof GenerationLimitError) return NextResponse.json({error: err.message}, {status: err.status});
    logServerError("motion.create", err); return NextResponse.json({error: "创建动效任务失败，请重试"}, {status: 500});
  } finally {release?.();}
}
