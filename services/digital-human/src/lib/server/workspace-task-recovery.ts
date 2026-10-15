import "server-only";
import { TaskStore, type TaskItem } from "../store/task-store";
import { releaseMainAppCredits } from "../main-app-billing";
import { taskWorkerInterrupted, withTaskBillingGuard } from "./task-worker";

export async function reconcileWorkspaceTask(task: TaskItem): Promise<TaskItem> {
  if (task.billing?.source !== "workspace" || !task.userId || !task.billing.requestId) return task;
  const abandoned = ["pending", "processing"].includes(task.status) && taskWorkerInterrupted(task.id, task.executionOwner);
  if (!abandoned && !(task.status === "failed" && ["reserving", "reserved"].includes(task.billing.status))) return task;
  return withTaskBillingGuard(task.id, async () => {
    const current = TaskStore.get(task.id) || task;
    if (current.billing?.source !== "workspace" || !current.billing.requestId || !current.userId) return current;
    const unfinished = ["pending", "processing"].includes(current.status);
    if (!unfinished && !(current.status === "failed" && ["reserving", "reserved"].includes(current.billing.status))) return current;
    if (unfinished && !taskWorkerInterrupted(current.id, current.executionOwner)) return current;
    const submitted = Boolean(current.results.heygenLipsyncId || current.results.lipsyncChunks?.length ||
      current.results.finalVideoUrl || current.results.pixverseResultUrl || current.results.veedResultUrl);
    if (["reserving", "reserved"].includes(current.billing.status) && !submitted && !current.results.exactAudioUrl) {
      await releaseMainAppCredits({ userId: current.userId, requestId: current.billing.requestId, source: "workspace" });
      return TaskStore.update(current.id, { status: "failed", step: "error", failedStep: current.step,
        progress: 0, billing: { ...current.billing, status: "released" }, errorCode: "TASK_RESTARTED_BEFORE_SUBMISSION",
        error: "服务重启中断了任务，尚未提交口型生成，预留积分已退回，请重新创建任务。" }) || current;
    }
    if (unfinished) return TaskStore.update(current.id, { status: "failed", step: "error", failedStep: current.step,
      errorCode: "TASK_RESTARTED_AFTER_SUBMISSION", error: "任务被重启中断，积分仍在核对，请恢复原任务或联系管理员。" }) || current;
    return current;
  });
}
