import assert from 'node:assert/strict';
import { test } from 'node:test';

let version = 0;

async function flowWithStorage(t, initial = {}) {
  const values = new Map(Object.entries(initial));
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  });
  const flow = await import(`../design/business-flow.js?profile-test=${version++}`);
  return { flow, storage, values };
}

test('saving business profile updates a brief already initialized by the homepage', async t => {
  const { flow, values } = await flowWithStorage(t);
  assert.equal(flow.getBusinessBrief().businessName, '');
  flow.updateBusinessProfile({ name: '青禾工装', industry: 'oem', address: '杭州余杭', feature: '来样确认面料和版型', hours: '预约看样' });
  const current = flow.getBusinessBrief();
  assert.equal(current.businessName, '青禾工装');
  assert.equal(current.industry, 'oem');
  assert.equal(current.purpose, 'inquiry');
  assert.equal(current.location, '杭州余杭');
  assert.equal(current.highlights, '来样确认面料和版型');
  assert.equal(current.hours, '预约看样');
  assert.deepEqual(JSON.parse(values.get('business-ai-brief-v1')), current);
});

test('updating the same business address and features preserves campaign facts without exposing the cache to mutation', async t => {
  const { flow } = await flowWithStorage(t, {
    'business-ai-brief-v1': JSON.stringify({ industry: 'dining', purpose: 'promotion', platform: 'douyin', businessName: '青禾餐厅', product: '当期餐饮活动', promotionKind: 'voucher', payAmount: '79', faceValue: '100', threshold: '满 200 元使用', restrictions: '不含酒水', validity: '本次约定的活动时间', action: '到店前确认可用日期' }),
  });
  const external = flow.getBusinessBrief();
  external.businessName = '外部误修改';
  assert.equal(flow.getBusinessBrief().businessName, '青禾餐厅');
  flow.updateBusinessProfile({ name: '青禾餐厅', industry: 'dining', address: '新地址', feature: '已确认特点', hours: '11:00–21:00' });
  const current = flow.getBusinessBrief();
  assert.equal(current.businessName, '青禾餐厅');
  assert.equal(current.location, '新地址');
  assert.equal(current.highlights, '已确认特点');
  assert.equal(current.hours, '11:00–21:00');
  assert.equal(current.product, '当期餐饮活动');
  assert.equal(current.purpose, 'promotion');
  assert.equal(current.platform, 'douyin');
  assert.equal(current.promotionKind, 'voucher');
  assert.equal(current.payAmount, '79');
  assert.equal(current.faceValue, '100');
  assert.equal(current.threshold, '满 200 元使用');
  assert.equal(current.restrictions, '不含酒水');
  assert.equal(current.validity, '本次约定的活动时间');
  assert.equal(current.action, '到店前确认可用日期');
});

for (const scenario of [
  { description: 'another business in the same industry', profile: { name: '新商家', industry: 'dining' }, expectedPurpose: 'visit' },
  { description: 'another industry with the same business name', profile: { name: '青禾商家', industry: 'oem' }, expectedPurpose: 'inquiry' },
]) {
  test(`switching to ${scenario.description} clears campaign facts while retaining previous draft snapshots`, async t => {
    const previous = {
      industry: 'dining', purpose: 'promotion', platform: 'douyin', businessName: '青禾商家', product: '当期餐饮活动',
      highlights: '旧业务特点', action: '到店前确认可用日期', audience: '旧业务客群',
      promotionKind: 'voucher', payAmount: '79', faceValue: '100', price: '199', threshold: '满 200 元使用',
      restrictions: '不含酒水', validity: '本次约定的活动时间', includes: '旧套餐菜品', people: '旧套餐人数',
      moq: '旧采购门槛', sample: '旧打样条件', leadTime: '旧交期说明',
    };
    const savedDrafts = JSON.stringify([{ id: 'old-draft', mode: 'image', brief: previous, prompt: '先前确认的创作要求' }]);
    const { flow, values } = await flowWithStorage(t, {
      'business-ai-brief-v1': JSON.stringify(previous),
      'store-ai-design-drafts': savedDrafts,
    });
    const oldConfig = { brief: flow.getBusinessBrief(), prompt: '先前确认的创作要求' };
    const oldConfigSnapshot = structuredClone(oldConfig);
    flow.updateBusinessProfile({ ...scenario.profile, address: '当前商家地址', feature: '当前业务特点', hours: '当前接待时间' });
    const current = flow.getBusinessBrief();
    assert.equal(current.businessName, scenario.profile.name);
    assert.equal(current.industry, scenario.profile.industry);
    assert.equal(current.platform, 'douyin');
    assert.equal(current.purpose, scenario.expectedPurpose);
    assert.equal(current.location, '当前商家地址');
    assert.equal(current.highlights, '当前业务特点');
    assert.equal(current.hours, '当前接待时间');
    assert.equal(current.promotionKind, 'bundle');
    for (const key of ['product', 'action', 'audience', 'payAmount', 'faceValue', 'price', 'threshold', 'restrictions', 'validity', 'includes', 'people', 'moq', 'sample', 'leadTime']) {
      assert.equal(current[key], '', `Previous business fact should not transfer: ${key}`);
    }
    assert.deepEqual(oldConfig, oldConfigSnapshot);
    assert.equal(oldConfig.brief.product, '当期餐饮活动');
    assert.equal(oldConfig.brief.payAmount, '79');
    assert.equal(values.get('store-ai-design-drafts'), savedDrafts);
    assert.deepEqual(JSON.parse(values.get('business-ai-brief-v1')), current);
  });
}

test('blocked storage retains the updated profile for this session and reports the persistence limit', async t => {
  const { flow, storage } = await flowWithStorage(t, { 'business-ai-brief-v1': '{bad json' });
  assert.equal(flow.getBusinessBrief({ name: '初始商家' }).businessName, '初始商家');
  storage.setItem = () => { throw new Error('Storage blocked'); };
  const messages = [];
  flow.updateBusinessProfile({ name: '新商家', industry: 'wholesale' }, message => messages.push(message));
  assert.equal(flow.getBusinessBrief().businessName, '新商家');
  assert.equal(flow.getBusinessBrief().industry, 'wholesale');
  assert.equal(messages.length, 1);
  assert.match(messages[0], /本次页面/);
});
