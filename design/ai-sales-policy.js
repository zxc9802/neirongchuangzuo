export const SALES_SKILL = 'ai-sales';
export const canUseAiSales = user => Boolean(user?.id && ['义鹏', 'admin', 'zxc9911'].includes(user.account));
export const SALES_SETTINGS = { model: 'doubao-seedance-2-5-260628', duration: 30, resolution: '480p', ratio: '9:16', language: 'zh', generateAudio: true };
export const SALES_SCENE_CHARACTER_RULES = '人物与场景融合：凡引用场景类素材的镜头，无论首尾、中段、有无口播，都必须同时引用上传的人物照片，并让参考人物在整个镜头内自然融入该场景。场景类素材包括门头、入口、室内外环境和其他真实空间；同一素材同时包含场景与产品时仍按场景处理。不能以无声空镜、画外音或将场景镜头称为产品特写来跳过人物。人物应像在现场拍摄：根据实际空间选择自然站位、坐姿或行走动作，匹配透视、尺度、光线方向与色温、接触阴影和前后遮挡，保留脸部、身形与原场景布局。人物动作服务本镜展示内容，不必每镜正对镜头说话，不遮挡主要展示主体。不把人像直接贴在画面上，不用画中画、分屏、悬浮、明显抠图边缘或不合比例的巨大人物代替自然融合。只引用产品、海报或细节素材而未引用场景类素材的镜头可以不出镜，是否有口播不决定人物要求。若当前构图不适合人物自然融入，应调整站位、景别、取景或换用可用素材，不硬塞人物，不以形变例外取消场景镜头的人物，也不拉伸人物或重造空间。人物照片原背景不作为真实场景。';
export const SALES_DIRECTION = { id: SALES_SKILL, name: 'AI带货', description: '用作品展示你的AI创作能力', focus: '义鹏以AI视频创作者身份开场，中段展示行业宣传片案例，结尾回到创作者，引导关注或咨询。门店是案例，推广主体是义鹏的AI创作能力。' };
