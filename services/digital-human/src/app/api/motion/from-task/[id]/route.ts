import crypto from "node:crypto";
import fs from "node:fs";
import {NextRequest, NextResponse} from "next/server";
import {resolveAccessContext, taskNotFoundResponse, unauthorizedResponse} from "@/lib/access-control";
import {TaskStore} from "@/lib/store/task-store";
import {isTaskOutputDeliverable} from "@/lib/server/public-data";
import {downloadTrustedMediaToFile, isTrustedTaskOutputSource} from "@/lib/server/media-response";
import {resolveAllowedLocalMediaPath} from "@/lib/media-path-policy";
import {CosService} from "@/lib/cos";
import {logServerError} from "@/lib/server/safe-log";
import {MAX_MOTION_SECONDS, type MotionTaskSource} from "@/lib/motion/contract";
import {cancelPendingUpload, cleanupExpiredPendingUploads, consumeUploadGrantBudget, localUploadPath, markPendingUploadStored, MAX_UPLOAD_BYTES, ownerKeyFor, reservePendingUpload} from "@/lib/server/upload-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = {params: Promise<{id: string}>};

async function taskSource(req: NextRequest, context: Context) {
  const access = await resolveAccessContext(req);
  if (access.isolated && !access.userId) return unauthorizedResponse();
  const {id} = await context.params;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return taskNotFoundResponse();
  const task = await TaskStore.getAsync(id);
  // Import into a personal workspace only from that account's own completed tasks.
  if (!task || (access.isolated && task.userId !== access.userId)) return taskNotFoundResponse();
  if (!isTaskOutputDeliverable(task)) return NextResponse.json({error: "视频尚未制作完成，请完成后再添加动效"}, {status: 409});
  const source = task.results.finalVideoUrl;
  if (!source || !isTrustedTaskOutputSource(source, id, ["final.mp4"])) return taskNotFoundResponse();
  const duration = task.results.videoDuration || 0;
  if (duration > MAX_MOTION_SECONDS) return NextResponse.json({error: "动效视频最长支持 10 分钟，请先剪辑后上传"}, {status: 400});
  const video: MotionTaskSource = {taskId: id, name: `${(task.inputs.videoName || "数字人").replace(/\.[^.]+$/, "").slice(0, 100)}-成片.mp4`, duration, sourceUrl: `/api/tasks/${encodeURIComponent(id)}/media/final`};
  return {access, source, video};
}

export async function GET(req: NextRequest, context: Context) {
  try {
    const result = await taskSource(req, context);
    if (result instanceof Response) return result;
    return NextResponse.json({video: result.video}, {headers: {"Cache-Control": "private, no-store"}});
  } catch (error) {
    logServerError("motion.task_source", error);
    return NextResponse.json({error: "成片加载失败，请返回制作台重试"}, {status: 500});
  }
}

export async function POST(req: NextRequest, context: Context) {
  let key = "", output = "";
  try {
    const result = await taskSource(req, context);
    if (result instanceof Response) return result;
    const {access, source} = result;
    const remoteKey = CosService.getManagedObjectKey(source);
    const local = resolveAllowedLocalMediaPath(source);
    const size = remoteKey ? await CosService.getObjectSize(remoteKey) : local ? fs.statSync(local).size : 0;
    if (!size || size > MAX_UPLOAD_BYTES.videos) return NextResponse.json({error: "成片为空或超过 500 MB，请先剪辑后上传"}, {status: 400});
    if (!consumeUploadGrantBudget(access.userId, size)) return NextResponse.json({error: "视频转入频率或容量超限，请稍后重试"}, {status: 429});
    await cleanupExpiredPendingUploads();
    const uploadKey = `uploads/users/${ownerKeyFor(access.userId)}/videos/${crypto.randomUUID()}.mp4`;
    if (!reservePendingUpload({key: uploadKey, userId: access.userId, folder: "videos", bytes: size})) return NextResponse.json({error: "待处理视频容量已满，请稍后重试"}, {status: 429});
    key = uploadKey;
    output = localUploadPath(key);
    const received = await downloadTrustedMediaToFile({source, outputPath: output, maxBytes: size});
    if (received !== size) throw new Error("Incomplete task video copy");
    if (CosService.isConfigured()) {
      await CosService.uploadFile(output, key);
      fs.rmSync(output, {force: true});
    }
    if (!markPendingUploadStored(key)) throw new Error("Task video upload expired");
    return NextResponse.json({uploadKey: key}, {headers: {"Cache-Control": "no-store"}});
  } catch (error) {
    if (key) {
      cancelPendingUpload(key);
      try {await CosService.deleteObject(key);} catch {}
    }
    if (output) fs.rmSync(output, {force: true});
    logServerError("motion.import_task", error);
    return NextResponse.json({error: "成片转入失败，请重试"}, {status: 500});
  }
}
