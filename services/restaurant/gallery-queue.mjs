export const GALLERY_CONCURRENCY = 10;

export function createGalleryQueue(limit = GALLERY_CONCURRENCY) {
  if (!Number.isInteger(limit) || limit < 1 || limit > GALLERY_CONCURRENCY) throw new Error('Gallery concurrency must be between 1 and 10.');
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
