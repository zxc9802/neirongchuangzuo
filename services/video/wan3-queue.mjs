import { WAN3_MODEL } from './provider.mjs';

const LIMIT = 5;
const parts = task => task.segments || [task];

// The video handler's durable single-writer lock owns this account-wide queue.
// Queue tickets and request times live in task.json alongside the provider IDs.
export function createWan3Queue({ jobs, save, now = Date.now }) {
  let sequence = Promise.resolve(), order = 0, restartUntil = 0;
  const entries = () => [...jobs.values()].filter(task => task.model === WAN3_MODEL)
    .flatMap(task => parts(task).filter(part => part.wan3Queue).map(part => ({ task, part, ticket: part.wan3Queue })));
  const waiting = () => entries().filter(({ task, ticket }) => task.status === 'queued' && ticket.state === 'queued')
    .sort((a, b) => a.ticket.order - b.ticket.order);
  function serialize(action) {
    const pending = sequence.then(action);
    sequence = pending.catch(() => {});
    return pending;
  }
  function observe(part, result) {
    if (part.wan3Queue && (result.completed || result.failed || result.url)) part.wan3Queue.state = 'finished';
  }
  return {
    observe,
    active: part => part.wan3Queue?.state === 'active',
    async restore() {
      for (const task of jobs.values()) {
        if (task.model !== WAN3_MODEL) continue;
        let changed = false;
        for (const part of parts(task)) {
          if (!part.wan3Queue && (part.providerDispatched || part.providerId)) {
            const finished = part.resultSource || part.failed || task.status === 'completed'
              || !part.providerId && ['VIDEO_PROVIDER_REJECTED', 'VIDEO_PROVIDER_IP_DENIED', 'VIDEO_GENERATION_FAILED'].includes(task.code);
            part.wan3Queue = { state: finished ? 'finished' : 'active', attempts: [] }; changed = true;
          }
          order = Math.max(order, part.wan3Queue?.order || 0);
        }
        if (changed) await save(task);
      }
      // Cover a crash between saving a dispatch boundary and actually sending it.
      if (entries().length) restartUntil = now() + 1000;
    },
    async enqueue(task) {
      await serialize(async () => {
        for (const part of parts(task)) {
          if (!part.wan3Queue) part.wan3Queue = { order: ++order, state: 'queued', attempts: [] };
          else if (part.wan3Queue.state === 'queued' && !part.wan3Queue.order) part.wan3Queue.order = ++order;
        }
        task.wan3QueuedAt ??= now();
        task.status = 'queued'; await save(task);
      });
    },
    async admit(task, part = task) {
      return serialize(async () => {
        const ticket = part.wan3Queue, all = entries(), at = now();
        const requests = all.flatMap(entry => entry.ticket.attempts).filter(time => time > at - 1000);
        const cooldown = Math.max(restartUntil, ...all.map(entry => entry.ticket.retryAt || 0));
        if (ticket.state !== 'queued' || waiting()[0]?.part !== part || at < cooldown
          || all.filter(entry => entry.ticket.state === 'active').length >= LIMIT || requests.length >= LIMIT) return false;
        ticket.state = 'active'; ticket.attempts = [...ticket.attempts.filter(time => time > at - 1000), at];
        part.providerDispatched = true; task.providerDispatched = true;
        await save(task);
        // In-memory pacing uses the actual send boundary, after durable I/O.
        ticket.attempts[ticket.attempts.length - 1] = now();
        return true;
      });
    },
    async rejected(task, part = task, { throttled = false, retryAfterMs = 5000 } = {}) {
      await serialize(async () => {
        part.wan3Queue.state = 'queued';
        if (throttled) part.wan3Queue.retryAt = now() + Math.max(1000, retryAfterMs);
        part.providerDispatched = false;
        task.providerDispatched = parts(task).some(item => item.providerDispatched);
        await save(task);
      });
    },
    finish(task) {
      if (task.recoveryDeadline && task.wan3QueuedAt !== undefined) task.recoveryDeadline += now() - task.wan3QueuedAt;
      delete task.wan3QueuedAt;
    },
    view(task) {
      if (task.model !== WAN3_MODEL || task.status !== 'queued') return undefined;
      const queue = waiting(), index = queue.findIndex(entry => entry.task === task);
      return { position: index < 0 ? 0 : index + 1, pending: queue.filter(entry => entry.task === task).length };
    },
  };
}
