export const GENERATION_MODES = Object.freeze(['single', 'series', 'variations']);
export const VARIATION_STYLES = Object.freeze([
  { name: '简洁纪实', instruction: '简洁纪实风格：真实自然光，克制的色彩，清爽留白，少量易读文字，突出真实主体。' },
  { name: '杂志编辑', instruction: '杂志编辑风格：有层次的栅格与标题层级，精致但不改变场景事实的色彩，清晰的主体与编辑排版。' },
  { name: '生活方式手账', instruction: '生活方式手账风格：自然亲切的纸感、小型注释和手账排版，文字清楚，保留原图真实对象与环境。' },
  { name: '醒目文字海报', instruction: '醒目文字海报风格：突出主标题，强对比且清晰的文字层级，用真实照片作为主体，避免文字覆盖关键主体。' },
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
    const focus = ['主题封面：概括主题，以真实主体和简洁主标题吸引注意。', '主体细节：选择原图中可见的产品、菜品、工艺或环境细节，未提供的细节不得添加。', '场景用途：依据原图和已提供信息展现适合的使用或到店场景，不能虚构顾客、活动和体验。', '信息汇总：整理用户确实提供的名称、特点或服务信息；不补造价格、优惠和评价。'][position];
    return { index, label: `系列第 ${index} 张`, style: '统一系列', prompt: `${common}\n统一系列设计：每张围绕同一个主题，固定色调、字体风格、文字层级、版式体系和光线观感。根据主题和原图确定自然克制的共同配色、清晰易读的字体和一致的光线；不能复制同一张图，也不能改动真实主体事实。\n本张内容分工：${focus}` };
  });
}
