const BRIEFS = {
  'store-visit': `当前模块为「到店实录」：重点是让人看懂一次到店体验如何发生，而不是再做一条装修巡游。
先从实拍中识别可行的体验路径、可展示的产品或服务、可用人物。围绕一个具体消费目的建立连续过程：来到门店、进入空间、选择或接触产品、体验细节、结束与到店提示。这些是候选环节，按素材自主取舍，不能为补全流程虚构收银台、后厨、服务员、上菜、表演或核销操作。
用主观视角、手部细节、桌面与空间关系、前后景切换形成参与感，不要求每次都有人物出镜。有人物参考且用户需要出镜时，先在全片设定中锁定身份、服装与职责；仅设计该空间能够支持的简单演示动作，不伪装成真实顾客评价。旁白可用“进来先看这边”“坐下就能看到”等现场介绍语，不写“我亲测”“吃过才知道”之类虚构经历。
镜头之间有体验顺序和新的信息；一个镜头只完成一个动作或观察重点。把产品细节嵌入体验，不以整片空景慢推代替到店过程。拍不到的步骤可以省略或用已有空间衔接，不能猜测实际动线。声音设计包括真实可支持的轻微环境声与自然口播，不凭空添加驻唱、人潮或顾客评价。`,
  signature: `当前模块为「招牌体验」：围绕一款主推产品、一组明确的招牌组合或一项特色服务建立吸引力，门店环境只作体验背景，不能把本模块写成门店全景介绍。
先列出主推产品可以直接证明的看点，再编排产品的呈现与体验，让主推对象尽早进入画面。不能先连续铺陈门头、走廊、餐位和空桌，产品只露几秒后又用整段环境填满结尾；这会退回门店发现，偏离当前模块。照片中产品少时，围绕实拍能支持的整体、关键局部、同桌搭配和体验关系递进展开，不靠凭空增加菜品或反复空景凑时间。摘要与口播也要说具体可见内容，避免“首选、专业感、档次、完美融合”等空泛结论。
先核对用户指定的主推对象与图片是否对应。未指定时，选择实拍最清楚、最有辨识度的一款或一组，并说明选择；名称不确定时用客观外观称呼，不把推测菜名当成事实。用户指定的产品没有对应素材时，先追问补图或允许改选。
围绕同一个招牌安排整体呈现、关键局部、可见质感、有依据的使用或食用动作、搭配与消费场景。用景别、焦点和动作变化递进呈现价值，不能靠反复展示同一盘同一角度凑镜头，也不要把其他无关产品变成新的主角。多个招牌有清晰分工时可以共同呈现，不强制单品或固定比例。
保持实拍支持的产品类别、关键形态、容器与环境关系。食物重点呈现可见色泽、表面质感和摆盘，不能从照片推断辣度、口感、香气、食材产地、现做工艺、价格或销量。不凭空演示制作过程或食物内部结构；服务类不承诺实际效果。给出明确但有依据的体验理由和自然到店提示。`,
  'group-buy': `当前模块为「同城团购」：把已确认的套餐内容、价格、使用期限与使用条件讲清，再用实拍证明到店能体验什么，不能只有环境宣传和空泛“很划算”。
必要资料通过本次与同方向历史用户消息获取，不另要求商家填写一张复杂表单。缺少套餐内容、价格、有效期或使用条件时先返回clarification，合并询问缺失项；“无额外限制”“长期有效”只能由用户明确确认，不能默认推断。助手旧脚本与图片推测不算商家确认，不能自行编造活动。
一次只问缺失的必要资料。原价、折扣、限量和购买入口均为选填，未提供就跳过，不将原价列为必填问题。
资料完整后，根据真实套餐与照片编排优惠信息开场、套餐主体及可见细节、适用消费场景、必要限制与到店核销提示；顺序和镜头数量自主决定。套餐中的项目未拍到时可在口播中照实说明，但不得生成该项目的虚构画面；不能将未包含的菜品、饮品或服务包装为套餐内权益。缺少所有套餐主体的对应图片时先追问补图。
不虚构原价、节省金额、限量、倒计时或购买渠道。用户未提供购买入口时用“查看套餐详情，确认后到店使用”，不编造左下角链接或平台已上架。重要条件须保留，不把“仅工作日/需预约/不含酒水”等删成无限制。价格与套餐信息优先用清楚的口播、必要时少量字幕，不把促销贴纸盖满画面。
输出script时必须额外在顶层输出offerFacts：{"package":{"value":"套餐内容原文","sourceQuote":"用户消息中的连续原文"},"price":{"value":"价格原文","sourceQuote":"用户消息中的连续原文"},"validity":{"value":"期限原文","sourceQuote":"用户消息中的连续原文"},"conditions":{"value":"条件原文","sourceQuote":"用户消息中的连续原文"}}。每个value必须摘自对应sourceQuote，sourceQuote必须逐字来自用户消息；四项不得凭空补齐。用户补充某项时用最新确认，未改变的资料保留。样例演示活动必须在全片设定中明确“演示资料，非真实促销”。`,
};

export const skillDirection = skill => BRIEFS[skill] || '';

export const OFFER_FIELDS = [
  ['package', '套餐内容'], ['price', '套餐价格'], ['validity', '有效期'], ['conditions', '使用条件'],
];
const normalize = value => typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/g, '') : '';

export function verifyOfferFacts(facts, input) {
  const sources = [...(input.history || []).filter(m => m.role === 'user').map(m => normalize(m.content)), normalize(input.message)];
  const verified = {}, missing = [];
  for (const [key, label] of OFFER_FIELDS) {
    const fact = facts?.[key], value = normalize(fact?.value), quote = normalize(fact?.sourceQuote);
    if (!value || value.length > 800 || !quote || quote.length > 1600 || !sources.some(source => source.includes(quote))
      || key === 'price' && !quote.includes(value)) missing.push(label);
    else {
      const sourceQuote = fact.sourceQuote.trim();
      const canonical = key === 'price' ? fact.value.trim() : sourceQuote.replace(new RegExp(`^${label}\\s*[:：]\\s*`), '');
      verified[key] = { value: canonical, sourceQuote };
    }
  }
  return { facts: verified, missing };
}

export function offerClarification(missing) {
  return { kind: 'clarification', text: '先补充套餐资料，我再根据实拍编排团购视频。',
    questions: [`请补充${missing.join('、')}。`], warnings: [] };
}

export function offerDirection(facts) {
  return ['# 已确认的团购资料', ...OFFER_FIELDS.map(([key, label]) => `${label}：${facts[key].value}`),
    '套餐及限制按以上商家确认资料表达，不自行新增优惠、原价、库存或购买入口；未包含在套餐中的实拍内容不能表达为赠送权益。'].join('\n');
}
