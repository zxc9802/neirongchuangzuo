export const SALES_SKILL = 'ai-sales';
export const canUseAiSales = user => Boolean(user?.id && ['义鹏', 'admin', 'zxc9911'].includes(user.account));
export const SALES_SETTINGS = { model: 'doubao-seedance-2-5-260628', duration: 30, resolution: '480p', ratio: '9:16', language: 'zh', generateAudio: true };
export const SALES_SCENE_CHARACTER_RULES = '人物与场景融合：凡采用上传实拍场景的镜头，默认让上传人物自然出现在该场景中，合理落位并匹配透视、尺度、光线、接触阴影和遮挡，保留人物脸部、身形与原场景布局，不把人像直接贴在画面上。由编导根据实际素材和镜头逐一判断：如果融入人物会使原场景结构或人物形象出现明显形变，可以不融合人物，优先保持原场景与人物特征，并说明具体原因；不能为了出镜扭曲人物或重造空间。案例中未采用场景的纯产品特写和局部细节，不强制人物出镜。已因形变风险采用不融合安排的镜头，视频生成时沿用该安排，不重新强行加入人物。';
export const SALES_DIRECTION = { id: SALES_SKILL, name: 'AI带货', description: '用作品展示你的AI创作能力', focus: '义鹏以AI视频创作者身份开场，中段展示行业宣传片案例，结尾回到创作者，引导关注或咨询。门店是案例，推广主体是义鹏的AI创作能力。' };
