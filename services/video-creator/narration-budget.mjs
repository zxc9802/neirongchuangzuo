export function narrationBudget(language = 'zh') {
  if (language === 'zh') return { unit:'characters', rate:4, repairRate:3 };
  if (language === 'th') return { unit:'characters', rate:10, repairRate:8 };
  return { unit:'words', rate:3, repairRate:2.5 };
}
export function narrationUnits(value, language) {
  const text=String(value || '');
  return narrationBudget(language).unit==='characters' ? [...text.replace(/[\p{P}\p{S}\s]/gu,'')].length
    : (text.match(/[\p{L}\p{N}]+(?:['’’-][\p{L}\p{N}]+)*/gu)||[]).length;
}
