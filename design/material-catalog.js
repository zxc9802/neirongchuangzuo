import { INDUSTRIES } from './business-catalog.js';
const photo = id => `/media/photo-${id}.jpg`;

const existingReferences = [
  { id: 'coffee-new', title: '把春天，装进一杯咖啡', description: '自然光、干净背景，让新品成为画面主角。', image: photo('1509042239860-f550ce710b93'), mode: 'image', skill: '招牌项目', category: '咖啡茶饮', kind: '图片', height: 'tall', prompt: '使用我的饮品实拍做一张春日新品宣传图。保持饮品外观真实，采用自然光和干净背景，留出标题与门店名称的位置。不要编造价格和优惠。' },
  { id: 'restaurant-story', title: '街角小店，也值得被看见', description: '从门口到餐桌，展现门店真实氛围。', image: photo('1517248135467-4c7edcad34c4'), mode: 'video', skill: '门店发现', category: '餐饮美食', kind: '视频', height: 'short', prompt: '用门店实拍制作一条同城宣传短片。先展示空间氛围，再展示招牌项目，结尾邀请顾客到店。整体温暖自然，门店名称和地址使用我提供的信息。' },
  { id: 'bakery-morning', title: '今日的快乐，刚刚出炉', description: '温暖的烘焙色调，让日常上新更有食欲。', image: photo('1509440159596-0249088772ff'), mode: 'image', skill: '活动海报', category: '餐饮美食', kind: '图片', height: 'medium', prompt: '用上传的烘焙产品照片做一张今日上新海报，暖色自然光，保留面包真实质感。主标题为“今日新鲜出炉”，底部预留门店信息。' },
  { id: 'salon-style', title: '新发型，新的好心情', description: '用细节与质感呈现门店的专业服务。', image: photo('1562322140-8baeececf3df'), mode: 'mix', skill: '招牌合集', category: '美业养生', kind: '混剪', height: 'tall', prompt: '把门店实拍剪成一条发型服务宣传片。按沟通、操作细节、最终效果的顺序编排，保留真实发型效果，音乐轻松自然。' },
  { id: 'gym-space', title: '下班以后，给自己一小时', description: '明亮空间与真实器械，展示训练环境。', image: photo('1534438327276-14e5300c3a48'), mode: 'video', skill: '到店实录', category: '运动健身', kind: '视频', height: 'medium', prompt: '用健身房实景素材制作一条环境介绍短片，展示训练区、器械和课程空间。画面明亮，节奏有活力，不编造健身效果或课程优惠。' },
  { id: 'boutique-new', title: '你的衣橱，该换季了', description: '从陈列到搭配，呈现门店当季风格。', image: photo('1441986300917-64674bd600d8'), mode: 'image', skill: '朋友圈九宫格', category: '生活零售', kind: '图片', height: 'short', prompt: '使用门店服装与陈列照片，制作一组春季上新朋友圈图片。统一米白与自然色调，突出真实服装款式，不改变材质、图案和颜色。' },
  { id: 'cafe-weekend', title: '周末，来这里放慢一点', description: '把门店的松弛感变成顾客的到店理由。', image: photo('1554118811-1e0d58224f24'), mode: 'image', skill: '门店氛围', category: '咖啡茶饮', kind: '图片', height: 'medium', prompt: '使用我的咖啡店实景照片，制作一张周末到店邀请图，保持空间布局真实，突出温暖光线与舒适氛围。标题“周末，来坐坐”。' },
  { id: 'owner-welcome', title: '关于这家店，想和你聊聊', description: '用老板的口吻，讲清门店特色与初心。', image: '/media/owner-reference.png', mode: 'avatar', skill: '老板介绍', category: '咖啡茶饮', kind: '数字人', height: 'tall', prompt: '大家好，我是【门店名称】的老板。我们希望给大家带来【门店特色】。店里最值得体验的是【招牌项目】。我们在【门店地址】，欢迎有空过来坐坐。' },
  { id: 'fresh-menu', title: '这一口，是店里的招牌', description: '食物近景与清晰层次，突出新鲜和食欲。', image: photo('1547592180-85f173990554'), mode: 'image', skill: '招牌项目', category: '餐饮美食', kind: '图片', height: 'short', prompt: '使用菜品原图设计招牌菜宣传图，保留菜品分量和摆盘真实，突出新鲜食材、自然色彩与食欲感。为菜名和门店信息留白。' },
  { id: 'yoga-everyday', title: '找回身体自己的节奏', description: '柔和、安静，展示瑜伽空间与练习氛围。', image: photo('1544367567-0f2fcb009e0b'), mode: 'image', skill: '活动海报', category: '运动健身', kind: '图片', height: 'medium', prompt: '使用瑜伽工作室实拍制作一张课程介绍海报，风格安静自然，浅色背景，留出课程名称和预约信息。不添加未经确认的功效承诺。' },
  { id: 'opening-day', title: '新店开门，期待与你见面', description: '将筹备、布置与开业瞬间串成一条短片。', image: photo('1511795409834-ef04bbd61622'), mode: 'mix', skill: '活动快剪', category: '生活零售', kind: '混剪', height: 'tall', prompt: '用门店筹备与活动实拍剪一条开业预告。开头展示空间亮点，中段展示布置和准备过程，结尾放入我提供的开业时间、门店名称与地址。' },
  { id: 'dinner-together', title: '好好吃饭，就在家附近', description: '从环境到菜品，让附近的人发现这家店。', image: photo('1552566626-52f8b828add9'), mode: 'video', skill: '同城团购', category: '餐饮美食', kind: '视频', height: 'medium', prompt: '根据餐厅实拍做一条面向附近居民的宣传视频，展示就餐环境和招牌菜。只有我提供了套餐价格、内容和有效期时，才展示团购信息。' },
];

