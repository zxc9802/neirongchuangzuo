// Agreed price schedule. Keep these versioned keys stable for existing reservations.
export const MALAYSIAN_PRICE_NOTE = '按 1 RM = 205 积分换算，每秒积分四舍五入；按成片时长结算，总积分四舍五入。';
export function referenceMyrPoints(rm) {
  return Math.round(rm * 205);
}
export const GENERATION_PRICES = Object.freeze([
  ['video', 'doubao-seedance-2-0-260128', 2],
  ['video', 'doubao-seedance-2-5-260628', 3],
  ['video', 'doubao-seedance-2-0-fast-260128', 1.8],
  ['video', 'doubao-seedance-2-0-mini-260615', 1],
  ['video', 'wan3.0-video', 2.4],
  ['video', 'wan3.0-video-prime', 3.6],
  ['digital-human', 'b', 0.1],
  ['digital-human', 'd', 0.12],
  ['digital-human', 'e', 1],
].map(([kind, model, rmPerSecond]) => Object.freeze({ kind, model, rmPerSecond,
  key: `${kind}:${model}:myr205-v1`, pointsPerSecond: referenceMyrPoints(rmPerSecond) })));
export const generationPrice = (kind, model) => GENERATION_PRICES.find(price => price.kind === kind && price.model === model);
export const generationPriceForKey = key => GENERATION_PRICES.find(price => price.key === key);
export function generationPoints(seconds, pricingKey) {
  const price = generationPriceForKey(pricingKey);
  if (!price || !Number.isFinite(seconds) || seconds < 0 || seconds > 1_000_000) throw new TypeError('模型计费参数无效。');
  return Math.round(Number((seconds * price.pointsPerSecond).toFixed(6)));
}
