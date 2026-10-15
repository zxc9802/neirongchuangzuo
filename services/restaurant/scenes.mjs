const SCENES = {
  western_fine: { name: '高端西餐厅', setting: '雅致高端西餐厅，深色胡桃木餐桌，背景是柔焦的皮质餐椅、暖色壁灯和简约空间，低调精致，没有浮夸宫殿装修', light: '柔和暖白主光，食物区域明亮，背景琥珀暖光' },
  western_casual: { name: '休闲西餐厅', setting: '明亮的休闲西餐厅，浅木餐桌，背景柔焦的卡座和简洁吊灯，轻松现代', light: '自然窗光，暖白辅助光' },
  neighborhood: { name: '街坊小餐馆', setting: '干净亲切的中式街坊小餐馆，浅色木纹餐桌，背景柔焦的简单木椅、白色墙面和窗户，小店尺度，日常烟火气，绝不豪华化', light: '明亮柔和的自然日光，轻暖色调' },
  hotpot: { name: '火锅餐厅', setting: '热闹感但没有人物的现代中式火锅餐厅，干净木质餐桌，背景柔焦的卡座、红色小面积装饰和暖灯，不在空桌面增加锅具', light: '明亮暖白光，适量红色氛围' },
  barbecue: { name: '烧烤餐馆', setting: '干净的中式烧烤小馆，木质餐桌，背景柔焦的暖灯和简洁餐椅，晚间聚餐氛围，不在空桌上增加食物或炉具', light: '温暖但充足的照明，背景暖黄光' },
  seafood: { name: '海鲜餐厅', setting: '清爽的海鲜餐厅，浅木餐桌，背景柔焦的浅色墙面、简洁餐椅和少量蓝色装饰，不出现活鲜水箱或额外海鲜', light: '清透自然窗光' },
  dessert: { name: '甜品咖啡店', setting: '明亮温馨的甜品咖啡店，奶油白或浅木餐桌，背景柔焦的舒适座椅和小面积绿植', light: '柔和自然日光，清新奶油色调' },
  chinese: { name: '中式家常餐馆', setting: '干净温馨的中式家常餐馆，实用木质餐桌，背景柔焦的普通餐椅和暖白墙面，亲切日常，不豪华化', light: '自然明亮暖白光' },
};
export const SCENE_TYPES = Object.freeze(Object.keys(SCENES));
export const CAMERA_ANGLES = Object.freeze(['overhead', 'oblique', 'low']);

export function foodScene(analysis = {}, profile = {}, facts = {}) {
  const choose = text => /牛排|steak|法餐/i.test(text) ? 'western_fine'
    : /肠粉|粥|面条|汤面|粉面|米粉|拉面|馄饨|饺子|包子|早餐|小吃|快餐/.test(text) ? 'neighborhood'
    : /火锅|涮/.test(text) ? 'hotpot'
    : /烧烤|烤串|烤肉/.test(text) ? 'barbecue'
    : /海鲜|龙虾|生蚝|螃蟹/.test(text) ? 'seafood'
    : /蛋糕|甜品|甜点|咖啡|面包|奶茶/.test(text) ? 'dessert'
    : /披萨|汉堡|意面|西餐/.test(text) ? 'western_casual' : null;
  const visible = (analysis.foodSubjects ?? []).map(subject => subject.label || '').join(' ');
  const type = choose(visible) || (SCENE_TYPES.includes(analysis.presentation?.sceneType) ? analysis.presentation.sceneType : null)
    || choose(String(facts.dishName || '')) || choose(String(profile.category || '')) || 'chinese';
  const angle = CAMERA_ANGLES.includes(analysis.presentation?.cameraAngle) ? analysis.presentation.cameraAngle : 'oblique';
  return { type, angle, ...SCENES[type], key: `${type}:${angle}` };
}

