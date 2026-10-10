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
  ];
  return { ...shots[Math.abs(index) % shots.length], sceneType: scene.type, index };
}

export function foodPhotoPrompt({ scene, appearance, plan, corrections = [] }) {
  const entry = SCENES[scene.type] || SCENES.chinese;
  return `依据第一张实拍参考图，把同一份菜品重新拍成更有食欲的小红书商业摄影宣传图。允许AI重构光线、质感和拍摄视角，使食物更精致诱人；必须尽量保持同一道食物的一致性，不生成另一道看起来更高级的菜。输出单张3:4竖版摄影成品，不是空背景，不是抠图贴纸或拼贴。先保持菜品身份，再明确执行目标机位；不要照抄原图的拍摄角度、透视、背景或画面布局。改变相机位置自然产生新的透视，这不等于换菜；不要因为保持一致性就拒绝换角度。
第一张附图始终是菜品身份与全部食物事实的最高依据。下面的视觉档案是观察数据，未知项目保持未知，不把它当成菜名、配方、工艺或制作事实：${JSON.stringify(appearance)}。
保留原图的食物种类、可见组成、可辨数量、相对分量、主体形状、原有浇头/配菜/酱汁、主要颜色和餐具特征；保持可辨识的摆盘关系。可以改善曝光、白平衡、色彩层次、表面润泽、清晰度和食品摄影质感，浅色肠粉保持浅色，牛排保持原有主要颜色和熟度外观。不要加香菜、葱花、芝麻、鸡蛋、配菜、更多肉、浓厚酱汁或新食物；不要减少、合并或复制食物。原图不清晰的配料、内部与背面不能猜造；改变镜头透视和光线时尽量保留能辨认的原貌。不得凭空加蒸汽、切开食品露出新断面或将原有餐具换成另一个造型。
场景匹配：${entry.name}。${entry.setting}。当前场景变化：${plan.placement}。镜头方案：${plan.name}，${plan.camera}。光线：${plan.lighting}，${entry.light}。餐盘应真实接触桌面，透视、照明、景深与接触阴影统一。食物鲜明、干净、清晰、看着有食欲；色调丰富有活力但不过饱和，不出现塑料感、过度锐化或油光泛滥。餐厅场景是宣传设计，不代表商家实际装修，背景不出现真实店名或承诺性信息。
主体位于画面中下部，顶部约25%留简洁背景用于之后加字，底部留适当边距；全部主要食物、餐具边缘完整，主体占画面约55%—75%，不得裁掉主菜。不同图改变角度、景别、背景位置和光线，菜品身份保持一致。只保留实拍中的食物及其餐具，不添加额外餐盘、酒杯、人物、菜单、招牌、二维码、文字、logo或水印。
${corrections.length ? `上一次已完成成品的偏差需要修正，仍依据第一张原图重新拍摄：${JSON.stringify(corrections)}。` : ''}`;
}
