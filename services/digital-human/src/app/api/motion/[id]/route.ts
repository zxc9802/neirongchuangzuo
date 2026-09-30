import { NextRequest, NextResponse } from "next/server";
import { canAccessTask, resolveAccessContext, unauthorizedResponse, taskNotFoundResponse } from "@/lib/access-control";
import { acquireGenerationSlot, GenerationLimitError } from "@/lib/server/generation-limit";
import { isExternallyBilledUser } from "@/lib/main-app-billing";
import { logServerError } from "@/lib/server/safe-log";
import { MotionInputError, validateMotionEdit } from "@/lib/motion/contract";
import { MotionStore, publicMotion } from "@/lib/motion/store";
import { runMotion } from "@/lib/motion/pipeline";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = {params: Promise<{id: string}>};
export async function GET(req: NextRequest, ctx: Context) {
  const access = await resolveAccessContext(req);
  if (access.isolated && !access.userId) return unauthorizedResponse();
  const project = await MotionStore.get((await ctx.params).id);
  if (!project || !canAccessTask(access, project)) return taskNotFoundResponse();
  return NextResponse.json({project: publicMotion(project)}, {headers: {"Cache-Control": "no-store"}});
}
export async function PATCH(req: NextRequest, ctx: Context) {
  const access = await resolveAccessContext(req);
  if (access.isolated && !access.userId) return unauthorizedResponse();
  const {id} = await ctx.params;
  let release: (() => void) | undefined, claimed = false;
  try {
    const project = await MotionStore.get(id);
    if (!project || !canAccessTask(access, project)) return taskNotFoundResponse();
    if (["analyzing", "rendering"].includes(project.status) || !MotionStore.claim(id)) return NextResponse.json({error: "任务处理中，请完成后再操作"}, {status: 409});
    claimed = true;
    const raw = await req.text();
    if (raw.length > 300_000) throw new MotionInputError("提交内容过大");
    const body = JSON.parse(raw);
    if (!["save", "analyze", "render", "prepare"].includes(body.action)) throw new MotionInputError("无效操作");
    if (!project.duration) throw new MotionInputError("视频未成功读取，请重新上传");
    const edit = validateMotionEdit(body, project.duration, body.action === "render");
    if (edit.effect) await (await import("@/lib/motion-library/service")).ownedEffectVersion(edit.effect, access);
    if (body.action !== "save") release = acquireGenerationSlot(`motion:${access.userId || "local"}`, {enforceHourlyLimit: isExternallyBilledUser(access.session?.user) || access.session?.user.billingAudience === "standalone"});
    const next = await MotionStore.save({...project, ...edit, effect: edit.effect, output: undefined, error: undefined,
      status: body.action === "save" ? "ready" : body.action === "render" ? "rendering" : "analyzing",
      progress: body.action === "save" ? 100 : 0, message: body.action === "save" ? "修改已保存" : "任务已开始"});
    if (body.action !== "save") {
      const done = release!; release = undefined; claimed = false;
      void runMotion(id, body.action).catch(err => logServerError("motion.crashed", err)).finally(() => {done(); MotionStore.release(id);});
    }
    return NextResponse.json({project: publicMotion(next)}, {status: body.action === "save" ? 200 : 202});
  } catch (err) {
    if (err instanceof MotionInputError || err instanceof SyntaxError) return NextResponse.json({error: err instanceof SyntaxError ? "提交格式无效" : err.message}, {status: 400});
    if (err instanceof GenerationLimitError) return NextResponse.json({error: err.message}, {status: err.status});
    logServerError("motion.update", err); return NextResponse.json({error: "动效任务操作失败"}, {status: 500});
  } finally {release?.(); if (claimed) MotionStore.release(id);}
}
