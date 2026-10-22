import { safeVideoError } from '../video/errors.mjs';
export function observeTask(task, now) {
  if (!task.timeline && ['completed', 'failed', 'uncertain'].includes(task.status)) return;
  task.timelineCoverage ||= task.status === 'reserving' ? 'complete' : 'partial';
  task.timeline ||= [];
  if (task.timeline.at(-1)?.phase !== task.status) {
    if (task.timeline.at(-1) && !task.timeline.at(-1).endedAt) task.timeline.at(-1).endedAt = now;
    task.timeline.push({ phase: task.status, startedAt: now });
  }
  if (['completed', 'failed', 'uncertain'].includes(task.status)) task.timeline.at(-1).endedAt ||= now;
}
export function recordTaskError(task, cause, now, action) {
  task.events ||= [];
  task.events.push({ at: now, action, phase: task.status, code: /^[A-Z_]+$/.test(cause?.code || '') ? cause.code : 'PROVIDER_CONNECTION_ERROR',
    message: safeVideoError(String(cause?.message || '接口连接异常')).replace(/sk-[\w-]+/gi,'[redacted]').slice(0, 500) });
  task.events = task.events.slice(-50);
}
export function taskTimeline(task, now) {
  return (task.timeline || []).map(p => ({ ...p, elapsedMs: Math.max(0, (p.endedAt || now) - p.startedAt) }));
}
