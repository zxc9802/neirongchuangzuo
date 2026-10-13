export const POINTS_PER_CNY = 125;
export const CNY_MICROS = 1_000_000;
export const COST_PRICING_VERSION = '2026-10-13-api-cost';

export function cnyMicros(value) {
  const amount = typeof value === 'string' && /^\d+(?:\.\d{1,9})?$/.test(value) ? Number(value) : value;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > 1_000_000) throw new TypeError('API费用无效。');
  const micros = Math.round(amount * CNY_MICROS);
  if (!Number.isSafeInteger(micros)) throw new TypeError('API费用超出范围。');
  return micros;
}

export function costPointsFromMicros(micros) {
  if (!Number.isSafeInteger(micros) || micros < 0) throw new TypeError('API费用无效。');
  return Math.ceil(micros / (CNY_MICROS / POINTS_PER_CNY));
}

export function costPoints(amountCny) { return costPointsFromMicros(cnyMicros(amountCny)); }

export function costTotals(items = {}) {
  let actualMicros = 0, pendingMicros = 0, pendingCount = 0;
  for (const item of Object.values(items)) {
    if (['pending', 'uncertain'].includes(item.status)) { pendingMicros += item.quoteMicros; pendingCount++; }
    else actualMicros += item.costMicros;
  }
  return { actualMicros, pendingMicros, pendingCount, budgetMicros: actualMicros + pendingMicros };
}
