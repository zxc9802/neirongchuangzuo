import { logServerError } from "@/lib/server/safe-log";
import { NextRequest, NextResponse } from "next/server";
import { CosService } from "@/lib/cos";
import fs from "fs";
import path from "path";
import { getAppConfig } from "@/lib/config";
import { recoverStuckLipsyncTask } from "@/lib/engine/recover-lipsync";
import { TaskStore } from "@/lib/store/task-store";
import { toPublicTask } from "@/lib/server/public-data";
import {
  canAccessTask,
  resolveAccessContext,
  taskNotFoundResponse,
  unauthorizedResponse,
} from "@/lib/access-control";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const access = await resolveAccessContext(req);
  if (access.isolated && !access.userId) {
    return unauthorizedResponse();
  }

  const { id } = await params;
  let task = await TaskStore.getAsync(id);
  if (!task || !canAccessTask(access, task)) {
    return taskNotFoundResponse();
  }

  const stuckDownloading =
    task.status === "processing" &&
    !task.results?.finalVideoUrl &&
    (task.step === "mcp_lipsync_submit" || task.step === "finalize") &&
    ((task.logs || []).some((entry) => entry.message.includes("正在下载成片")) ||
      Boolean(
        task.results?.heygenLipsyncId ||
          task.results?.pixverseResultUrl ||
          task.results?.veedResultUrl
      ));

  if (stuckDownloading && CosService.isConfigured()) {
    try {
      const hasFinal = await CosService.objectExists(`jobs/${id}/final.mp4`);
      if (hasFinal) {
        task = await recoverStuckLipsyncTask(id, access.session?.token);
      }
    } catch (err) {
      logServerError("tasks.auto_recovery_failed", err, "warn");
    }
  }

  return NextResponse.json({ task: toPublicTask(task) });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const access = await resolveAccessContext(req);
  if (access.isolated && !access.userId) {
    return unauthorizedResponse();
  }

  const { id } = await params;
  const task = TaskStore.get(id);
  if (!task || !canAccessTask(access, task)) {
    return taskNotFoundResponse();
  }

  if (
    task.status === "pending" || task.status === "processing" ||
    (task.billing?.isExternalUser && !["settled", "released"].includes(task.billing.status))
  ) {
    return NextResponse.json(
      { error: "任务仍在处理或计费尚未确认，暂时不能删除，请完成或恢复后再试" },
      { status: 409 }
    );
  }

  const deleted = TaskStore.delete(id);
  const localJobDir = path.join(getAppConfig().storageDir, id);
  fs.rmSync(localJobDir, { recursive: true, force: true });
  if (CosService.isConfigured()) {
    const files = await CosService.listFiles(`jobs/${id}/`);
    await Promise.all(files.map((file) => CosService.deleteObject(file.key).catch(() => undefined)));
  }
  return NextResponse.json({ success: deleted });
}
