// Display-only reference: 2026-10-21 MYR/CNY rounded to 1.64, at 125 points/CNY.
// Source: https://www.xe.com/en-us/currencyconverter/convert/?Amount=1&From=MYR&To=CNY
export const MALAYSIAN_PRICE_NOTE = '参考换算：1 RM 约 1.64 元人民币，约 205 积分；以实际结算为准。';
export function referenceMyrPoints(rm) {
  return Number((rm * 205).toFixed(2));
}
