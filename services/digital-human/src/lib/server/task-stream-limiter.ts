import "server-only";

const MAX_GLOBAL_STREAMS = 100;
const MAX_STREAMS_PER_USER = 6;
const MAX_STREAMS_PER_TASK = 3;

let globalStreams = 0;
const userStreams = new Map<string, number>();
const taskStreams = new Map<string, number>();

export function acquireTaskStreamSlot(
  userId: string,
  taskId: string,
): (() => void) | null {
  const userCount = userStreams.get(userId) || 0;
  const taskCount = taskStreams.get(taskId) || 0;
  if (
    globalStreams >= MAX_GLOBAL_STREAMS ||
    userCount >= MAX_STREAMS_PER_USER ||
    taskCount >= MAX_STREAMS_PER_TASK
  ) return null;

  globalStreams += 1;
  userStreams.set(userId, userCount + 1);
  taskStreams.set(taskId, taskCount + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    globalStreams = Math.max(0, globalStreams - 1);
    const nextUserCount = (userStreams.get(userId) || 1) - 1;
    const nextTaskCount = (taskStreams.get(taskId) || 1) - 1;
    if (nextUserCount <= 0) userStreams.delete(userId);
    else userStreams.set(userId, nextUserCount);
    if (nextTaskCount <= 0) taskStreams.delete(taskId);
    else taskStreams.set(taskId, nextTaskCount);
  };
}
