export const DIRECTOR_PLAN_VERSION = 2;

const bounded = (value, max) => typeof value === 'string' && value.trim().length <= max ? value.trim() : '';

export const DIRECTOR_PLAN_EXAMPLE = {
  objective: '这条视频给出的具体到店理由', audience: '目标顾客与消费场景', perspective: '店家介绍、中性展示或角色演示视角',
  storyArc: '根据素材设计的体验过程与情绪推进，不含重复时间轴', visualStyle: '统一的光影、色调、空间关系与摄影方式',
  cast: [{ name: '角色称呼', role: '片中职责与行动目标', appearance: '按角色参考保持的形象、衣着', referenceIds: ['实际角色图片ID'] }],
  audio: { voiceDirection: '口播音色、语气与节奏；有声音参考时仅参考音色', music: '配乐情绪及音量关系', ambience: '与画面动作对应的拟音和环境声' },
  keep: ['必须保持的人物、产品、环境或声音特征'], avoid: ['不能改变的事实及需要避免的生成问题'],
};

export function normalizeDirectorPlan(value, input, usedIds, fail) {
  if (value == null && input.planningVersion !== DIRECTOR_PLAN_VERSION) return null;
  const invalid = field => { throw fail('创作方案不完整，请重新编导。', 'invalid_plan', { field }); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('plan');
  const result = {};
  for (const [key, max] of [['objective', 400], ['audience', 240], ['perspective', 240], ['storyArc', 600], ['visualStyle', 900]]) {
    result[key] = bounded(value[key], max); if (!result[key]) invalid(`plan.${key}`);
  }
  if (!Array.isArray(value.cast) || value.cast.length > 5) invalid('plan.cast');
  result.cast = value.cast.map((cast, index) => {
    if (!cast || typeof cast !== 'object' || !bounded(cast.name, 80) || !bounded(cast.role, 240) || !bounded(cast.appearance, 500)
      || !Array.isArray(cast.referenceIds) || !cast.referenceIds.length || cast.referenceIds.length > 4
      || cast.referenceIds.some(id => !usedIds.has(id) || !input.assets.some(a => a.id === id && a.type === 'image'))) invalid(`plan.cast.${index}`);
    return { name: cast.name.trim(), role: cast.role.trim(), appearance: cast.appearance.trim(), referenceIds: [...new Set(cast.referenceIds)] };
  });
  if (!value.audio || typeof value.audio !== 'object' || Array.isArray(value.audio)) invalid('plan.audio');
  result.audio = {};
  for (const key of ['voiceDirection', 'music', 'ambience']) {
    if (typeof value.audio[key] !== 'string' || value.audio[key].length > 700) invalid(`plan.audio.${key}`);
    result.audio[key] = input.settings.generateAudio ? value.audio[key].trim() : '';
  }
  for (const key of ['keep', 'avoid']) {
    if (!Array.isArray(value[key]) || !value[key].length || value[key].length > 8 || value[key].some(item => !bounded(item, 350))) invalid(`plan.${key}`);
    result[key] = [...new Set(value[key].map(item => item.trim()))];
  }
  return result;
}

export function compileDirectorPlan(plan, roles, images, voiceAssets, remap) {
  const label = id => {
    const index = images.findIndex(a => a.id === id);
    return index >= 0 ? `图片${index + 1}` : `声音参考${voiceAssets.findIndex(a => a.id === id) + 1}`;
  };
  const used = new Set([...images, ...voiceAssets].map(a => a.id));
  return [
    '# 创作目标', `到店理由：${remap(plan.objective)}`, `目标顾客：${remap(plan.audience)}`, `叙事视角：${remap(plan.perspective)}`,
    '# 素材与职责', ...roles.filter(a => used.has(a.id)).map(a => `${label(a.id)}：${remap(a.role)}；采用：${remap(a.adopt || a.description)}${a.exclude ? `；不采用：${remap(a.exclude)}` : ''}`),
    '# 主体与全片设定', ...plan.cast.map(c => `${c.name}（参考${c.referenceIds.map(label).join('、')}）：${remap(c.role)}；形象保持：${remap(c.appearance)}`),
    `体验与情绪推进：${remap(plan.storyArc)}`, `统一画面：${remap(plan.visualStyle)}`,
    plan.audio.voiceDirection && `声音与表演：${remap(plan.audio.voiceDirection)}`,
    plan.audio.music && `背景音乐：${remap(plan.audio.music)}`, plan.audio.ambience && `环境声与拟音：${remap(plan.audio.ambience)}`,
    '# 保持与禁止', ...plan.keep.map(v => `保持：${remap(v)}`), ...plan.avoid.map(v => `禁止：${remap(v)}`),
  ].filter(Boolean).join('\n');
}

export function balanceNarrationTiming(shots, input, fail) {
  if (input.planningVersion !== DIRECTOR_PLAN_VERSION || !input.settings.generateAudio || input.settings.language !== 'zh') return shots;
  const timing = shots.map(shot => {
    const duration = shot.end - shot.start;
    const units = [...(shot.voiceover || '').replace(/[\p{P}\p{S}\s]/gu, '')].length;
    return { duration, minimum: Math.max(Math.min(duration, 2), units / 4) };
  });
  const needed = timing.reduce((sum, t) => sum + Math.max(0, t.minimum - t.duration), 0);
  if (needed < .01) return shots;
  const available = timing.reduce((sum, t) => sum + Math.max(0, t.duration - t.minimum), 0);
  if (available + .001 < needed) throw fail('旁白在当前视频时长内读不完，请重新编排。', 'invalid_voice_timing', {
    duration: input.settings.duration, minimumDuration: Number(timing.reduce((sum, t) => sum + t.minimum, 0).toFixed(2)),
    instruction:'精简非必要旁白，保留完整团购使用条件及主要看点。',
  });
  let end = 0;
  return shots.map((shot, index) => {
    const t = timing[index];
    const duration = t.minimum > t.duration ? t.minimum : t.duration - (t.duration - t.minimum) * needed / available;
    const start = end; end = index === shots.length - 1 ? input.settings.duration : Number((end + duration).toFixed(3));
    return { ...shot, start, end };
  });
}
