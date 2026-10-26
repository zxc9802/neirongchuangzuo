import { isWan3Model } from './provider.mjs';

const CONCURRENCY = { aggregate: 600, official: 5 };
const REQUESTS_PER_SECOND = 5;
const parts = task => task.segments || [task];
const route = part => part.wan3Route === 'aggregate' ? 'aggregate' : 'official';

// The video handler's durable single-writer lock owns this account-wide queue.
// Queue tickets and request times live in task.json alongside the provider IDs.
export function createWan3Queue({ jobs, save, now = Date.now }) {
  let sequence = Promise.resolve(), order = 0, restartUntil = 0;
  const entries = () => [...jobs.values()].filter(task => isWan3Model(task.model))
    .flatMap(task => parts(task).filter(part => part.wan3Queue).map(part => ({ task, part, ticket: part.wan3Queue })));
  const waiting = provider => entries().filter(({ task, part, ticket }) => task.status === 'queued' && ticket.state === 'queued'
      && (!provider || route(part) === provider))
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
        if (!isWan3Model(task.model)) continue;
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
        const ticket = part.wan3Queue, all = entries(), at = now(), provider = route(part);
        const pool = all.filter(entry => route(entry.part) === provider);
        const requests = all.flatMap(entry => entry.ticket.attempts).filter(time => time > at - 1000);
        const cooldown = Math.max(restartUntil, ...pool.map(entry => entry.ticket.retryAt || 0));
        if (ticket.state !== 'queued' || waiting(provider)[0]?.part !== part || at < cooldown
          || pool.filter(entry => entry.ticket.state === 'active').length >= CONCURRENCY[provider]
          || requests.length >= REQUESTS_PER_SECOND) return false;
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
      if (!isWan3Model(task.model) || task.status !== 'queued') return undefined;
      const pending = waiting().filter(entry => entry.task === task);
      const queue = pending.length ? waiting(route(pending[0].part)) : [];
      return { position: pending.length ? queue.findIndex(entry => entry.part === pending[0].part) + 1 : 0, pending: pending.length };
    },
  };
}
