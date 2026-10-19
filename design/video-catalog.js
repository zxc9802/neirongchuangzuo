export const VIDEO_SKILLS = [
  { id: 'store-discovery', name: '门店发现', description: '突出特色，给附近的人一个到店理由', focus: '找到照片支持的门店特色，展示环境、产品与服务，形成具体到店理由。' },
  { id: 'store-visit', name: '到店实录', description: '串联真实体验，让顾客了解这家店', focus: '根据实拍编排进店、选购或点单、体验、细节与离店的自然顺序。没有实拍支持的服务环节不可编造。' },
  { id: 'signature', name: '招牌体验', description: '聚焦招牌菜、主推产品或特色服务', focus: '围绕可确认的一个或一组招牌产品，展示外观、细节、体验方式和适合人群。口味、原料和制作工艺需要文字资料支持。' },
  { id: 'group-buy', name: '同城团购', description: '讲清套餐与优惠，引导到店使用', focus: '围绕真实套餐内容、价格、使用条件和期限编排。未提供这些必要事实时先追问，不能编造折扣和限时活动。' },
];
export const VIDEO_HOOKS = ['直击核心需求', '利用新奇场景开场', '制造情绪反转', '用反常识观点开场', '真实痛点引出需求', '强烈对比突出差异'];
export const VIDEO_MODELS = [
  { id: 'doubao-seedance-2-0-fast-260128', name: 'Plus模型', durations: [4, 5, 6, 8, 10, 12, 15], resolutions: ['480p', '720p'], maxImages: 9 },
  { id: 'doubao-seedance-2-0-260128', name: 'Pro模型', durations: [4, 5, 6, 8, 10, 12, 15], resolutions: ['480p', '720p', '1080p'], maxImages: 9 },
  { id: 'doubao-seedance-2-5-260628', name: 'Max模型', durations: [4, 5, 6, 8, 10, 12, 15, 20, 25, 30], resolutions: ['480p', '720p', '1080p'], maxImages: 30 },
];
export const VIDEO_RATIOS = ['9:16', '16:9', '3:4', '4:3', '1:1', '21:9'];
export const VIDEO_LANGUAGES = [{ id: 'zh', name: '中文' }, { id: 'en', name: '英文' }, { id: 'th', name: '泰语' }, { id: 'ms', name: '马来语' }, { id: 'pt', name: '葡萄牙语' }];
export const DEFAULT_VIDEO_SETTINGS = { model: VIDEO_MODELS[2].id, duration: 25, ratio: '9:16', resolution: '720p', language: 'zh', generateAudio: true };
