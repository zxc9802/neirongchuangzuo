// Business facts stay separate from visual directions so switching a template
// cannot accidentally turn another campaign's conditions into a new claim.
export const INDUSTRIES = [
  { id: 'dining', label: '餐饮 · 咖啡茶饮', group: '实体门店', description: '用招牌产品、真实环境和清楚的活动条件吸引到店。' },
  { id: 'beauty', label: '美业 · 生活美容', group: '实体门店', description: '展示实际成品、服务过程与预约条件。' },
  { id: 'retail', label: '生活零售', group: '实体门店', description: '把品类、规格和选购理由说清楚。' },
  { id: 'fitness', label: '运动 · 健身', group: '实体门店', description: '介绍真实场地、课程与体验安排。' },
  { id: 'factory-retail', label: '工厂直销', group: '工厂与供应链', description: '连接真实生产现场、成品与个人购买问题。' },
  { id: 'oem', label: '生产代工', group: '工厂与供应链', description: '讲清承接范围、起订、打样和交期。' },
  { id: 'industrial', label: '工业加工', group: '工厂与供应链', description: '围绕材料、工艺与规格帮助客户判断能否加工。' },
  { id: 'wholesale', label: '批发供货', group: '工厂与供应链', description: '展示货盘、起批条件、混批和发货安排。' },
];

export const PURPOSES = [
  { id: 'visit', label: '门店实景', description: '让客户看见真实环境，知道为什么来、怎么来。' },
  { id: 'case', label: '服务案例', description: '用实际成品和过程回答客户关心的问题。' },
  { id: 'promotion', label: '活动促销', description: '先说明权益，再写清价格、期限与使用条件。' },
  { id: 'guide', label: '选购攻略', description: '按需求、品类或规格，帮客户做选择。' },
  { id: 'inquiry', label: '工厂询价', description: '给采购方足够的信息，带着明确需求来咨询。' },
  { id: 'brand', label: '品牌展示', description: '通过真实人物、空间与产品建立业务认知。' },
];

export const PLATFORMS = [
  { id: 'xiaohongshu', label: '小红书' },
  { id: 'douyin', label: '抖音' },
  { id: 'wechat', label: '朋友圈' },
];

const INDUSTRY_ALIASES = {
  '餐饮': 'dining', '餐饮美食': 'dining', '咖啡': 'dining', '咖啡茶饮': 'dining', '餐饮 / 咖啡': 'dining',
  '美业': 'beauty', '美业养生': 'beauty', '生活美容': 'beauty', '美业 / 养生': 'beauty',
  '零售': 'retail', '生活零售': 'retail', '健身': 'fitness', '运动健身': 'fitness',
  '工厂': 'factory-retail', '工厂直销': 'factory-retail', '生产代工': 'oem', '代工': 'oem',
  '工业加工': 'industrial', '生产加工': 'industrial', '加工': 'industrial', '批发': 'wholesale', '批发供货': 'wholesale',
};
const PURPOSES_BY_INDUSTRY = {
  dining: ['visit', 'promotion', 'case', 'guide', 'brand'],
  beauty: ['case', 'visit', 'promotion', 'guide', 'brand'],
  retail: ['guide', 'visit', 'promotion', 'case', 'brand'],
  fitness: ['visit', 'case', 'promotion', 'guide', 'brand'],
  'factory-retail': ['inquiry', 'guide', 'case', 'visit', 'promotion', 'brand'],
  oem: ['inquiry', 'case', 'guide', 'brand'],
  industrial: ['inquiry', 'case', 'guide', 'brand'],
  wholesale: ['inquiry', 'guide', 'promotion', 'visit', 'brand'],
};

