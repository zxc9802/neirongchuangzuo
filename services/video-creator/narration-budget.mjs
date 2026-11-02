export function narrationBudget(language = 'zh') {
  if (language === 'zh') return { unit:'characters', rate:6, repairRate:5.5 };
  if (language === 'th') return { unit:'characters', rate:10, repairRate:8 };
  return { unit:'words', rate:3, repairRate:2.5 };
}
export function narrationUnits(value, language) {
  const text=String(value || '');
  return narrationBudget(language).unit==='characters' ? [...text.replace(/[\p{P}\p{S}\s]/gu,'')].length
    : (text.match(/[\p{L}\p{N}]+(?:['’’-][\p{L}\p{N}]+)*/gu)||[]).length;
}

export function narrationTarget(settings) {
  if (!settings.generateAudio || settings.language !== 'zh') return null;
  return { min: Math.round(settings.duration * 14 / 3), max: Math.round(settings.duration * 16 / 3) };
}
export function narrationDirection(settings) {
  const target = narrationTarget(settings);
  if (!target) return '';
  return `口播节奏：先写一段完整、有消费理由的连贯口播，${settings.duration}秒通常以${target.min}—${target.max}个汉字为目标（不含标点）。用户明确要求慢节奏、留白或资料不足时可少写，不凑字、不编造事实。用自然利落的中文表达，实际发音约每秒5—6字；短换气通常0.2—0.4秒，不为每次切镜安排一秒以上等待。句子可跨相邻镜头连续说，不能每切镜就重新起句。开场尽快进入口播，结尾完整说完并自然收束，禁止截断、漏读或重复。优先减少多余空档，不靠机械加速、拉伸音色或吞字。`;
}
