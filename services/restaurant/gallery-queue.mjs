export function createGalleryQueue(limit = 3) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 3) throw new Error('Gallery concurrency must be between 1 and 3.');
  const waiting = [];
  let active = 0;
  function pump() {
    while (active < limit && waiting.length) {
      const job = waiting.shift();
      active++;
      Promise.resolve().then(job.operation).then(job.resolve, job.reject).finally(() => { active--; pump(); });
    }
  }
  return operation => new Promise((resolve, reject) => { waiting.push({ operation, resolve, reject }); pump(); });
}
