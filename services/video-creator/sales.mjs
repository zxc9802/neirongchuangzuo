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
  const appears = shot => shot?.referenceIds?.some(id => actors.has(id)) && shot.referenceIds.some(id => references.has(id)) && Boolean(shot.action?.trim());
  if (!actors.size || !Array.isArray(shots) || shots.length < 3 || !appears(shots[0]) || !appears(shots.at(-1)) || !shots.slice(1, -1).some(appears)) {
    fail('带货脚本缺少明确的人物出镜，请重新编导。', 'DIRECTOR_INVALID_OUTPUT', {
      field: 'sales.characterPresence', reason: 'plan.cast须引用角色照片；开场、中段产品展示、结尾须同时引用角色与产品/场景图，并写出明确人物动作。',
    });
  }
}

export function assertSalesNarration(shots, fixedNarration) {
  if (!fixedNarration?.trim()) return;
  const normalize = s => s.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  if (normalize(shots.map(s => s.voiceover || '').join('')) !== normalize(fixedNarration)) {
    fail('带货台词与指定文案不一致，请重新编导。', 'DIRECTOR_INVALID_OUTPUT', {
      field: 'sales.fixedNarration', reason: '按用户指定文案逐句安排voiceover，合并全文后不得增加、删除或重写台词；仅允许标点与空白差异。',
    });
  }
}