const FIELD_DEFINITIONS = {
  businessName: { label: '商家 / 企业名称', placeholder: '填写对外使用的真实名称', required: true, maxLength: 60 },
  product: { label: '这次介绍什么', placeholder: '具体产品、服务、品类或承接范围', required: true, maxLength: 100 },
  location: { label: '所在地区 / 到访地址', placeholder: '商圈、门店地址或工厂所在地', maxLength: 90 },
  highlights: { label: '值得介绍的真实特点', placeholder: '写具体材料、体验或做法，避免只有“品质好”', required: true, type: 'textarea', maxLength: 180 },
  audience: { label: '希望谁看到', placeholder: '例如：附近上班族、家居买家、服装采购', maxLength: 60 },
  action: { label: '看完后，客户怎么联系或行动', placeholder: '填写预约、到店、看样或询价方式', required: true, maxLength: 120 },
  hours: { label: '营业 / 接待时间', placeholder: '填写实际开放时间；需预约也请注明', maxLength: 80 },
  material: { label: '材料与材质', placeholder: '填写本次产品实际使用或可加工的材质', maxLength: 90 },
  customization: { label: '零售 / 定制条件', placeholder: '能否单件购买，可调整哪些尺寸或款式', maxLength: 90 },
  delivery: { label: '交付 / 安装安排', placeholder: '配送范围、运费和安装如何确认', maxLength: 90 },
  moq: { label: '起订 / 起批条件', placeholder: '填写实际数量条件，可写按款式另行确认', maxLength: 90 },
  sample: { label: '打样方式与条件', placeholder: '来图或来样需要什么，费用如何确认', maxLength: 100 },
  leadTime: { label: '交期确认方式', placeholder: '填写实际安排或影响交期的条件', maxLength: 90 },
  process: { label: '承接工艺', placeholder: '本次可以提供哪些实际加工工序', maxLength: 90 },
  specification: { label: '规格与适用范围', placeholder: '实际尺寸、型号、规格或服务范围', maxLength: 100 },
  drawings: { label: '询价需要的资料', placeholder: '例如图纸格式、材料、数量；只写实际需要的', maxLength: 90 },
  mixedOrder: { label: '混批与补货条件', placeholder: '能否混款、补货怎样确认', maxLength: 90 },
  shipping: { label: '库存与发货安排', placeholder: '现货如何确认、发货范围和运费条件', maxLength: 100 },
  caseDetails: { label: '本次案例的实际情况', placeholder: '做了什么、过程和完成情况；不虚构效果', required: true, type: 'textarea', maxLength: 140 },
  selectionTips: { label: '客户应该怎样选', placeholder: '按需求、尺寸、材料或使用场景给出实际建议', required: true, type: 'textarea', maxLength: 140 },
  promotionKind: { label: '活动类型', required: true, type: 'select', maxLength: 16, options: [
    { value: 'bundle', label: '套餐 / 组合' }, { value: 'voucher', label: '代金券 / 抵扣券' }, { value: 'product', label: '单品活动' },
  ] },
  includes: { label: '套餐实际包含什么', placeholder: '列出包含的菜品、商品或服务与数量', required: true, type: 'textarea', maxLength: 140 },
  people: { label: '适用人数 / 使用数量', placeholder: '例如适合几人、包含几次；填写实际条件', required: true, maxLength: 60 },
  price: { label: '活动价格（元，可选）', placeholder: '没有确定价格可以不填', type: 'number', maxLength: 16 },
  payAmount: { label: '购买券支付金额（元）', placeholder: '消费者购买这张券实际支付多少', required: true, type: 'number', maxLength: 16 },
  faceValue: { label: '可抵扣金额（元）', placeholder: '使用时能抵扣多少消费金额', required: true, type: 'number', maxLength: 16 },
  threshold: { label: '用券门槛', placeholder: '最低消费、每单限用张数；无门槛请明确填写', required: true, maxLength: 90 },
  validity: { label: '活动 / 使用有效期', placeholder: '明确开始和结束日期、可使用的时段', required: true, maxLength: 80 },
  restrictions: { label: '适用范围与限制', placeholder: '适用门店、项目、排除项及叠加规则；没有也请写清', required: true, type: 'textarea', maxLength: 120 },
};
const FACT_KEYS = Object.keys(FIELD_DEFINITIONS);
const INDUSTRY_FACTS = {
  dining: [], beauty: [], retail: [], fitness: [],
  'factory-retail': ['material', 'customization', 'delivery'],
  oem: ['moq', 'sample', 'leadTime'],
  industrial: ['material', 'process', 'specification', 'drawings'],
  wholesale: ['moq', 'mixedOrder', 'shipping'],
};

