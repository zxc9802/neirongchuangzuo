const fail = (message, code, detail) => { throw Object.assign(new Error(message), {
  status: code === 'DIRECTOR_INVALID_OUTPUT' ? 502 : 400, code,
  ...(detail ? { outputIssue: 'invalid_schema', validationIssue: JSON.stringify(detail) } : {}),
}); };

export function assertSalesMaterials(assets, settings) {
  const missing = [];
  if (!assets.some(a => a.type === 'image' && a.purpose === 'character')) missing.push('出镜人物照');
  if (!assets.some(a => a.type === 'audio')) missing.push('参考声音');
  if (!assets.some(a => a.type === 'image' && a.purpose !== 'character')) missing.push('产品或场景图片');
  if (missing.length) fail(`请添加${missing.join('、')}。`, 'SALES_MATERIALS_REQUIRED');
  if (settings?.generateAudio !== true) fail('AI带货需要开启声音。', 'SALES_AUDIO_REQUIRED');
}

export function assertSalesPlan(shots, plan, assets) {
  const castIds = new Set((plan?.cast || []).flatMap(c => c.referenceIds || []));
  const actors = new Set(assets.filter(a => a.type === 'image' && a.purpose === 'character' && castIds.has(a.id)).map(a => a.id));
  const references = new Set(assets.filter(a => a.type === 'image' && a.purpose !== 'character').map(a => a.id));
  const appears = shot => shot?.referenceIds?.some(id => actors.has(id)) && Boolean(shot.action?.trim());
  const showsCase = shot => shot?.referenceIds?.some(id => references.has(id)) && Boolean(shot.action?.trim());
  if (!actors.size || !Array.isArray(shots) || shots.length < 3 || !appears(shots[0]) || !appears(shots.at(-1)) || !shots.slice(1, -1).some(showsCase)) {
    fail('带货脚本缺少明确的人物出镜，请重新编导。', 'DIRECTOR_INVALID_OUTPUT', {
      field: 'sales.characterPresence', reason: 'plan.cast须引用角色照片；开场、结尾须引用人物并写出明确出镜动作；中段须有实拍支持的宣传片案例。案例镜头不强制人物出镜，不能整片退化为人物口播。',
    });
  }
}

export const SALES_PERSONA_REVIEW = `本模块的推广主体是义鹏的AI视频创作者人设，受众是需要宣传视频的商家及关注AI创作的人。额外核对：开场与结尾是否明确建立“创作者展示自己用AI做宣传片”的上下文，中段是否有实拍支持的行业宣传片案例；不能整片只推荐餐厅、吃喝或报地址，不能把义鹏写成店老板或真实探店顾客。案例内部允许餐饮广告文案及到店提示，但必须回到创作者视角收尾。可以邀请关注、留言行业或咨询，不编造实测耗时、零成本、客户数量、合作关系、流量和销售承诺。合理的创作能力展示不是虚构经营事实，不要求用户提供软件操作截图。若指定台词与人设目标冲突，应追问用途，不能无视指定文案直接改写。`;

export function assertSalesNarration(shots, fixedNarration) {
  if (!fixedNarration?.trim()) return;
  const normalize = s => s.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  if (normalize(shots.map(s => s.voiceover || '').join('')) !== normalize(fixedNarration)) {
    fail('带货台词与指定文案不一致，请重新编导。', 'DIRECTOR_INVALID_OUTPUT', {
      field: 'sales.fixedNarration', reason: '按用户指定文案逐句安排voiceover，合并全文后不得增加、删除或重写台词；仅允许标点与空白差异。',
    });
  }
}
