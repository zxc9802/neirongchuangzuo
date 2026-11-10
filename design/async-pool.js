export async function mapConcurrent(items, limit, work) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Invalid concurrency');
  const results = new Array(items.length);
  let next = 0, failure;
  await Promise.all(Array.from({length:Math.min(limit,items.length)}, async () => {
    while (!failure && next < items.length) {
      const index = next++;
      try { results[index] = await work(items[index], index); }
      catch (error) { failure ||= error; }
    }
  }));
  if (failure) throw failure;
  return results;
}