function industryId(value) {
  const label = typeof value === 'string' ? value.trim() : '';
  return INDUSTRIES.find(item => item.id === label || item.label === label)?.id
    || (Object.hasOwn(INDUSTRY_ALIASES, label) ? INDUSTRY_ALIASES[label] : 'dining');
}

export function getPurposes(industry) {
  return PURPOSES_BY_INDUSTRY[industryId(industry)].map(id => PURPOSES.find(item => item.id === id));
}

function stringValue(value, maxLength) {
  return (typeof value === 'string' || typeof value === 'number' ? String(value) : '').trim().slice(0, maxLength);
}

export function createBrief(profile = {}) {
  return normalizeBrief({}, profile);
}

export function normalizeBrief(input = {}, profile = {}) {
  input = input && typeof input === 'object' ? input : {};
  profile = profile && typeof profile === 'object' ? profile : {};
  const source = {
    ...profile,
    businessName: profile.businessName ?? profile.name,
    location: profile.location ?? profile.address,
    highlights: profile.highlights ?? profile.feature,
    ...input,
  };
  const industry = industryId(source.industry);
  const purposes = getPurposes(industry);
  const brief = {
    industry,
    purpose: purposes.some(item => item.id === source.purpose) ? source.purpose : purposes[0].id,
    platform: PLATFORMS.some(item => item.id === source.platform) ? source.platform : 'xiaohongshu',
  };
  for (const key of FACT_KEYS) brief[key] = stringValue(source[key], FIELD_DEFINITIONS[key].maxLength);
  if (!FIELD_DEFINITIONS.promotionKind.options.some(item => item.value === brief.promotionKind)) brief.promotionKind = 'bundle';
  return brief;
}

export function getBriefFields(input) {
  const brief = normalizeBrief(input);
  const keys = ['businessName', 'product', 'location', 'highlights', 'audience'];
  if (brief.purpose === 'visit') keys.push('hours');
  keys.push(...INDUSTRY_FACTS[brief.industry]);
  if (brief.purpose === 'case') keys.push('caseDetails');
  if (brief.purpose === 'guide') keys.push('selectionTips');
  if (brief.purpose === 'promotion') {
    keys.push('promotionKind');
    if (brief.promotionKind === 'bundle') keys.push('includes', 'people', 'price');
    if (brief.promotionKind === 'voucher') keys.push('payAmount', 'faceValue', 'threshold');
    if (brief.promotionKind === 'product') keys.push('specification', 'price');
    keys.push('validity', 'restrictions');
  }
  keys.push('action');
  return [...new Set(keys)].map(key => {
    const field = { key, ...FIELD_DEFINITIONS[key], required: Boolean(FIELD_DEFINITIONS[key].required) };
    if (key === 'location' && brief.purpose === 'visit') field.required = true;
    if (brief.purpose === 'inquiry' && INDUSTRY_FACTS[brief.industry].includes(key) && key !== 'drawings') field.required = true;
    if (key === 'specification' && brief.purpose === 'promotion' && brief.promotionKind === 'product') field.required = true;
    return field;
  });
}

export function validateBrief(input) {
  const brief = normalizeBrief(input);
  const errors = {};
  const fields = getBriefFields(brief);
  for (const field of fields) {
    const value = brief[field.key];
    if (field.required && !value) errors[field.key] = `请填写${field.label}`;
    else if (field.type === 'number' && value && (!/^\d+(?:\.\d{1,2})?$/.test(value) || Number(value) <= 0 || !Number.isFinite(Number(value)))) {
      errors[field.key] = '请输入大于 0 的金额，最多保留两位小数';
    }
  }
  if (brief.purpose === 'promotion' && brief.promotionKind === 'voucher' && brief.payAmount && brief.faceValue && !errors.payAmount && !errors.faceValue && Number(brief.faceValue) <= Number(brief.payAmount)) {
    errors.faceValue = '抵扣金额应大于购买券的支付金额，请核对活动规则';
  }
  return errors;
}

function factEntries(brief) {
  return getBriefFields(brief)
    .filter(field => brief[field.key] && field.key !== 'promotionKind')
    .map(field => ({ key: field.key, label: field.label.replace(/（.*?）/g, ''), value: brief[field.key] }));
}