export function foodPhotoPlan(scene, index = 0) {
  const shots = [
    { angle: 'oblique', name: '主视觉', camera: '约45度斜俯拍，完整展示原来的全部菜品及餐盘，食物占画面主体', placement: '餐馆临窗桌位，背景自然柔焦', lighting: '明亮侧窗光配柔和补光，表面有适度自然高光' },
    { angle: 'overhead', name: '俯拍摆盘', camera: '镜头在餐盘正上方90度垂直俯拍，俯视平面构图，不是45度斜拍；餐盘呈接近真实平面形状，桌面没有地平线和远处墙面，完整保留全部食物', placement: '同类型餐馆另一处干净的浅木桌面，只呈现俯视桌面，不照抄参考图窗户和餐椅的位置', lighting: '柔和均匀的日光，明快通透但不过曝' },
    { angle: 'detail', name: '食欲近景', camera: '约35—50度斜拍近景，放大可见食物纹理和原有酱汁光泽，主要食物不被裁断，不虚构切面', placement: '同类型餐馆的靠内餐桌，远处暖灯柔焦', lighting: '柔和侧逆光突出原有纹理，前方补光，真实润泽' },
    { angle: 'table', name: '用餐氛围', camera: '约55度斜俯拍，完整餐盘落在桌面，稍多展示周边环境，菜品仍是视觉中心', placement: '同类型餐馆另一处普通桌位，窗边与餐椅构成自然空间层次', lighting: '暖白光与自然窗光融合，背景柔和，食物明亮' },
    { angle: 'oblique', name: '左侧斜拍', camera: '相机移到菜品左前方，约65度斜俯拍，与主视觉的45度位置明显不同；保留完整食物及餐具，主体沿画面对角线展开', placement: '同类型餐馆内另一处干净餐桌，背景自然柔焦', lighting: '右侧柔和日光，前方适度补光，保留真实色泽' },
    { angle: 'detail', name: '完整菜品近景', camera: '相机移到菜品右前方，约40度近距离斜拍；完整食物及餐具仍在画面内，减少远景面积，强化食物纹理，不裁出不完整的主菜', placement: '同类型餐馆暖光桌位，桌面与食物自然衔接', lighting: '左侧柔和侧逆光与正面补光，原有表面润泽但不增加酱汁' },
    { angle: 'oblique', name: '通透全景', camera: '约75度高位斜俯拍，镜头稍拉远，完整展示原有食品组合及全部餐具；增加桌面呼吸感但不新增餐盘和配菜，主体仍占约60%的画面', placement: '同类型餐馆采光明亮的餐桌', lighting: '均匀暖白日光，通透清晰，避免强烈黄光' },
    { angle: 'table', name: '右侧用餐视角', camera: '相机移到菜品右侧前方，约50度斜俯拍，从另一侧展示原有餐盘及食物关系；完整保留全部主菜，以桌面纵深形成层次', placement: '同类型餐馆靠墙桌位，真实尺度的背景轻柔虚化', lighting: '左侧窗光与柔和顶光结合，食品明亮、背景稍暗' },
    { angle: 'oblique', name: '高位对角构图', camera: '约70度高位拍摄，相机绕主体移动约120度，从与首张明显不同的位置看向完整菜品；完整餐具和食物居中偏下，桌面斜线形成纵深', placement: '同类型餐馆另一张整洁桌面，不复制前几张背景位置', lighting: '柔和正侧光，冷暖平衡，细节鲜明但不过度锐化' },
  ];
  const shot = { ...shots[Math.abs(index) % shots.length] };
  if (scene.type === 'hotpot') shot.camera = shot.camera
    .replace('完整展示原来的全部菜品及餐盘', '主锅完整、原有食材种类清楚可辨，周边配菜盘可自然局部入镜')
    .replace('完整保留全部食物', '主锅完整、原有食材种类清楚可辨，周边配菜盘可自然局部入镜')
    .replace('完整展示原有食品组合及全部餐具', '完整展示主锅及原有食材种类，周边配菜盘可自然局部入镜');
  return { ...shot, sceneType: scene.type, index };
}

