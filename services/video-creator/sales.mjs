import { SALES_SCENE_CHARACTER_RULES } from '../../design/ai-sales-policy.js';

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

export function assertSalesPlan(shots, plan, assets, observations = []) {
  const castIds = new Set((plan?.cast || []).flatMap(c => c.referenceIds || []));
  const characterIds = new Set(assets.filter(a => a.type === 'image' && a.purpose === 'character').map(a => a.id));
  const actors = new Set([...characterIds].filter(id => castIds.has(id)));
  const references = new Set(assets.filter(a => a.type === 'image' && a.purpose !== 'character').map(a => a.id));
  const appears = shot => shot?.referenceIds?.some(id => actors.has(id)) && Boolean(shot.action?.trim());
  const showsCase = shot => shot?.referenceIds?.some(id => references.has(id)) && Boolean(shot.action?.trim());
  const hasFusionException = shot => typeof shot?.sceneFusionException === 'string' && Boolean(shot.sceneFusionException.trim()) && shot.sceneFusionException.trim().length <= 400;
  if (!Array.isArray(shots) || shots.length < 3 || (!actors.size && shots.some(shot=>shot.referenceIds?.some(id=>characterIds.has(id))))
    || (!showsCase(shots[0]) && !hasFusionException(shots[0])) || !shots.slice(1, -1).some(showsCase)) {
    fail('带货脚本的人物与场景安排不完整，请重新编导。', 'DIRECTOR_INVALID_OUTPUT', {
      field: 'sales.characterPresence', reason: '使用人物的镜头须在plan.cast引用角色照片；开场采用实拍素材，中段必须有实拍支持的行业案例，不能整片退化为独立人物口播。凡引用场景类素材的镜头都须引用人物照片并写出人物在该场景内出镜的动作，与是否口播无关；纯产品特写可不出镜。',
    });
  }
  const byId = new Map(observations.map(o => [o.id, o]));
  const unclassified = [...new Set(shots.flatMap(shot => shot.referenceIds).filter(id => references.has(id) && !byId.get(id)?.kinds?.length))];
  if (unclassified.length) fail('脚本缺少所用素材的场景分类，请重新编导。', 'DIRECTOR_INVALID_OUTPUT', { field: 'sales.sceneClassification', assetIds: unclassified, reason: '根据独立素材观察清单区分场景与产品，不能按口播或文件名判断。旧脚本缺少分类时请重新编导。' });
  const scenes = new Set([...references].filter(id => byId.get(id)?.kinds.includes('scene')));
  for (const [index, shot] of shots.entries()) if (shot.referenceIds.some(id => scenes.has(id)) && (!appears(shot) || hasFusionException(shot))) {
    fail(`第${index + 1}镜引用了场景素材，必须安排参考人物在场景内出镜。`, 'DIRECTOR_INVALID_OUTPUT', {
      field: 'sales.sceneCharacter', shot: index + 1,
      reason: '本镜referenceIds引用了observations.kinds含scene的素材，必须同时引用上传人物照片，plan.cast引用同一人物，并在action中安排人物自然融入该场景。无论是否口播都要出镜，不能用sceneFusionException或将evidence.use改成food/detail跳过；融合困难时调整构图、景别或换用可用素材。',
    });
  }
  return scenes;
}