const metadata = {
  'coffee-new': ['dining', 'case', '饮品近景'],
  'restaurant-story': ['dining', 'visit', '门店环境'],
  'bakery-morning': ['dining', 'promotion', '烘焙产品'],
  'salon-style': ['beauty', 'case', '服务过程'],
  'gym-space': ['fitness', 'visit', '场地器械'],
  'boutique-new': ['retail', 'guide', '陈列搭配'],
  'cafe-weekend': ['dining', 'visit', '空间氛围'],
  'owner-welcome': ['dining', 'brand', '人物形象'],
  'fresh-menu': ['dining', 'case', '招牌菜品'],
  'yoga-everyday': ['fitness', 'case', '课程场景'],
  'opening-day': ['retail', 'promotion', '活动布置'],
  'dinner-together': ['dining', 'visit', '用餐空间'],
};

const factoryReferences = [
  {
    id: 'factory-oem', title: '一件产品，是这样做出来的', description: '从车缝、工位到制作细节，让采购看见承接业务的具体过程。',
    image: '/media/factory-sewing.jpg', industries: ['oem'], purpose: 'inquiry', mode: 'video', skill: '工厂询价',
    category: '生产代工', kind: '视频', height: 'tall', materialTag: '车间工位',
    prompt: '使用我的真实车间、车缝工位与成品素材，按产品、工序、交付条件的顺序制作代工介绍。以实拍说明可做的产品和工艺，起订、打样和交期只使用确认的信息；不把参考照片中的工厂或设备作为我的经营事实。',
  },
  {
    id: 'factory-direct', title: '从成品，看懂材质与做工', description: '用成品全貌和局部细节，把工厂直销的产品展示清楚。',
    image: '/media/factory-showroom.jpg', industries: ['factory-retail'], purpose: 'guide', mode: 'image', skill: '选购攻略',
    category: '工厂直销', kind: '图片', height: 'medium', materialTag: '成品展示',
    prompt: '根据我的家具成品原图制作工厂直销选购图，保留真实款式、颜色、尺寸比例和材质。依次展示全貌、局部做工和选购依据，再说明我提供的定制范围、看样与交付条件，不编造厂价、库存或包安装承诺。',
  },
  {
    id: 'industrial-process', title: '让加工细节，说明专业', description: '机器、材料和加工特写，帮助客户判断工艺是否符合需求。',
    image: '/media/factory-machining.jpg', industries: ['industrial'], purpose: 'inquiry', mode: 'mix', skill: '工厂询价',
    category: '工业加工', kind: '混剪', height: 'medium', materialTag: '加工工艺',
    prompt: '用我提供的加工实拍片段，按设备与材料、加工过程、成品细节的顺序混剪。用对应镜头说明承接工艺和规格，结尾说明询价需要的资料。没有实证的精度、产能、认证、客户和交期不要补写。',
  },
  {
    id: 'factory-woodcraft', title: '从一道工序，看到成品的来处', description: '材料纹理、制作过程与做工细节，适合展示加工能力和产品来源。',
    image: '/media/factory-woodcraft.jpg', industries: ['factory-retail', 'oem', 'industrial'], purpose: 'case', mode: 'video', skill: '服务案例',
    category: '生产加工', kind: '视频', height: 'short', materialTag: '制作细节',
    prompt: '用我的材料、加工过程和实际成品照片制作过程展示视频。以现有素材连接一道工序与最终成品，保留材质与产品结构，不新增未拍摄的生产线，不夸大手工比例、产品效果或产能。',
  },
  {
    id: 'wholesale-supply', title: '货品在哪里，供货怎么走', description: '仓储、货架与备货现场，直观展示供货业务的日常。',
    image: '/media/wholesale-warehouse.jpg', industries: ['wholesale'], purpose: 'inquiry', mode: 'image', skill: '工厂询价',
    category: '批发供货', kind: '图片', height: 'short', materialTag: '仓储备货',
    prompt: '用我的仓储、货品与陈列实拍做一组供货介绍图。先展示实际品类，再讲清起批、混批、补货和发货条件。库存、发货量和价格必须使用确认信息，不把照片中的货品数量当作经营数据。',
  },
  {
    id: 'wholesale-packing', title: '每一份发货，都有看得见的细节', description: '拣货、包装与交付过程，让客户了解实际发货安排。',
    image: '/media/wholesale-packing.jpg', industries: ['wholesale', 'oem'], purpose: 'brand', mode: 'mix', skill: '品牌展示',
    category: '批发供货', kind: '混剪', height: 'tall', materialTag: '打包发货',
    prompt: '把我的拣货、核对、包装与交付实拍编排成供货日常短片。重点呈现实际包装方式与核对过程，只展示已确认的发货安排，不虚构订单数、客户数量、库存规模或送达时效。',
  },
].map(item => ({ ...item, sourceLabel: '摄影参考' }));

