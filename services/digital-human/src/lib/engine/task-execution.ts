// A task's pipeline and recovery both write the same media files.
const activeTasks = new Set<string>();

export class TaskBusyError extends Error {
  constructor() {
    super("任务正在处理中，请稍后重试");
  }
}

export async function withTaskExecution<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
  if (activeTasks.has(taskId)) throw new TaskBusyError();
  activeTasks.add(taskId);
  try {
    return await operation();
  } finally {
    activeTasks.delete(taskId);
  }
}