export function foodPhotoPrompt({ scene, appearance, plan, corrections = [] }) {
  const entry = SCENES[scene.type] || SCENES.chinese;
  const storeSetting = scene.storeContext?.sourceImageIds?.length
    ? `第二张及后续附图是同一商家实际门店/用餐环境参考，只用于背景与风格，绝不把其中其他食物或人物搬进本张。优先沿用该店真实桌面材质、墙面颜色、椅子类型、空间尺度和灯光元素，参考信息：${JSON.stringify(scene.storeContext.evidence)}。将这道食品放在这家店可能出现的桌位上；可重新组织背景位置与景深、去除背景视觉杂乱，保持小店或大店原有尺度，不凭空豪华化、不照搬高端样板餐厅。整套风格：${scene.storeContext.look}。`
    : `没有门店环境参考时按菜品匹配${entry.name}：${entry.setting}，不声称设计背景就是实际装修。`;
  return `依据第一张实拍参考图，把同一份菜品重新拍成更有食欲的小红书商业摄影宣传图。允许AI重构光线、质感和拍摄视角，使食物更精致诱人；必须尽量保持同一道食物的一致性，不生成另一道看起来更高级的菜。输出单张3:4竖版摄影成品，不是空背景，不是抠图贴纸或拼贴。先保持菜品身份，再明确执行目标机位；不要照抄原图的拍摄角度、透视、背景或画面布局。改变相机位置自然产生新的透视，这不等于换菜；不要因为保持一致性就拒绝换角度。
第一张附图始终是菜品身份与全部食物事实的最高依据。下面的视觉档案是观察数据，未知项目保持未知，不把它当成菜名、配方、工艺或制作事实：${JSON.stringify(appearance)}。
${plan.subjectFocus ? `本张分镜聚焦：${plan.subjectFocus}。只表现第一张参考图中实际可见的食品主体；焦点名称用于选择主体，不是新增食材的许可。` : ''}
${scene.type === 'hotpot' ? appearance.identityScope === 'dish' ? '本张只拍已截取的食品和完整餐具，不因为属于火锅场景就另加锅、肉盘、蔬菜盘或其他未入参考图的食品。' : '火锅特别约束：保留原图已经可见的锅底与食材种类，不新增原图没有的食材类别。允许调整同种肉片、辣椒、蔬菜的数量、分布和摆盘，使画面更诱人，不逐根或逐片照抄。烟囱式锅具的形状保持可辨；俯拍时相机确实移动到锅上方，主锅完整，周边辅盘允许自然局部入镜。' : ''}
保留原图的菜品与食材种类、主要颜色、辨识形态和餐具特征；不把同一道食物变成另一种菜品。允许为宣传摄影调整同类食材的数量、摆放和份量观感，不按原图的片数、根数或盘数一一复制，也不将食材数量作为硬性限制。视觉档案中的pieceCount、dishCount、portion只作观察记录。可以改善曝光、白平衡、色彩层次、表面润泽、清晰度和食品摄影质感，浅色肠粉保持浅色，牛排保持原有主要颜色和熟度外观。原图没有的香菜、葱花、芝麻、鸡蛋、配菜或其他食材种类不能凭空增加；已有同类食材可以重新摆盘，酱汁保持原有类型。不能猜造不明配料、内部结构与背面，不凭空切开食品露出新断面，不将原有餐具换成另一个造型。
场景匹配：${storeSetting}。当前场景变化：${scene.storeContext?.sourceImageIds?.length ? '在参考门店的相同材质和色系内选择不同桌位；俯拍只展示桌面，斜拍可带出柔焦的真实门店元素' : plan.placement}。镜头方案：${plan.name}，${plan.camera}。光线：${plan.lighting}，${entry.light}。餐盘应真实接触桌面，透视、照明、景深与接触阴影统一。食物鲜明、干净、清晰、看着有食欲；色调丰富有活力但不过饱和，不出现塑料感、过度锐化或油光泛滥。
满版摄影，不留文字区、空白条、海报框或大块无意义背景。主体占画面约60%—80%，主菜或主锅完整，保留适当边距；桌面组合周边的辅盘可以自然局部入镜，不为凑齐所有盘子牺牲主菜构图。不同图明确改变角度、景别、背景位置和光线，菜品种类保持一致。只用原图已有种类的食物与餐具，不添加无关酒杯、人物、菜单、招牌、二维码、文字、logo或水印。
${corrections.length ? `上一次已完成成品的偏差需要修正，仍依据第一张原图重新拍摄：${JSON.stringify(corrections)}。` : ''}`;
}