const generatedReferences = [
  { id:'ai-industrial-xhs-cover', presetId:'xiaohongshu-cover', title:'找加工厂，这4点先说清', description:'红黑大字、四张文案便签与工艺小图，把加工需求讲明白，引导客户带图咨询。', industries:['industrial'], purpose:'inquiry', mode:'image', skill:'工厂询价', category:'工业加工', kind:'图片', height:'tall', materialTag:'小红书推销封面', prompt:'使用我自己的加工工序、设备与样件真实照片，设计一张3:4的小红书推销笔记封面。米白底配红黑大字，采用便签式高信息密度排版，文字占画面约70%，工艺图只作小幅辅图。大标题“找加工厂，这4点先说清”，用口语化副标题和四张短文案卡片依次说明材料与用途、样件或批量数量、表面处理、关键尺寸与检验要求。底部写“有图纸，工艺还没定？”和“带上图纸或样件，聊聊加工需求”。保留我的真实设备结构和零件外观，企业名称与联系方式只使用我提供的信息，不编造源头厂家、经营年限、价格、精度、产能、认证、客户案例或交期承诺。参考图仅用于版式与风格，不代表我的工厂或加工能力。' },
  { id:'ai-industrial-poster', presetId:'factory-poster', title:'好工艺，看细节', description:'深蓝工业色、金属加工主画面与检验辅图，把加工过程讲清楚。', industries:['industrial'], purpose:'inquiry', mode:'image', skill:'工厂询价', category:'工业加工', kind:'图片', height:'tall', materialTag:'加工宣传海报', prompt:'使用我自己的设备、加工工序与样件原图设计一张工业加工宣传海报。采用深蓝与金属灰配色，以加工主画面搭配检验辅图，保留实际机械结构和零件外观。主标题“好工艺，看细节”，副标题“从加工到检验，让细节说话”，底部“带上图纸或样件，聊聊加工需求”。企业名称与联系方式使用我提供的信息，不编造精度、产能、认证、价格或交期。参考图仅用于构图与风格，不代表我的工厂、设备或加工能力。' },
  { id:'ai-dining-hotpot', title:'热气腾腾，就是到店的理由', description:'红汤、食材与升腾的热气，用近景营造食欲。', industries:['dining'], purpose:'case', mode:'image', skill:'招牌项目', category:'餐饮美食', kind:'图片', height:'tall', materialTag:'火锅菜品', prompt:'参考热气与食物近景的构图，用我的火锅及菜品原图制作招牌宣传图。保留实际食材、份量和锅底颜色，不把参考图中的摆盘或菜品当成套餐内容。' },
  { id:'ai-oem-cutting', title:'从裁片开始，讲清制作过程', description:'版型、面料与裁剪工位，适合展示服装加工的起点。', industries:['oem'], purpose:'case', mode:'video', skill:'服务案例', category:'生产代工', kind:'视频', height:'medium', materialTag:'裁剪工序', prompt:'参考裁剪台的空间与俯拍构图，使用我的真实面料、裁剪和成品素材介绍服装加工过程。只写已确认的承接范围，不虚构设备、工厂面积、起订量或产能。' },
  { id:'ai-beauty-nails', title:'把指尖的细节，拍给顾客看', description:'奶咖配色、自然甲型与近景细节，适合展示美甲风格。', industries:['beauty'], purpose:'case', mode:'image', skill:'服务案例', category:'美业服务', kind:'图片', height:'short', materialTag:'美甲细节', prompt:'参考美甲特写的用光与排版，使用我的实际作品展示款式与细节。保持顾客真实肤色和甲型，不合成前后对比，不把AI风格图当成完成案例。' },
  { id:'ai-industrial-laser', title:'让一道工艺，成为画面主角', description:'深色机器与切割光点形成对比，突出加工过程的视觉节奏。', industries:['industrial'], purpose:'brand', mode:'mix', skill:'品牌展示', category:'工业加工', kind:'混剪', height:'tall', materialTag:'激光切割', prompt:'借鉴工艺特写与冷暖对比，编排我真实拍摄的金属加工片段。用画面说明实际工序，保留安全操作条件，不编造切割精度、设备能力或生产效率。' },
  { id:'ai-retail-flowers', title:'把一间花店的日常，变成邀请', description:'街边入口、花束层次与自然光，构成轻松的到店画面。', industries:['retail'], purpose:'visit', mode:'image', skill:'门店实景', category:'生活零售', kind:'图片', height:'medium', materialTag:'花店陈列', prompt:'参考花店入口与花束层次，使用我自己的店铺和花艺原图制作到店邀请。保持实际门面和售卖品种，店名、地址、价格与营业时间使用我提供的信息。' },
  { id:'ai-wholesale-ceramics', title:'把货盘展示清楚，采购更好选', description:'成组杯盘和整齐陈列，适合按品类讲解供货范围。', industries:['wholesale'], purpose:'guide', mode:'image', skill:'选购攻略', category:'批发供货', kind:'图片', height:'short', materialTag:'陶瓷货盘', prompt:'参考陶瓷货品的成组陈列，用我的实际产品照片按款式与规格整理供货图。保留真实釉色、形状和数量条件，起批、混批、运费和库存均以已确认信息为准。' },
  { id:'ai-dining-dimsum', title:'一笼早茶，拍出清晨的烟火气', description:'竹蒸笼、瓷器和窗边亮光，用俯拍展示小份菜品组合。', industries:['dining'], purpose:'promotion', mode:'image', skill:'活动促销', category:'餐饮美食', kind:'图片', height:'medium', materialTag:'早茶点心', prompt:'借鉴明亮的早茶俯拍构图，用我自己的点心照片整理宣传图。只有确认包含项、人数、价格和使用时间后才写套餐信息，不把参考画面中的全部点心算作活动权益。' },
  { id:'ai-oem-textile', title:'先把材料说清，再谈怎么做', description:'布料层次、纱线与质感特写，帮助展示材料选择方向。', industries:['oem'], purpose:'guide', mode:'image', skill:'选购攻略', category:'生产代工', kind:'图片', height:'short', materialTag:'面料样品', prompt:'参考面料样品桌的分层构图，用我提供的实际布料与工艺样品介绍选材。成分、克重、色号和可供范围只写已确认信息，不用参考图片推断材质参数。' },
  { id:'ai-fitness-pilates', title:'把训练空间的舒适感展示出来', description:'木质器械、柔和绿调与自然光，呈现安静的空间气质。', industries:['fitness'], purpose:'visit', mode:'video', skill:'门店实景', category:'运动健身', kind:'视频', height:'tall', materialTag:'普拉提空间', prompt:'参考自然光和空间层次，使用我的实际训练场地、器械和课程素材制作介绍。保持场地真实，不夸大空间、不增加不存在的设备，不承诺减重或治疗效果。' },
  { id:'ai-industrial-inspection', title:'用检验细节，解释做工要求', description:'卡尺、零件与工作台特写，适合介绍实际检验步骤。', industries:['industrial'], purpose:'inquiry', mode:'image', skill:'工厂询价', category:'工业加工', kind:'图片', height:'medium', materialTag:'零件检验', prompt:'参考检验台上的手部与零件近景，用我的实际检测过程及样件照片介绍加工范围。实际材料、规格与检验方法由我提供，不能从AI画面推断精度或认证。' },
  { id:'ai-factory-furniture', title:'从一张成品桌，看见木作质感', description:'原木纹理、成品比例与工坊空间，呈现家具的整体气质。', industries:['factory-retail'], purpose:'case', mode:'image', skill:'服务案例', category:'工厂直销', kind:'图片', height:'short', materialTag:'家具成品', prompt:'参考家具成品的侧面视角与光线，用我自己的家具原图展示材质和做工。保留真实比例、颜色和结构，尺寸、定制与交付条件只写确认的信息，不暗示图中工坊属于我的工厂。' },
  { id:'ai-wholesale-dispatch', title:'从备货到打包，把交付讲明白', description:'整洁的打包台与包装动作，适合讲述供货日常。', industries:['wholesale'], purpose:'brand', mode:'video', skill:'品牌展示', category:'批发供货', kind:'视频', height:'medium', materialTag:'仓库打包', prompt:'参考打包台和核对动作的镜头顺序，使用我的真实拣货、包装与交付素材介绍日常供货。只写已确认的包装、发货与物流安排，不编造订单量、库存和送达保证。' },
].map(item=>({...item,image:`/media/${item.id}.png`,sourceLabel:'AI 风格示例'}));

