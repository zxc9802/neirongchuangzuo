export const SALES_SKILL = 'ai-sales';
export const canUseAiSales = user => Boolean(user?.id && ['义鹏', 'admin', 'zxc9911'].includes(user.account));
export const SALES_SETTINGS = { model: 'doubao-seedance-2-5-260628', duration: 30, resolution: '480p', ratio: '9:16', language: 'zh', generateAudio: true };
export const SALES_DIRECTION = { id: SALES_SKILL, name: 'AI带货', description: '用作品展示你的AI创作能力', focus: '义鹏以AI视频创作者身份开场，中段展示行业宣传片案例，结尾回到创作者，引导关注或咨询。门店是案例，推广主体是义鹏的AI创作能力。' };
