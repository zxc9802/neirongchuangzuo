import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  INDUSTRIES, PLATFORMS, createBrief, normalizeBrief, getPurposes,
  getBriefFields, validateBrief, buildContentPlan,
} from '../design/business-catalog.js';

function base(overrides = {}) {
  return normalizeBrief({
    industry: 'dining', purpose: 'brand', businessName: '样例商家',
    product: '本次真实产品', highlights: '可查看实际样品', action: '到店前通过店内预约入口联系',
    ...overrides,
  });
}

test('legacy saved business profiles seed the brief without inventing product or contact facts', () => {
  const brief = createBrief({ name: '山里咖啡', industry: '咖啡茶饮', address: '示例路 8 号', feature: '临窗座位', hours: '10:00–18:00' });
  assert.equal(brief.industry, 'dining');
  assert.equal(brief.businessName, '山里咖啡');
  assert.equal(brief.location, '示例路 8 号');
  assert.equal(brief.highlights, '临窗座位');
  assert.equal(brief.hours, '10:00–18:00');
  assert.equal(brief.product, '');
  assert.equal(brief.action, '');
  assert.ok(validateBrief(brief).product);
  assert.ok(validateBrief(brief).action);
});

test('normalization rejects unrecognized fields and safely restores corrupt storage values', () => {
  const brief = normalizeBrief({ industry: '不存在', purpose: 'unknown', platform: 'unknown', businessName: { unsafe: true }, price: -4, arbitrary: 'not a fact', product: 'a'.repeat(400) });
  assert.equal(brief.industry, 'dining');
  assert.equal(brief.purpose, getPurposes('dining')[0].id);
  assert.equal(brief.platform, 'xiaohongshu');
  assert.equal(brief.businessName, '');
  assert.equal(brief.product.length, 100);
  assert.equal(brief.arbitrary, undefined);
  assert.equal(normalizeBrief(null, null).industry, 'dining');
  assert.equal(normalizeBrief({ industry: 'constructor' }).industry, 'dining');
  assert.equal(normalizeBrief({ industry: '__proto__' }).industry, 'dining');
  assert.equal(normalizeBrief({ businessName: '' }, { name: '旧商家' }).businessName, '');
});

test('factory inquiries ask for facts specific to their cooperation model', () => {
  const oem = validateBrief(base({ industry: 'oem', purpose: 'inquiry' }));
  assert.ok(oem.moq && oem.sample && oem.leadTime);
  assert.equal(oem.location, undefined);
  const industrial = validateBrief(base({ industry: 'industrial', purpose: 'inquiry' }));
  assert.ok(industrial.material && industrial.process && industrial.specification);
  assert.equal(industrial.moq, undefined);
  assert.equal(industrial.drawings, undefined);
  const wholesale = validateBrief(base({ industry: 'wholesale', purpose: 'inquiry' }));
  assert.ok(wholesale.moq && wholesale.mixedOrder && wholesale.shipping);
  const direct = validateBrief(base({ industry: 'factory-retail', purpose: 'inquiry' }));
  assert.ok(direct.material && direct.customization && direct.delivery);
});

test('changing an industry excludes dormant factory terms from all generated customer-facing content', () => {
  const inquiry = base({ industry: 'oem', purpose: 'inquiry', moq: '每款 240 件', sample: '专用样衣规则', leadTime: '专用排产规则' });
  const changed = normalizeBrief({ ...inquiry, industry: 'beauty', purpose: 'case', caseDetails: '展示本次实际美甲完成情况' });
  const plan = buildContentPlan(changed);
  for (const value of ['每款 240 件', '专用样衣规则', '专用排产规则']) {
    assert.ok(!JSON.stringify(plan).includes(value));
  }
  assert.ok(plan.prompt.includes('保留真实肤色'));
  assert.ok(plan.caption.includes('展示本次实际美甲完成情况'));
  assert.ok(!getBriefFields(changed).some(field => field.key === 'moq'));
});

test('switching away from a promotion does not publish a previous campaign price or deadline', () => {
  const old = base({ purpose: 'promotion', promotionKind: 'bundle', includes: '旧套餐包含項', people: '旧人数条件', price: '198.50', validity: '旧活动截止日', restrictions: '旧活动限制' });
  const plan = buildContentPlan({ ...old, purpose: 'brand' });
  for (const value of ['旧套餐包含項', '旧人数条件', '198.50', '旧活动截止日', '旧活动限制']) {
    assert.ok(!JSON.stringify(plan).includes(value));
  }
});