const all = [
  ...existingReferences.map(item => ({ ...item, industries: [metadata[item.id][0]], purpose: metadata[item.id][1], materialTag: metadata[item.id][2], sourceLabel: item.id === 'owner-welcome' ? 'AI 形象参考' : '摄影参考' })),
  ...factoryReferences,
  ...generatedReferences,
];
const discoveryOrder = ['factory-oem', 'coffee-new', 'wholesale-supply', 'salon-style', 'industrial-process', 'boutique-new', 'factory-direct', 'restaurant-story', 'gym-space', 'factory-woodcraft', 'fresh-menu', 'wholesale-packing', 'bakery-morning', 'cafe-weekend', 'yoga-everyday', 'opening-day', 'dinner-together', 'owner-welcome'];

export const inspirationItems = [...generatedReferences, ...discoveryOrder.map(id => all.find(item => item.id === id))];
export const MATERIAL_FILTERS = [{ id: 'all', label: '全部行业' }, ...INDUSTRIES.map(item => ({ id: item.id, label: item.label }))];

export function industryForMaterial(item) {
  return item?.industries?.find(id => INDUSTRIES.some(industry => industry.id === id)) || 'dining';
}

export function getMaterialPrompt(item, mode = item.mode) {
  if (item.mode === mode) return item.prompt;
  const output = { image: '制作宣传图或图组', video: '整理视频画面和镜头顺序', mix: '编排实拍视频片段', avatar: '整理自然、可朗读的介绍稿' }[mode] || '整理宣传内容';
  return `参考“${item.title}”的${item.materialTag}表达方式：${item.description}用我提供的真实素材和经营信息${output}。只参考构图、用光与内容组织，不把参考图片中的场地、人物、设备或库存作为我的经营事实。`;
}

// Reference photographs can guide any output format; prefer the current mode
// without replacing an industry's pictures with unrelated businesses.
export function getMaterialItems({ industry = 'all', mode, favorites } = {}) {
  const validIndustry = MATERIAL_FILTERS.some(item => item.id === industry) ? industry : 'all';
  const saved = favorites === undefined ? null : new Set(favorites);
  const items = inspirationItems.filter(item => (validIndustry === 'all' || item.industries.includes(validIndustry)) && (!saved || saved.has(item.id)));
  return mode ? items.toSorted((a, b) => Number(b.mode === mode) - Number(a.mode === mode)) : items;
}
