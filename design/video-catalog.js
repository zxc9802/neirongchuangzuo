export const VIDEO_SKILLS = [
  { id: 'store-discovery', name: '门店发现', description: '突出特色，给附近的人一个到店理由', focus: '找到照片支持的门店特色，展示环境、产品与服务，形成具体到店理由。' },
  { id: 'store-visit', name: '到店实录', description: '真实体验，建立消费信任', focus: '根据实拍编排一次连贯的到店体验，展现选择、体验与细节，没有实拍支持的服务环节不可编造。', placeholder: '想展示怎样的一次到店体验？', request: '分析实拍，编排一条有参与感的到店实录，展示到店体验与细节。' },
  { id: 'signature', name: '招牌体验', description: '聚焦招牌，证明门店价值', focus: '围绕可确认的一款或一组主推产品，展示整体、局部与体验理由。环境作背景；口味、原料和工艺需要文字资料支持。', placeholder: '想主推哪款产品或特色服务？', request: '分析实拍，选择有辨识度的主推产品，编排一条招牌体验视频。' },
  { id: 'group-buy', name: '同城团购', description: '突出优惠，推动到店核销', focus: '围绕真实套餐内容、价格、使用条件和期限编排。未提供必要事实时先追问，不能编造优惠与活动。', placeholder: '告诉编导套餐内容、价格、有效期和使用条件…', request: '根据实拍编排同城团购视频，缺少套餐资料时先告诉我需要补充什么。' },
];
export const VIDEO_HOOKS = ['直击产品核心痛点', '利用新奇场景开场', '制造强烈情绪反转', '用反常识观点开场', '真实痛点引出需求', '强烈对比突出差异'];
export const videoAssetPurpose = asset => asset.type === 'audio' ? 'voice' : asset.purpose === 'character' ? 'character' : 'reference';
export const VIDEO_MODELS = [
  { id: 'doubao-seedance-2-0-fast-260128', name: 'Plus模型', durations: [4, 5, 6, 8, 10, 12, 15], resolutions: ['480p', '720p'], maxImages: 9 },
  { id: 'doubao-seedance-2-0-260128', name: 'Pro模型', durations: [4, 5, 6, 8, 10, 12, 15], resolutions: ['480p', '720p', '1080p'], maxImages: 9 },
  { id: 'doubao-seedance-2-5-260628', name: 'Max模型', durations: [4, 5, 6, 8, 10, 12, 15, 20, 25, 30], resolutions: ['480p', '720p', '1080p'], maxImages: 30 },
];
export const VIDEO_RATIOS = ['9:16', '16:9', '3:4', '4:3', '1:1', '21:9'];
export const VIDEO_LANGUAGES = [{ id: 'zh', name: '中文' }, { id: 'en', name: '英文' }, { id: 'th', name: '泰语' }, { id: 'ms', name: '马来语' }, { id: 'pt', name: '葡萄牙语' }];
export const DEFAULT_VIDEO_SETTINGS = { model: VIDEO_MODELS[2].id, duration: 25, ratio: '9:16', resolution: '720p', language: 'zh', generateAudio: true };