test('voucher content keeps payment, deduction and restrictions distinct from a bundle', () => {
  const brief = base({
    purpose: 'promotion', promotionKind: 'voucher', payAmount: '79', faceValue: '100',
    threshold: '满 200 元使用，每单一张', validity: '示例活动日期范围', restrictions: '仅限菜品，不含酒水',
    includes: '旧套餐整桌十二道菜', people: '六人', price: '998',
  });
  assert.deepEqual(validateBrief(brief), {});
  const plan = buildContentPlan(brief);
  assert.ok(plan.caption.includes('购券支付 79 元，抵扣消费 100 元'));
  assert.ok(plan.script.includes('仅限菜品，不含酒水'));
  assert.ok(plan.prompt.includes('不是包含画面全部商品的套餐'));
  assert.ok(!JSON.stringify(plan).includes('旧套餐整桌十二道菜'));
  assert.ok(!plan.caption.includes('998'));
  assert.ok(!plan.script.includes('六人'));
  assert.ok(plan.shots.some(shot => shot.title === '购券与抵扣'));
  assert.equal(getBriefFields(brief).some(field => field.key === 'includes'), false);
});

test('voucher validation requires usable monetary amounts and all consumer conditions', () => {
  const voucher = base({ purpose: 'promotion', promotionKind: 'voucher' });
  const missing = validateBrief(voucher);
  for (const key of ['payAmount', 'faceValue', 'threshold', 'validity', 'restrictions']) assert.ok(missing[key]);
  for (const value of ['0', '-1', 'NaN', 'Infinity', '1e3', '15.888', ' 20元 ']) {
    assert.ok(validateBrief({ ...voucher, payAmount: value }).payAmount, value);
  }
  assert.ok(validateBrief({ ...voucher, payAmount: '100', faceValue: '100' }).faceValue);
  assert.ok(validateBrief({ ...voucher, payAmount: '101', faceValue: '100' }).faceValue);
  assert.equal(validateBrief({ ...voucher, payAmount: '79.90', faceValue: '100' }).payAmount, undefined);
});

test('the three promotion types request different facts without forcing an unknown product price', () => {
  const bundle = validateBrief(base({ purpose: 'promotion', promotionKind: 'bundle' }));
  assert.ok(bundle.includes && bundle.people && bundle.validity && bundle.restrictions);
  assert.equal(bundle.price, undefined);
  const product = validateBrief(base({ purpose: 'promotion', promotionKind: 'product' }));
  assert.ok(product.specification && product.validity && product.restrictions);
  assert.equal(product.includes, undefined);
  assert.equal(product.people, undefined);
  const plan = buildContentPlan(base({ purpose: 'promotion', promotionKind: 'product', specification: '一份实际商品', validity: '真实期限', restrictions: '实际限制' }));
  assert.ok(!plan.caption.includes('元'));
});

test('platform plans use different viewing structures and image ratios without changing supplied facts', () => {
  const shared = base({ industry: 'retail', purpose: 'guide', product: '实际收纳盒', selectionTips: '按柜体实际净尺寸选择' });
  const xhs = buildContentPlan({ ...shared, platform: 'xiaohongshu' });
  const douyin = buildContentPlan({ ...shared, platform: 'douyin' });
  const wechat = buildContentPlan({ ...shared, platform: 'wechat' });
  assert.equal(xhs.ratio, '3:4');
  assert.equal(douyin.ratio, '9:16');
  assert.equal(wechat.ratio, '1:1');
  assert.ok(xhs.prompt.includes('保存回看'));
  assert.ok(douyin.prompt.includes('开头直接给出'));
  assert.ok(wechat.prompt.includes('权益'));
  assert.notEqual(xhs.shots[0].title, douyin.shots[0].title);
  for (const plan of [xhs, douyin, wechat]) assert.ok(plan.caption.includes(shared.selectionTips));
  assert.equal(buildContentPlan(shared, 'mix').ratio, '9:16');
});

test('empty optional business facts do not become invented promises or placeholder script instructions', () => {
  const brief = base({ industry: 'oem', purpose: 'brand', businessName: '真实加工商', product: '来样加工' });
  const plan = buildContentPlan(brief, 'avatar');
  assert.ok(plan.script.includes('真实加工商'));
  assert.ok(plan.script.includes('来样加工'));
  for (const text of ['20 件', '起订', '日产', '认证', '免费', '保证', '最低', '【', '镜头', '上传', '填入']) assert.ok(!plan.script.includes(text), text);
  assert.ok(!plan.caption.includes('打样方式'));
  assert.ok(!plan.script.includes('交期确认方式'));
});