function promotionSummary(brief) {
  if (brief.purpose !== 'promotion') return '';
  if (brief.promotionKind === 'voucher') {
    return [brief.payAmount && `购券支付 ${brief.payAmount} 元`, brief.faceValue && `抵扣消费 ${brief.faceValue} 元`].filter(Boolean).join('，');
  }
  const label = brief.promotionKind === 'bundle' ? '套餐' : '单品';
  return brief.price ? `${label}活动价 ${brief.price} 元` : `${label}活动`;
}

function directions(brief, mode) {
  const industrial = ['factory-retail', 'oem', 'industrial', 'wholesale'].includes(brief.industry);
  const styles = {
    visit: '实景与产品为主，自然光、有空间层次，少量文字交代到访信息。',
    case: '实际成品、局部细节与过程结合，普通光线，说明适用条件。',
    promotion: '实物为视觉主体，权益、价格和限制分层排版，避免用整桌或整套画面暗示未包含的商品。',
    guide: '按需求或规格有序对照，统一拍摄角度，用清楚标签帮助选择。',
    inquiry: '真实样件、材料和工序作为证据，接单条件清楚可读。',
    brand: industrial ? '突出真实材料纹理、工序节奏与现场空间，克制调色，少量品牌文字。' : '突出真实空间、产品与服务细节，统一色调，保留日常经营感。',
  };
  const platform = {
    xiaohongshu: '小红书：首图说明一个具体问题，后续按细节、选择条件、行动信息排列，便于保存回看。',
    douyin: '抖音：开头直接给出产品或需求，紧接真实证据，再说明关键条件和下一步；字幕短句分段。',
    wechat: '朋友圈：第一眼看清商家、产品与权益，时间、条件和联系办法放在可读位置，文案简洁。',
  }[brief.platform];
  const modeNote = {
    image: '围绕上传原图制作图组，保留产品结构、材质、标识与真实场地，不生成不存在的店面或设备。',
    video: '根据上传素材安排竖屏镜头，不补造未提供的生产、服务或成交场景。',
    mix: '只用已上传的真实片段混剪，按内容组织镜头，片段不能证明的事实不加字幕。',
    avatar: '数字人口播只解释已填写的事实，保留适用条件；人物不冒充消费者评价。',
  }[mode] || '保留上传素材中的真实产品与场地。';
  const beauty = brief.industry === 'beauty' ? '保留真实肤色、发质、甲型与完成效果，不合成前后对比或夸大服务效果。' : '';
  return { style: styles[brief.purpose], platform, modeNote, beauty };
}

function buildShots(brief, mode) {
  const opening = brief.platform === 'douyin' ? '开场：先看实物或需求' : brief.platform === 'wechat' ? '首图：商家与本次主题' : '封面：一个清楚的主题';
  const sets = {
    visit: [
      ['看见环境', '展示上传的实际空间、入口或座位，不扩大场地。'],
      ['体验细节', '用真实产品或服务细节解释到访理由。'],
      ['到访安排', '呈现已填写的地址、接待时间和行动方式。'],
    ],
    case: [
      ['真实完成情况', '展示本次案例的实际成品，不生成新的结果。'],
      ['过程与细节', '选取对应的过程素材，并说明已提供的案例条件。'],
      ['适用与咨询', '整理真实案例信息和联系办法，不承诺每个人获得相同效果。'],
    ],
    promotion: [
      [brief.promotionKind === 'voucher' ? '购券与抵扣' : '实际包含项', brief.promotionKind === 'voucher' ? '支付金额与可抵扣金额分别呈现；实物展示不代表券价包含所有商品。' : '以已填写的商品或服务为准，清楚展示本次权益。'],
      ['活动条件', '有效期、适用范围与限制必须清晰可读。'],
      ['行动信息', '写明已提供的购买、预约或到店方式。'],
    ],
    guide: [
      ['按需求分类', '按照已填写的选购建议和真实品类组织素材。'],
      ['细节对照', '用已有素材比较规格、材质或使用场景，不增加不存在的款式。'],
      ['选择与联系', '收拢选择建议，并展示已提供的咨询或到访方式。'],
    ],
    inquiry: [
      ['产品与承接范围', '优先展示相关实物、样件或货盘，让客户判断是否匹配。'],
      ['事实与条件', '结合真实材料、工序或规格，呈现已填写的合作条件。'],
      ['带着需求来咨询', '交代商家已填写的询价资料要求和联系方式。'],
    ],
    brand: [
      ['现场与人物', '使用真实经营或生产现场，保留业务辨识度。'],
      ['产品与做法', '围绕填写的特点选择材料、产品或服务细节。'],
      ['记住业务与联系', '以真实商家名称、业务和行动方式收尾。'],
    ],
  };
  return [
    { title: opening, description: `${brief.product ? `以“${brief.product}”为主题，` : ''}选择一张能说明本次业务的真实素材${mode === 'image' ? '作为首图。' : '作为开场。'}` },
    ...sets[brief.purpose].map(([title, description]) => ({ title, description })),
  ];
}

