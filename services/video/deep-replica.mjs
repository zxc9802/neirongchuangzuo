export const DEEP_IMAGE_KINDS = ['photo', 'product', 'background'];
export const DEEP_KINDS = [...DEEP_IMAGE_KINDS, 'voice'];
export const DEEP_LABELS = { photo: '人脸', voice: '声音', product: '商品', background: '背景' };
export const isDeepReplica = task => task.mode === 'deep';
export const preservesSourceAudio = task => isDeepReplica(task) && !task.replacements.voice;
export const deepImageKinds = task => DEEP_IMAGE_KINDS.filter(kind => task.replacements[kind]);

export function deepGenerationBody(task, defaultModel, resource = kind => `asset://${task.materials[kind].id}`) {
  const images = deepImageKinds(task);
  const reference = kind => `图片${images.indexOf(kind) + 1}`;
  const instructions = [
    '深度复刻视频1，只修改下列明确指定的项目。保留原视频的时长、镜头顺序、构图、人物动作、表情、口型、说话节奏、字幕和台词，不新增镜头、人物、动作或旁白。',
    task.replacements.photo
      ? `将视频1中人物的脸部外貌和发型替换为${reference('photo')}中的人物，保持身份一致，不混合原人物五官；人物的服装、身体动作和所在位置保持原样。`
      : '保留视频1原人物的脸部、发型、服装和身份，不得替换人物。',
    task.replacements.product
      ? `将视频1中展示的商品替换为${reference('product')}中的商品，准确保留参考商品的形状、颜色、包装、品牌和文字；沿用原商品的位置、运动轨迹和展示方式，保持手部握持、遮挡、透视、光影自然，逐帧保持商品一致。只替换商品，不引入商品参考图的背景或人物。`
      : '保留视频1原商品及其包装、标识、文字和展示方式，不得替换商品。',
    task.replacements.background
      ? `将视频1的场景背景替换为${reference('background')}中的场景，保持原镜头运动和构图，匹配透视、光照、人物及商品边缘、接触阴影和遮挡关系。不引入背景参考图中的额外人物或商品。`
      : '保留视频1原背景、场景陈设和光照，不得替换背景。',
    '所有指定替换从第一帧持续到最后一帧，未指定的内容保持原样。不要改变视频速度或重新设计口型。',
  ];
  if (task.video?.duration) instructions.push(`视频1实际时长为${task.video.duration.toFixed(3)}秒，动作严格对应原视频时刻，不延伸或重复片段。`);
  return { modelId: task.model || defaultModel, abilityType: 'VIDEO', prompt: instructions.join('\n'),
    payload: { params: { mode: 'fusion_video', resolution: '720p', scale: 'adaptive', duration: -1, generateAudio: false },
      resources: images.map(resource), referVideoUrl: [resource('video')] } };
}
