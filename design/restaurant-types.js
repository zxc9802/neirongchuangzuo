export const DEFAULT_RESTAURANT_OUTPUT_COUNT = 6;
export const RESTAURANT_CONTENT_TYPES = [
  { id: 'store-intro', label: '门店介绍', icon: 'store', description: '门店特色 · 环境 · 代表菜品', uploadHint: '上传门头、店内环境和代表菜品',
    required: [['name', '门店名称', 'profile'], ['city', '城市 / 商圈', 'profile'], ['category', '主营品类', 'profile']],
    optional: [['features', '门店特色', 'profile'], ['address', '地址', 'profile'], ['hours', '营业时间', 'profile']] },
  { id: 'signature-dish', label: '招牌菜种草', icon: 'image', description: '菜品全貌 · 食欲细节 · 真实卖点', uploadHint: '上传招牌菜全貌、细节和不同角度照片',
    required: [['name', '门店名称', 'profile'], ['dishName', '招牌菜名称', 'facts'], ['sellingPoints', '菜品卖点', 'facts']],
    optional: [['city', '城市 / 商圈', 'profile'], ['taste', '口味', 'facts'], ['price', '价格', 'facts'], ['delivery', '购买 / 外卖方式', 'facts']] },
  { id: 'consumption-scene', label: '消费场景', icon: 'users', description: '聚餐需求 · 空间 · 用餐氛围', uploadHint: '上传桌型、用餐空间和菜品，聚餐照片可选',
    required: [['name', '门店名称', 'profile'], ['occasion', '消费场景', 'facts']],
    optional: [['city', '城市 / 商圈', 'profile'], ['features', '空间特点', 'profile'], ['capacity', '适合人数', 'facts'], ['privateRoom', '包间情况', 'facts'], ['booking', '预订方式', 'facts']] }
];
export const restaurantContentType = id => RESTAURANT_CONTENT_TYPES.find(type => type.id === id);
export function restaurantContentError(id, profile = {}, facts = {}) {
  const type = restaurantContentType(id);
  if (!type) return '请选择门店介绍、招牌菜种草或消费场景。';
  const missing = type.required.filter(([key, , group]) => !String((group === 'profile' ? profile : facts)[key] || '').trim());
  if (missing.length) return `请填写${missing.map(([, label]) => label).join('、')}。`;
  return '';
}
