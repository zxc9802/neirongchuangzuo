export const SALES_SKILL = 'ai-sales';
export const canUseAiSales = user => Boolean(user?.id && ['义鹏', 'admin', 'zxc9911'].includes(user.account));
export const SALES_SETTINGS = { model: 'doubao-seedance-2-5-260628', duration: 30, resolution: '480p', ratio: '9:16', language: 'zh', generateAudio: true };
export const SALES_SCENE_CHARACTER_RULES = '人物与场景融合：凡有口播或讲解台词的镜头，无论首尾、中段、场景展示还是产品特写，都必须引用上传的人物照片，并让参考人物在整个口播时段自然出镜讲解，不能以画外音、无人空镜或只拍产品代替。人物合理落位并匹配透视、尺度、光线、接触阴影和遮挡，保留脸部、身形与原场景布局，不把人像直接贴在画面上。无口播的空镜、环境展示和产品细节可以不出镜。若当前构图融入人物会造成明显形变，应调整构图、景别或换用可用场景；也可将本镜改为无口播空镜，把台词按原顺序安排到人物出镜的镜头。有口播时不得用形变例外豁免人物出镜；无口播镜头的合理形变例外可保留，不强行扭曲人物或重造空间。';
export const SALES_DIRECTION = { id: SALES_SKILL, name: 'AI带货', description: '用作品展示你的AI创作能力', focus: '义鹏以AI视频创作者身份开场，中段展示行业宣传片案例，结尾回到创作者，引导关注或咨询。门店是案例，推广主体是义鹏的AI创作能力。' };