function speakFact({ key, value }) {
  const opening = {
    location: '我们在', highlights: '', audience: '这次的介绍，面向', hours: '接待时间是',
    material: '材料方面，', customization: '购买和定制条件，', delivery: '交付安排，',
    moq: '起订条件，', sample: '打样方式，', leadTime: '交期安排，', process: '承接的工艺，',
    specification: '具体规格与适用范围，', drawings: '询价时请提供这些资料，',
    mixedOrder: '混批和补货条件，', shipping: '库存与发货安排，', caseDetails: '这次案例的情况是，',
    selectionTips: '选择时，可以参考这些建议，', includes: '套餐包含', people: '适用人数或使用数量，',
    threshold: '用券条件，', validity: '有效期为', restrictions: '适用范围和限制，',
  };
  return `${opening[key] || ''}${value}`;
}

function contentTitle(brief, purpose) {
  const topic = brief.product || purpose.label;
  const inquiryTopic = {
    'factory-retail': '材质与定制怎么选',
    oem: '起订和打样怎么确认',
    industrial: '材料与工艺怎样对上需求',
    wholesale: '起批、混批和发货怎么安排',
  }[brief.industry] || '合作条件怎么确认';
  const visitTopic = {
    dining: '来之前，先看看产品和店里的样子',
    beauty: '先看环境，再了解服务安排',
    retail: '来逛之前，先认识这家店',
    fitness: '场地与接待安排，先看清楚',
  }[brief.industry] || '看样之前，先了解现场与接待安排';
  const promotional = brief.promotionKind === 'voucher'
    ? `${promotionSummary(brief) || '代金券活动'}，用券条件看清楚`
    : brief.promotionKind === 'bundle' ? '套餐包含什么、怎么用' : '单品活动，规格与使用条件看清楚';
  const themes = {
    visit: visitTopic,
    case: brief.industry === 'beauty' ? '看看这次实际完成的样子与细节' : '这次实际做了什么',
    promotion: promotional,
    guide: '怎么选？先看需求与具体条件',
    inquiry: inquiryTopic,
    brand: ['factory-retail', 'oem', 'industrial', 'wholesale'].includes(brief.industry) ? '我们具体做哪些业务' : '认识我们的产品与日常',
  };
  if (brief.platform === 'wechat') {
    const detail = brief.purpose === 'promotion' ? promotionSummary(brief)
      : ({ inquiry: '合作说明', case: '实际案例', guide: '选购说明', visit: '到访信息', brand: '业务介绍' }[brief.purpose]);
    return [brief.businessName, topic, detail].filter(Boolean).join('｜');
  }
  if (brief.platform === 'douyin') return `${topic}，${themes[brief.purpose]}`;
  const usefulLabels = {
    inquiry: inquiryTopic,
    guide: '选购说明：按实际需求做选择',
    visit: '到访前可以看这份实景介绍',
    case: brief.industry === 'beauty' ? '实际完成记录与细节' : '这次案例的过程与完成情况',
    promotion: promotional,
    brand: '产品、现场与我们的做法',
  };
  return `${topic}｜${usefulLabels[brief.purpose]}`;
}