export const SALES_PERSONA_REVIEW = `本模块的推广主体是义鹏的AI视频创作者人设，受众是需要宣传视频的商家及关注AI创作的人。${SALES_SCENE_CHARACTER_RULES}逐镜对照referenceIds与独立observations的kinds：引用场景类素材的镜头必须引用角色照片并明确让参考人物全程自然融入该场景，不能仅首尾有人、中段场景无人。判断依据是所引用素材是否含scene分类，与voiceover是否为空无关；同图含scene和food/detail仍算场景，不能把evidence.use改成food/detail绕过。人物参考图原背景不算真实场景。sceneFusionException不能豁免场景镜头的人物出镜。未引用场景类素材的纯产品、海报或细节镜头可不出镜，有画外音也不据此退回。这是生成前的自然语言分镜审核，不是成片像素验收或3D施工单。人物与场景引用正确，写清相对落位、移除原背景和匹配环境光线及接触阴影，即是可执行的合成说明；不得因缺少数值坐标、距离米数、精确比例、光照强度、抠图蒙版或已融合图片而判失败，也不要要求编造测量数值。场景镜头明确无人、缺少人物引用、使用独立灰底、浮层人像、画中画或分屏代替场景融合、人物比例或站位明显不合空间、悬浮穿模、遮挡展示主体或没有任何自然融合意图时应退回并指出可调整的站位、景别或取景。人物出镜不能只靠贴图满足；核对动作与该镜内容相符，光线方向、色温、接触阴影和前后遮挡有统一的合成意图，但不要求虚构精确测量数据。灰底或棚拍人物原照是合法身份参考，与独立场景照一起交给视频模型重渲染属于允许的AI合成；不得仅因原照背景灰色或人物未与环境同框拍摄而拒绝。应检查引用、人物落位和融合指令是否清楚；实际融合效果留待生成后验收。文案是否有明确的跨行业AI创作挑战与作品揭晓感，不能只是平淡介绍门店。开场与结尾是否明确建立“创作者展示自己用AI做宣传片”的上下文，中段是否有实拍支持的行业宣传片案例；不能整片只推荐餐厅、吃喝或报地址，不能把义鹏写成店老板或真实探店顾客。案例内部允许餐饮广告文案及到店提示，但必须回到创作者视角收尾。检查案例段是否有面向顾客的吸引力；若只是罗列柜台、桌椅和颜色，或把运镜/配色/节奏设计说明当作口播，应指出缺乏广告表达并要求改写，不应仅因事实无误就通过。可以邀请关注、留言行业或咨询，不编造实测耗时、零成本、客户数量、合作关系、流量和销售承诺。合理的创作能力展示不是虚构经营事实，不要求用户提供软件操作截图。若指定台词与人设目标冲突，应追问用途，不能无视指定文案直接改写。输出前检查结论一致性：issues只填写真实未解决的缺陷，禁止把“符合要求”“通过”的点评放入issues；所有镜头通过时必须返回passed:true及issues:[]，不要用passed:false列举通过理由。`;

export function assertSalesNarration(shots, fixedNarration) {
  if (!fixedNarration?.trim()) return;
  const normalize = s => s.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  if (normalize(shots.map(s => s.voiceover || '').join('')) !== normalize(fixedNarration)) {
    fail('带货台词与指定文案不一致，请重新编导。', 'DIRECTOR_INVALID_OUTPUT', {
      field: 'sales.fixedNarration', reason: '按用户指定文案逐句安排voiceover，合并全文后不得增加、删除或重写台词；仅允许标点与空白差异。',
    });
  }
}

export const SALES_ANONYMOUS_RULES = `AI带货使用匿名行业案例：从实拍自行判断行业与广告切入点，不询问或要求填写行业、店名、地址、宣传文案。用户历史消息、文件名及观察清单里的具体店名和商场名仅供内部识别，不能进入面向观众的标题、summary、口播和字幕。视频画面也不能出现可辨认的具体店名、商场名、品牌LOGO或地址，包括门头、灯牌、菜单、杯盘、包装与倒影。逐镜选择避开标识的角度、裁切、景深，确需使用时明确自然去字、清除LOGO并保留材质与环境，不生成替代店名、不把整幅画面模糊。保留食品、空间与人物身份；义鹏的人名不属于禁止的店名。该匿名化要求优先于原图文字保真和照搬招牌规则。审核须核对口播与字幕未点名且涉及标识的镜头具备可执行的去标识指令；这属于允许的案例匿名化，不作为虚构门店事实拒绝。`;
