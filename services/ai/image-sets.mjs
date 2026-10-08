export const GENERATION_MODES = Object.freeze(['single', 'series', 'variations']);
export const VARIATION_STYLES = Object.freeze([
  { name: '简洁纪实', instruction: '简洁纪实风格：真实自然光，克制的色彩，清爽留白，少量易读文字，突出真实主体。' },
  { name: '杂志编辑', instruction: '杂志编辑风格：有层次的栅格与标题层级，精致但不改变场景事实的色彩，清晰的主体与编辑排版。' },
  { name: '生活方式手账', instruction: '生活方式手账风格：自然亲切的纸感、小型注释和手账排版，文字清楚，保留原图真实对象与环境。' },
  { name: '醒目文字海报', instruction: '醒目文字海报风格：突出主标题，强对比且清晰的文字层级，用真实照片作为主体，避免文字覆盖关键主体。' },
  { name: '暖色胶片', instruction: '暖色胶片风格：轻微暖色与柔和明暗，少量胶片质感，保持真实主体颜色，配简洁文字。' },
  { name: '清新自然', instruction: '清新自然风格：干净的浅色配色、轻盈排版和自然光感，以实拍主体为中心。' },
  { name: '质感深色', instruction: '质感深色风格：深色信息底板与克制高光，层级清楚，不能改变真实环境和产品外观。' },
  { name: '清晰信息卡', instruction: '清晰信息卡风格：真实照片配分区信息卡与要点，用留白和小标题组织用户已提供的内容。' },
  { name: '复古报刊', instruction: '复古报刊风格：纸色背景与报刊标题层级，照片保持真实，适度排版，正文清晰易读。' },
  { name: '轻盈拼贴', instruction: '轻盈拼贴风格：把真实原图的可见元素以轻量纸片式排版组合成一张完整主题图，不添加虚构对象。' },
  { name: '极简留白', instruction: '极简留白风格：大块留白、一个清晰主体和克制的标题，用最少元素表达同一主题。' },
  { name: '活力色块', instruction: '活力色块风格：明快但不过度饱和的辅助色块，配真实照片与直观标题，不改变主体本身的颜色。' },
  { name: '细节特写', instruction: '细节特写风格：合理裁剪突出原图可见的细节，以小字注释与清晰层级建立质感，不补造细节。' },
  { name: '柔和日常', instruction: '柔和日常风格：柔和色彩与自然生活感，亲切文字排版，保持照片表达的事实。' },
  { name: '品牌目录', instruction: '品牌目录风格：整齐的信息层级、统一边距与真实产品或空间照片，像一张清楚的主题目录页。' },
]);

const SERIES_FOCUS = Object.freeze([
  '主题封面：概括主题，以真实主体和简洁主标题吸引注意。',
  '主体细节：选择原图中可见的产品、菜品、工艺或环境细节，未提供的细节不得添加。',
  '场景用途：依据原图和已提供信息展现适合的使用或到店场景，不能虚构顾客、活动和体验。',
  '信息汇总：整理用户确实提供的名称、特点或服务信息；不补造价格、优惠和评价。',
  '另一处真实细节：展示本张原图中清楚可见、与主题相关的细节，避免重复封面。',
  '空间与背景：呈现本张原图已有的空间、陈列或背景，围绕同一主题自然说明。',
  '制作或服务细节：仅展示原图和用户资料可以确认的过程；缺少过程依据时改为实拍细节。',
  '另一种观看角度：使用本张原图现有的角度或合理裁剪，不虚构新的视角和对象。',
  '主题要点：用少量清楚的文字归纳本张原图可见特点及用户已提供信息。',
  '使用与展示：根据本张真实照片表达实际展示方式，不添加未经证实的使用体验。',
  '材质与观感：突出本张原图可见的材质、颜色和光线，不能把视觉感受写成未证实的品质承诺。',
  '陈列与组合：呈现本张原图已有的组合和布局，不增加商品、菜品或人物数量。',
  '真实亮点补充：围绕本张原图可见、此前未强调的特点补充同一主题。',
  '资料说明：配合本张实拍图整理确实提供的资料；无资料时以真实照片为主、少加字。',
  '系列收尾：围绕主题做简洁收尾与自然行动提示，地点、价格和优惠只用用户已提供信息。',
]);

export function imageRequestId(taskId, index) { return index === 1 ? taskId : `${taskId}-${index}`; }

export function imagePlan(mode, outputCount, prompt) {
  return Array.from({ length: outputCount }, (_, position) => {
    const index = position + 1;
    if (mode === 'single') return { index, label: '单图', style: '单图', prompt };
    const common = `用户主题与要求：${prompt}\n输出要求：本次只生成一张独立完整图片，是 ${outputCount} 张作品中的第 ${index} 张，不是拼图、分屏或九宫格。真实主体、门店、菜品、人物、产品及经营事实只能依据用户上传的原图和已提供信息；不能虚构价格、优惠、资质或评价。`;
    if (mode === 'variations') {
      const style = VARIATION_STYLES[position];
      return { index, label: style.name, style: style.name, prompt: `${common}\n本张视觉风格：${style.instruction}\n本张指定视觉风格覆盖用户预设中的视觉布局和风格指令，但保留其主题、业务事实和文字信息。主题和事实保持相同，通过设计风格提供另一版完整作品，不改变真实内容。` };
    }
    const focus = SERIES_FOCUS[position];
    return { index, label: `系列第 ${index} 张`, style: '统一系列', prompt: `${common}\n统一系列设计：每张围绕同一个主题，固定色调、字体风格、文字层级、版式体系和光线观感。根据主题和原图确定自然克制的共同配色、清晰易读的字体和一致的光线；不能复制同一张图，也不能改动真实主体事实。\n本张内容分工：${focus}` };
  });
}

// Select a deterministic group, never claim semantic recognition. A single
// image samples across the pool; sets rotate groups so later photos are used.
export function selectImageReferences(images, index = 1, outputCount = 1) {
  if (!images.length) return [];
  const candidates = outputCount === 1 && images.length > 4
    ? [0, Math.floor((images.length - 1) / 3), Math.floor(2 * (images.length - 1) / 3), images.length - 1]
    : Array.from({ length: Math.min(4, images.length) }, (_, offset) => (Math.floor((index - 1) * images.length / outputCount) + offset) % images.length);
  let bytes = 0;
  return [...new Set(candidates)].map(position => ({ ...images[position], sourceIndex: position + 1 })).filter(image => {
    if (bytes + image.bytes.length > 24 * 1024 * 1024) return false;
    bytes += image.bytes.length; return true;
  });
}