function captionText(brief, facts) {
  const sentences = text => /[。！？.!?]$/.test(text) ? text : `${text}。`;
  const intro = brief.businessName && brief.product
    ? `${brief.businessName}，这次介绍${brief.product}。`
    : [brief.businessName, brief.product].filter(Boolean).join('｜');
  const detailLabels = {
    location: '位置', hours: '接待时间', material: '材质', customization: '零售与定制', delivery: '配送与安装',
    moq: '起订', sample: '打样', leadTime: '交期', process: '加工工艺', specification: '规格与范围',
    drawings: '询价资料', mixedOrder: '混批与补货', shipping: '库存与发货',
    includes: '套餐包含', people: '适用人数 / 数量', threshold: '用券门槛', validity: '有效期', restrictions: '适用范围与限制',
  };
  const details = facts.filter(item => Object.hasOwn(detailLabels, item.key)).map(item => `${detailLabels[item.key]}：${item.value}`);
  const narrative = [
    intro,
    brief.highlights && sentences(brief.highlights),
    brief.audience && `面向${brief.audience}。`,
    brief.purpose === 'case' && brief.caseDetails && sentences(brief.caseDetails),
    brief.purpose === 'guide' && brief.selectionTips && `选购时可以参考：${sentences(brief.selectionTips)}`,
    promotionSummary(brief),
  ].filter(Boolean);
  const spacing = brief.platform === 'douyin' ? '\n' : '\n\n';
  return [narrative.join(spacing), details.join('\n'), brief.action].filter(Boolean).join(spacing);
}

export function buildContentPlan(input, mode = 'image') {
  const brief = normalizeBrief(input);
  const purpose = PURPOSES.find(item => item.id === brief.purpose);
  const industry = INDUSTRIES.find(item => item.id === brief.industry);
  const platform = PLATFORMS.find(item => item.id === brief.platform);
  const facts = factEntries(brief);
  const title = contentTitle(brief, purpose);
  const visual = directions(brief, mode);
  const promotion = promotionSummary(brief);
  const caption = captionText(brief, facts);
  const spokenFacts = facts.filter(item => !['businessName', 'product', 'payAmount', 'faceValue', 'price', 'action'].includes(item.key));
  const script = [
    [brief.businessName && `这里是${brief.businessName}`, brief.product && `这次介绍${brief.product}`].filter(Boolean).join('，'),
    promotion,
    ...spokenFacts.map(speakFact),
    brief.action,
  ].filter(Boolean).map(text => /[。！？.!?]$/.test(text) ? text : `${text}。`).join('\n');
  const factText = facts.map(item => `${item.label}：${item.value}`).join('\n');
  const prompt = [
    `为${industry.label}制作${platform.label}${purpose.label}内容。`,
    `仅使用以下商家提供的信息：\n${factText}`,
    promotion && `活动解释：${promotion}。${brief.promotionKind === 'voucher' ? '这是抵扣券，不是包含画面全部商品的套餐。' : ''}`,
    `视觉方向：${visual.style}`,
    visual.platform,
    visual.modeNote,
    visual.beauty,
    '不得编造价格、销量、产能、认证、客户评价或效果承诺；没有提供的信息不写。优先保证所有活动和合作条件清楚可读。',
  ].filter(Boolean).join('\n');
  const checklist = [
    '上传对应的真实产品、服务、门店或工厂素材',
    '核对商家名称、业务特点与客户行动方式',
    ...(brief.purpose === 'promotion' ? [brief.promotionKind === 'voucher' ? '分别核对购券金额、抵扣金额、用券门槛与适用限制' : '核对实际包含项、适用数量或规格与活动价格', '核对有效期，确保限制条件随内容一起展示'] : []),
    ...(brief.purpose === 'inquiry' ? ['核对承接范围与合作条件，不把未确认的起订或交期写成承诺'] : []),
    ...(brief.industry === 'beauty' ? ['保留真实肤色与完成效果，不制作虚假的前后对比'] : []),
    '发布前检查文案与实际经营情况一致',
  ];
  return { title, caption, prompt, script, shots: buildShots(brief, mode), checklist, style: visual.style, ratio: mode === 'image' ? ({ xiaohongshu: '3:4', douyin: '9:16', wechat: '1:1' }[brief.platform]) : '9:16' };
}
