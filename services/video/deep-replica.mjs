export const DEEP_IMAGE_KINDS = ['photo', 'product', 'background'];
export const DEEP_KINDS = [...DEEP_IMAGE_KINDS, 'voice'];
export const DEEP_LABELS = { photo: '人物', voice: '声音', product: '商品', background: '背景' };
export const isDeepReplica = task => task.mode === 'deep';
export const ENHANCED_EDIT_MODELS = {
  'doubao-seedance-2-0-260128': 'las-video-edit-seedance-2-0',
  'doubao-seedance-2-0-fast-260128': 'las-video-edit-seedance-2-0-fast',
  'doubao-seedance-2-0-mini-260615': 'las-video-edit-seedance-2-0-mini',
  'doubao-seedance-2-5-260628': 'las-video-edit-seedance-2-5',
};
export const isEnhancedEdit = task => isDeepReplica(task) && task.editMode === 'enhanced';
export const preservesSourceAudio = task => isDeepReplica(task) && !task.replacements.voice;
export const deepImageKinds = task => DEEP_IMAGE_KINDS.filter(kind => task.replacements[kind]);

export function deepGenerationBody(task, defaultModel, resource = kind => `asset://${task.materials[kind].id}`) {
  const images = deepImageKinds(task);
  const reference = kind => `图片${images.indexOf(kind) + 1}`;
  const instructions = [
    '深度复刻视频1，同时完成原视频叠加水印去除和下列明确指定的替换。保留原视频的时长、镜头顺序、构图、人物动作、表情、口型、说话节奏和台词，不新增镜头、人物、动作或旁白。',
    '删除视频1画面中已有的平台和作者水印，包括抖音/TikTok、快手、小红书等平台的图标及名称、抖音号等账号ID、@用户名、作者昵称及其相邻角标。无论水印位于左上角、右上角、底部还是随时间移动，都要从第一帧到最后一帧去除，包括半透明文字和图案水印，并自然重建被遮挡的背景，不得保留、复制或新增水印，不用模糊、马赛克、色块或裁切画面的方式遮盖水印。去水印要求优先于背景保留要求。商品包装文字和场景中的真实招牌不属于水印，不得因去水印而误删；台词字幕按下列字幕要求处理，商品和背景仍按下列替换项目处理。',
    '去除视频1中画面叠加的台词字幕，包括单行、多行、逐字出现、不同位置和不同字体的字幕，从第一帧到最后一帧均不保留、重画或新增台词字幕、文字笔画或乱码。最终成片不需要字幕，系统也不会补字幕。自然重建字幕遮挡的衣服、皮肤、手部、商品和背景纹理，保持细节清晰、光影一致、跨帧连续；不得用模糊、马赛克、色块、涂抹、裁切或覆盖条遮盖字幕，不留重影、糊块或修补边界。这项字幕清理要求优先于背景保留要求；商品包装文字和场景中的真实招牌不得作为台词字幕删除。',
    task.replacements.photo
      ? `将视频1中人物的脸部外貌和发型替换为${reference('photo')}中的人物，保持身份一致，不混合原人物五官。人物的服装也替换为${reference('photo')}中可见的服装，准确还原款式、颜色、材质、图案和穿着层次，不保留与参考服装不一致的原衣物，不新增参考图中不存在的衣服文字或装饰。整套穿着以人物参考图为唯一服装参考，从内搭到外层全部替换，包括上衣、裤子或裙子、鞋子及围裙、马甲、外套、袖套、手套等全部穿戴物。参考图中没有的原视频围裙、马甲、外套、袖套、手套必须移除；参考图为短袖或裸手时，按图露出相应皮肤，不得把原袖套、手套当作身体或动作的一部分保留。附属于被替换衣物的肩带、系带、口袋、徽标和文字一并移除，不得只换里面一件而保留原围裙或外套，不得把原衣物叠加到参考服装外面。人物所穿衣物及其标识按本条人物替换要求处理，不得因保留商品、标识或未指定内容而保留原服装；手持或独立展示的商品仍按商品要求处理。服装随身体动作自然变化，褶皱、光影和遮挡合理，从第一帧到最后一帧保持服装一致；身体动作、姿态和所在位置沿用原视频，不引入人物参考图的背景或其他人物。`
      : '保留视频1原人物的脸部、发型、服装和身份，不得替换人物。',
    task.replacements.product
      ? `将视频1中展示的商品替换为${reference('product')}中的商品，准确保留参考商品的形状、颜色、包装、品牌和文字；沿用原商品的位置、运动轨迹和展示方式，保持手部握持、遮挡、透视、光影自然，逐帧保持商品一致。只替换商品，不引入商品参考图的背景或人物。`
      : task.replacements.background
        ? '本次替换背景但未提供商品参考图，不保留原视频中的任何商品和场景道具。原片中的食品、锅具、餐具、摊车、展示柜和台面全部随原场景移除，不得自行认定它们是需要保留的主体商品；场景物件只来自背景参考图。'
        : '保留视频1原商品及其包装、标识、文字和展示方式，不得替换商品。',
    task.replacements.background
      ? `将视频1的场景背景替换为${reference('background')}中的场景，${reference('background')}是新场景的唯一视觉依据。完整替换原场景的近景、中景和远景，不得保留、搬入、拼接或混合原视频背景中的任何物件、纹理、文字、标识、反射或影子，包括人物身旁或画面边缘的摊车、展示柜、台面、锅具、餐具、食材、桌椅、招牌、建筑、树木、车辆及路人；即使它们靠近人物、位于前景或被人物遮挡，也属于必须清除的原场景，不得带入新背景。原场景物件不得以商品、道具或场景真实招牌的名义保留，本次原视频只提供主体人物表演、运动轨迹和镜头时间线，不能提供任何新场景物件。${task.replacements.product ? `除主体人物和${reference('product')}指定的商品本体外，全部环境物件只能来自${reference('background')}；原片的商品陈列台、摊车和器具不属于商品本体，不得保留。` : '除主体人物外，所有画面物件只能来自背景参考图，不设原片商品或道具的保留例外。'}人物移动后显露的区域也必须按背景参考图补全，从第一帧到最后一帧不得出现原场景残留、叠影或闪回。保持原镜头运动和主体构图，按新场景匹配透视、光照、人物及主体商品边缘，重新生成合理的接触阴影和遮挡关系。不引入背景参考图中的额外人物或商品。`
      : '保留视频1原背景、场景陈设和光照，仅修复叠加水印和台词字幕遮挡的区域，不得替换背景。',
    task.replacements.background
      ? '所有指定替换、去水印和去字幕处理从第一帧持续到最后一帧。人物按人物选项处理，新场景和商品只按各自参考图重建，不因保留动作、构图或未选择商品而恢复原场景物件。不要改变视频速度或重新设计口型。'
      : '所有指定替换、去水印和去字幕处理从第一帧持续到最后一帧，未指定的非水印、非字幕内容保持原样。不要改变视频速度或重新设计口型。',
  ];
  if (task.video?.duration) instructions.push(`视频1实际时长为${task.video.duration.toFixed(3)}秒，动作严格对应原视频时刻，不延伸或重复片段。`);
  if (isEnhancedEdit(task)) {
    const template = images.length === 0 ? 'basic' : images.length > 1 ? 'general'
      : images[0] === 'photo' ? 'replace/person_replace' : 'replace/subject_replace';
    return { modelId: ENHANCED_EDIT_MODELS[task.model || defaultModel], abilityType: 'UPDATE_VIDEO', prompt: instructions.join('\n'),
      payload: { params: { video_url: resource('video'), template: { id: template },
        image_urls: images.map(kind => task.materials[kind].url), resolution: '720p', ratio: 'adaptive', duration: -1,
        use_asset_api: true, allow_fallback: false, generate_audio: false, watermark: false } } };
  }
  return { modelId: task.model || defaultModel, abilityType: 'VIDEO', prompt: instructions.join('\n'),
    payload: { params: { mode: 'fusion_video', resolution: '720p', scale: 'adaptive', duration: -1, generateAudio: false },
      resources: images.map(resource), referVideoUrl: [resource('video')] } };
}