test('publishable captions use natural business copy while retaining all cooperation facts', () => {
  const brief = base({
    industry: 'oem', purpose: 'inquiry', platform: 'douyin', businessName: '青禾服饰', product: '企业工装来样加工',
    location: '杭州余杭', highlights: '可按确认的样衣核对版型与面料', audience: '企业工装采购',
    moq: '按款式和尺码数量确认', sample: '来样后先确认样衣费用', leadTime: '根据面料到位时间与排产确认',
    action: '询价时请先提供样衣照片、尺码与数量',
  });
  const plan = buildContentPlan(brief);
  assert.equal(plan.title, '企业工装来样加工，起订和打样怎么确认');
  assert.ok(plan.caption.startsWith('青禾服饰，这次介绍企业工装来样加工。'));
  assert.ok(plan.caption.includes('起订：按款式和尺码数量确认'));
  assert.ok(plan.caption.includes('打样：来样后先确认样衣费用'));
  for (const label of ['商家 / 企业名称：', '值得介绍的真实特点：', '这次介绍什么：', '看完后，客户怎么联系或行动：', '交期确认方式：']) assert.ok(!plan.caption.includes(label));
  for (const field of getBriefFields(brief)) if (brief[field.key]) assert.ok(plan.caption.includes(brief[field.key]), field.key);
});

test('industry and purpose hooks stay specific without inserting unprovided prices or outcomes', () => {
  const oem = buildContentPlan(base({ industry: 'oem', purpose: 'inquiry', platform: 'douyin' }));
  const industrial = buildContentPlan(base({ industry: 'industrial', purpose: 'inquiry', platform: 'douyin' }));
  const wholesale = buildContentPlan(base({ industry: 'wholesale', purpose: 'inquiry', platform: 'douyin' }));
  const dining = buildContentPlan(base({ industry: 'dining', purpose: 'visit', platform: 'douyin' }));
  const beauty = buildContentPlan(base({ industry: 'beauty', purpose: 'case', platform: 'douyin', caseDetails: '本次按顾客确认的款式完成' }));
  assert.ok(oem.title.includes('起订和打样'));
  assert.ok(industrial.title.includes('材料与工艺'));
  assert.ok(wholesale.title.includes('起批、混批和发货'));
  assert.ok(dining.title.includes('产品和店里的样子'));
  assert.ok(beauty.title.includes('实际完成'));
  assert.ok(beauty.caption.includes('本次按顾客确认的款式完成'));
  assert.ok(!beauty.caption.includes('效果翻倍'));
  assert.ok(!oem.caption.includes('免费'));
});

test('every supported maximum-size brief fits the studio prompt limit and retains all active fact values', () => {
  for (const industry of INDUSTRIES) {
    for (const purpose of getPurposes(industry.id)) {
      for (const platform of PLATFORMS) {
        for (const promotionKind of ['bundle', 'voucher', 'product']) {
          let brief = normalizeBrief({ industry: industry.id, purpose: purpose.id, platform: platform.id, promotionKind });
          for (const [index, field] of getBriefFields(brief).entries()) {
            if (field.key === 'promotionKind') continue;
            brief[field.key] = field.type === 'number' ? (field.key === 'faceValue' ? '9999999999999.99' : '8888888888888.88') : `${index}实`.padEnd(field.maxLength, '真');
          }
          brief = normalizeBrief(brief);
          for (const mode of ['image', 'video', 'mix', 'avatar']) {
            const plan = buildContentPlan(brief, mode);
            assert.ok(plan.prompt.length <= 2000, `${industry.id}/${purpose.id}/${platform.id}/${promotionKind}/${mode}: ${plan.prompt.length}`);
            for (const field of getBriefFields(brief)) {
              if (field.key !== 'promotionKind') {
                assert.ok(plan.prompt.includes(brief[field.key]), `Missing ${field.key}`);
                assert.ok(plan.caption.includes(brief[field.key]), `Caption missing ${field.key}`);
                assert.ok(plan.script.includes(brief[field.key]), `Script missing ${field.key}`);
              }
            }
          }
        }
      }
    }
  }
});
