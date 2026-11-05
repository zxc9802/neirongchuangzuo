export const SALES_SKILL = 'ai-sales';
export const canUseAiSales = user => Boolean(user?.id && ['义鹏', 'admin'].includes(user.account));
export const SALES_SETTINGS = { model: 'doubao-seedance-2-5-260628', duration: 30, resolution: '480p', ratio: '9:16', language: 'zh', generateAudio: true };
export const SALES_DIRECTION = { id: SALES_SKILL, name: 'AI带货', description: '人物出镜，讲清产品卖点', focus: '人物开场、产品展示与场景穿插、人物收尾。基于实拍编排带货短片。' };
