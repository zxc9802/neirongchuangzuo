import sharp from 'sharp';
import { RestaurantError, FACT_FIELDS, localReview } from './rules.mjs';
import { validateVisualStyle } from './art-direction.mjs';

export const MATERIAL_COMPOSITION_VERSION = 4;
const fail = message => { throw new RestaurantError(message, 502, 'INVALID_GALLERY_STORYBOARD'); };
const short = (s, max, required = false) => typeof s === 'string' && [...s].length <= max && !/[\u0000-\u001f]/.test(s) && (!required || s.trim());
const hex = s => typeof s === 'string' && /^#[a-f\d]{6}$/i.test(s);
function rect(value, field, min = .02) {
  if (!value || ['x','y','width','height'].some(k => !Number.isFinite(value[k])) || value.x < 0 || value.y < 0
    || value.width < min || value.height < min || value.x + value.width > 1.001 || value.y + value.height > 1.001) fail(`${field}必须是图片范围内的归一化区域。`);
  return Object.fromEntries(['x','y','width','height'].map(k => [k, Math.round(value[k] * 1000) / 1000]));
}
export function validateMaterialStoryboard(value, task, outputCount) {
  if (value?.version !== MATERIAL_COMPOSITION_VERSION || !short(value.theme,120,true) || !Array.isArray(value.pages) || value.pages.length !== outputCount) fail('素材合成方案的版本或成品张数不完整。');
  const visualStyle = validateVisualStyle(value.visualStyle), gs = value.graphicStyle;
  if (!gs || !hex(gs.accent) || !hex(gs.paper) || !['light','dark'].includes(gs.ink) || !['outline','solid','serif'].includes(gs.typography)) fail('整套图片的配色不完整。');
  const allowed = new Map(task.analysis.filter(a => a.usable && a.privacyRisk !== 'high' && a.textRisk !== 'high'
    && !(task.foodReferenceExclusions || []).includes(a.imageId)).map(a => [a.imageId,a]));
  const facts = {...task.profileSnapshot,...task.contentFacts}, signatures = new Set();
  const pages = value.pages.map((page,index) => {
    if (!page || !short(page.role,40,true) || !short(page.compositionInstructions,1200,true) || !short(page.headline || '',22)
      || !short(page.subtitle || '',42) || !Array.isArray(page.materials) || page.materials.length < 1 || page.materials.length > 4
      || !Array.isArray(page.factKeys) || page.factKeys.length > 15 || page.factKeys.some(k => !FACT_FIELDS.includes(k) || !String(facts[k] || '').trim())) fail(`第${index+1}张缺少素材组合、构图或已确认文字。`);
    const materials = page.materials.map((material,i) => {
      if (!allowed.has(material?.sourceImageId) || !short(material.subject,120,true) || !['frame','cutout','background'].includes(material.treatment)
        || !short(material.editInstructions || '',400)) fail(`第${index+1}张引用了不可用素材或未指定真实主体。`);
      const crop = rect(material.crop,'素材截取'), placement = rect(material.placement,'素材摆放',.08);
      if (material.treatment === 'cutout' && !['food','interior','exterior','preparation'].includes(allowed.get(material.sourceImageId).imageType)) fail('人物照片只能按真实场景裁切，不允许重新抠出组合成虚构聚会。');
      if (i > 0 && placement.width * placement.height > .96) fail('后置素材不能遮住整张构图。');
      return {sourceImageId:material.sourceImageId,subject:material.subject.trim(),treatment:material.treatment,crop,placement,editInstructions:(material.editInstructions || '').trim()};
    });
    const t = page.text?.mode === 'none' || !page.text ? {mode:'none',x:.05,y:.08,width:.9,size:64} : page.text;
    if (!['none','headline','label'].includes(t.mode) || !Number.isFinite(t.size) || t.size < 26 || t.size > 96 || !short(t.instructions || '',300)) fail('图片文字样式不完整。');
    const box = rect({x:t.x,y:t.y,width:t.width,height:.08},'文字位置',.02);
    if(t.mode !== 'none' && (t.y > .85 || Math.ceil([...page.headline].length / Math.max(1,Math.floor(t.width*1080/t.size)))*(t.size+12) > (1-t.y)*1440)) fail('图片文字超出手机画面，请缩短或重新安排留白。');
    if (t.mode !== 'none' && !page.headline?.trim()) fail('需要显示文字的页面缺少标题。');
    const signature = JSON.stringify(materials.map(m => [m.sourceImageId,m.crop,m.placement,m.treatment]));
    if (signatures.has(signature)) fail('不同成品的素材截取和构图完全相同，请重新编排。');
    signatures.add(signature);
    return {imageId:`page-${String(index+1).padStart(2,'0')}`,role:page.role.trim(),layout:'material-composition',headline:(page.headline || '').trim(),subtitle:(page.subtitle || '').trim(),
      materials,compositionInstructions:page.compositionInstructions.trim(),text:{mode:t.mode,x:box.x,y:box.y,width:box.width,size:t.size,instructions:(t.instructions || '').trim()},factKeys:[...new Set(page.factKeys)],labels:[],assetIds:[`shot-${String(index+1).padStart(2,'0')}`]};
  });
  const minimumCompositions=Math.min(2,Math.ceil(outputCount/3));
  if(pages.filter(p=>p.materials.length>=2).length<minimumCompositions) fail(`整套至少${minimumCompositions}张需要截取多个实拍区域合成，不能全是单张原图美化。其余细节页可用单个真实裁片，避免每页硬拼。`);
  const copy = {titles:[],tags:[],coverText:'真实门店与菜品分享',body:pages.map(p=>[p.headline,p.subtitle].join(' ')).join('\n'),claims:pages.map(p=>({text:[p.headline,p.subtitle].join(' '),factKeys:p.factKeys,imageIds:p.materials.map(m=>m.sourceImageId)}))};
  const review = localReview(copy,task.profileSnapshot,task.contentFacts || {},[...allowed.values()]);
  if (review.errors.length) fail(`图片文字存在未确认信息：${review.errors.join('；')}`);
  return {version:MATERIAL_COMPOSITION_VERSION,contentType:task.contentType,outputCount,theme:value.theme.trim(),visualStyle,
    graphicStyle:{accent:gs.accent,paper:gs.paper,ink:gs.ink,typography:gs.typography},pages,foodGroups:[],
    shots:pages.map((p,i)=>({imageId:p.assetIds[0],sourceImageId:p.materials[0].sourceImageId,kind:'scene',shotIndex:i,name:p.role,purpose:p.compositionInstructions,
      angle:'original',camera:'根据实拍素材组合宣传图',lighting:visualStyle.lighting,editInstructions:p.compositionInstructions,referenceImageIds:[...new Set(p.materials.slice(1).map(m=>m.sourceImageId))]}))};
}
export function repairMaterialStoryboard(value, board, task) {
  return {...validateMaterialStoryboard({...board,pages:value?.pages},task,board.outputCount),referenceSet:board.referenceSet};
}
export function materialClaimIssues(board,task) {
  const facts={...task.profileSnapshot,...task.contentFacts},confirmed=Object.entries(facts).filter(([key])=>key!=='name').map(([,v])=>String(v || '')).join(' '),issues=[];
  for(const page of board.pages) {
    const rawCopy=[page.role,page.headline,page.subtitle].join(' '),copy=facts.name?rawCopy.split(facts.name).join(''):rawCopy;
    for(const [pattern,reason]of [[/湘菜|湘味/,'湘菜或湘味'],[/炭火/,'炭火制作'],[/现点现烤|现烤|现做|现炒/,'现点制作'],[/现场音乐|现场演出|驻唱|音乐吧/,'音乐演出或音乐吧定位']]) {
      if(pattern.test(copy) && !pattern.test(confirmed))issues.push(`${page.imageId}中的${reason}没有商家资料支持，不能从店名、烤串或舞台推断，请改成可见菜品/空间。`);
    }
  }
  return issues;
}
export function repairMaterialCopy(value,board,task) {
  if(!Array.isArray(value?.pages) || value.pages.length!==board.pages.length || new Set(value.pages.map(p=>p?.imageId)).size!==board.pages.length)fail('文字修正的页面编号不完整。');
  const pages=board.pages.map(page=>{
    const copy=value.pages.find(p=>p.imageId===page.imageId);
    if(!copy || !short(copy.role,40,true) || !short(copy.headline,22) || !short(copy.subtitle,42) || !Array.isArray(copy.factKeys))fail('文字修正包含无关页面或不完整字段。');
    return {...page,role:copy.role,headline:copy.headline,subtitle:copy.subtitle,factKeys:copy.factKeys,text:copy.headline.trim()?page.text:{mode:'none'}};
  });
  const result=repairMaterialStoryboard({pages},board,task),issues=materialClaimIssues(result,task);
  if(issues.length)fail(issues.join('；'));return result;
}
export async function prepareMaterialComposition(page, sources, graphicStyle) {
  const width=1080,height=1440,parts=[],composites=[];
  for (const [index,material] of page.materials.entries()) {
    const source=sources.find(s=>s.id===material.sourceImageId);
    if (!source?.bytes) throw new RestaurantError('合成图片的原图素材已过期。',410,'FILES_EXPIRED');
    const oriented=await sharp(source.bytes).autoOrient().toBuffer(),meta=await sharp(oriented).metadata(),crop=material.crop;
    const left=Math.min(meta.width-1,Math.floor(crop.x*meta.width)),top=Math.min(meta.height-1,Math.floor(crop.y*meta.height));
    const region={left,top,width:Math.max(1,Math.min(meta.width-left,Math.round(crop.width*meta.width))),height:Math.max(1,Math.min(meta.height-top,Math.round(crop.height*meta.height)))};
    const bytes=await sharp(oriented).extract(region).resize({width:1400,height:1400,fit:'inside',withoutEnlargement:true}).jpeg({quality:95}).toBuffer();
    parts.push({id:`material-${index+1}`,bytes,mime:'image/jpeg',sourceImageId:source.id,crop:region,subject:material.subject});
    const p=material.placement,x=Math.round(p.x*width),y=Math.round(p.y*height),w=Math.min(width-x,Math.round(p.width*width)),h=Math.min(height-y,Math.round(p.height*height));
    composites.push({input:await sharp(bytes).resize(w,h,{fit:material.treatment==='cutout'?'contain':'cover',position:'centre',background:graphicStyle.paper}).toBuffer(),left:x,top:y});
  }
  const bytes=await sharp({create:{width,height,channels:3,background:graphicStyle.paper}}).composite(composites).jpeg({quality:94}).toBuffer();
  return {draft:{id:'composition-draft',bytes,mime:'image/jpeg'},parts};
}
export async function finishMaterialPage(rendered,page,board,{requestId}={}) {
  const image=sharp(rendered).resize(1080,1440,{fit:'cover'});
  return {bytes:await image.jpeg({quality:94}).toBuffer(),width:1080,height:1440,format:'jpeg',composition:{method:'claude-directed-real-material-composition',version:4,
    contentType:board.contentType,role:page.role,layout:page.layout,sourceImageIds:[...new Set(page.materials.map(m=>m.sourceImageId))],materials:page.materials,
    headline:page.headline,text:page.text,visualStyle:board.visualStyle,referenceSet:board.referenceSet,requestId}};
}

export const MATERIAL_STORYBOARD_PROMPT = `你是餐饮小红书套图的创意编排师。商家选定方向，然后上传实拍素材。你的任务是从这些照片中选取菜品、餐具、空间、门头、细节，决定每页截取哪些区域、如何组合成一张有宣传力的图。不是先生成6张新摄影照片，再机械套拼图；不是每张原图只加滤镜和一行标题。仅输出完整JSON，version=4，pages恰好requestedOutputCount页，默认6张。
source-sheet中的photo-ID是商家原图。type-reference-sheet是另外一位商家的风格样例，只学信息层级、构图、摄影质感、色调策略，绝不能使用其中的菜品、文字、顾客、装修作为本店素材，也不能在materials引用参考ID。根据本店光线装修选滤镜，而非复制别店的红色。
每页有一个明确宣传主题，可用1—4个真实素材区域。默认6页中至少2页必须由多个真实素材区域组合，门店/菜品封面应合成；其余可穿插真正有独立作用的原图裁片特写和氛围大图，避免硬凑拼图。一套不能只是6张照片加滤镜，也不能所有页都硬塞小方框。每个material给出原图sourceImageId、可见subject、crop与placement。二者都是0—1归一化{x,y,width,height}，crop相对按EXIF方向旋正的原图，placement相对竖版3:4成品，按数组顺序叠放。单个素材页仍应精确选择有意义的区域，不做无意义全图搬运。crop必须圈住完整主体，不能切断菜品和餐具；不要总是全图。food可treatment=cutout保留食品及餐具、抠出杂乱背景，放到同店环境或简洁版面；frame是精确裁切的实拍矩形，background是实际空间或桌面底图。可用上下图、局部嵌图、自由叠放、食物抠图+门店背景等方式，但不要机械复用四格模板。同一实拍可以提供不同部位，但不要把同一道菜复制成几盘冒充一桌；同页不应重复同一食品主体。背景与人物保真实，不能抠人拼出虚构聚会。照片人物可自然原样保留，不作为装饰剪贴。
store-intro：从门头/装修/代表菜品提取素材构成门店介绍，主次突出，封面可以食品抠图与门店空间组合，后续以真实细节组合说明本店特色。signature-dish：从真正的目标菜品实拍提取食品、餐具、纹理，搭配同店桌面环境，大小图体现食欲，不从参考图借菜、不虚构配方。避免六张都是同一盘同一角度换字。
consumption-scene：以实际用餐空间、桌面和真实氛围为主，参考这次的自然实拍与少量食物小标签。保留暗部、真实光源和有人用餐的生活感，食物局部清晰有食欲。大主图+局部细节/菜品的克制组合，背景仍然像真实手机摄影，别拼成电商广告或强行抠出顾客。多数页text.mode=none，确有菜名/主题可用小label；不要求每张大标题，不套旧白紫聚餐海报样式。参考照片的暗调并不意味着把本店日景改成夜景。
整套visualStyle由你根据原图和对应参考确定。compositionInstructions说明怎么去除裁片接缝、怎样体现主次与真实质感；material.editInstructions说明该区域如何美化。Image2.5将基于程序真正截取并摆好的草稿合成，每页一次生成，保持实拍内容与识别度。不要虚构新食材、装修、顾客、菜名、价钱、容量、优惠、服务。门头原文字原样保留，不乱改为另一店名。店名有湘字不能推断湘菜、湘味；烧烤不能推断炭火；舞台与乐器不能推断有现场音乐演出；多盘食物不能称为正在出售的套餐。只有商家明确填写才可使用这些事实，未知时写烤串、舞台空间、菜品组合等可见描述。
role用简短中文说明该页用途，不用英文内部名。headline≤22字，subtitle≤42字；文案是老板语气，禁用不实评价、排名和夸张承诺。factKeys只能引用profile/confirmedFacts已有非空字段。text:{mode:none|headline|label,x,y,width,size,instructions}，instructions指定字体气质、字重、字距、颜色、轻微描边或无描边，字体由Image2.5与画面一起设计，不用程序默认黑体硬贴字。不要一套全用粗体描边、方形标签和同样的对齐；参考店铺品类与风格，克制使用圆润手写感、简洁无衬线或精致标题字。拼接也不能一律方框嵌图：选干净的跨区域大图/食品自然抠图/轻量重叠，避免厚边框、硬阴影与无意义的剪贴画，主要画面要连贯，size=26—96像素，位置归一化且y≤.85，文字放不遮食品/招牌/人脸的空位。无字页headline可为空。允许不同页复用同店背景，但必须换真实区域、素材组合、版式或信息，不重复一张成品。所有素材都必须来自images中usable=true的ID；不为用完素材硬塞无关图。
JSON:{version:4,theme,visualStyle:{name,mood,palette:[描述],lighting,tone,texture,instructions},graphicStyle:{accent:#rrggbb,paper:#rrggbb,ink:light|dark,typography:outline|solid|serif},pages:[{role,headline,subtitle,factKeys:[],text:{mode,x,y,width,size,instructions},compositionInstructions,materials:[{sourceImageId,subject,crop:{x,y,width,height},placement:{x,y,width,height},treatment:background|frame|cutout,editInstructions}]}]}。短句描述，只返回JSON。`;

export function materialEditPrompt({page,visualStyle,corrections=[]}) {
  return `Create ONE finished 3:4 Xiaohongshu restaurant promotional composition from REAL photographic materials. The FIRST image is an actual rough collage programmatically cropped and assembled from this merchant's photographs. Remaining images are the source crops in material order (up to 3). They are NOT generic inspiration. Improve the collage into a coherent, carefully art-directed final image; do NOT turn it into a single newly invented restaurant photo. Typography is part of your integrated composition, NOT a later rigid SVG layer. When page.text.mode=none, add NO text at all. Otherwise typeset ONLY the exact approved page.headline and nonempty page.subtitle, follow page.text.instructions, position and scale, and design letters harmoniously with the actual food and atmosphere. No additional copy, fake stickers, captions, invented logos or watermarks. Retain authentic source signage. Avoid generic rigid system-font bold, heavy uniform outline, opaque rectangular banners and awkward mechanically aligned type. Legible Chinese typography should feel like an intentional Xiaohongshu design. IMPORTANT: text.instructions contains style instructions, NEVER words to print. Do NOT render font names, style descriptions, IDs, field names or placeholder labels. Print exactly page.headline and page.subtitle, character by character, and nothing else.
Follow placement and relative scale from the draft and JSON. FRAME materials remain genuine cropped photographs with clean composition. CUTOUT materials: extract only the stated food/plate/detail from that crop, remove its irrelevant rectangular background and integrate naturally into the specified real scene/graphic background; retain the actual kind, recognizable shape and serving ware. BACKGROUND materials remain this real venue/table. Never borrow unrelated food, add dishes, invent customers, change faces/poses, replace furniture, venue, signage, or turn daylight into night. Do not merge different menu items into one new dish. Improve appetizing food texture, intentional exposure and color; preserve shadow depth and real light color, no mandatory bright filter or CGI waxy texture. Preserve all selected materials: never drop the main food or scene to make a single-photo retouch. No decorative blurred border, floating random utensils, fake neon, commercial banner or invented labels beyond the approved page text. Collage boundaries should be editorial and intentional: clean aligned panels only where the plan asks for them, or natural integrated cutout edges and restrained overlaps. Never add thick hard dividing borders, arbitrary square mini-photo boxes, heavy drop shadows or artificial decorative shapes.
Shared style: ${JSON.stringify(visualStyle)}
Page: ${JSON.stringify(page)}
Required corrections: ${JSON.stringify(corrections)}
Finish seams, cutout edges, perspective and hierarchy according to compositionInstructions. Where the draft deliberately contains photographic panels, preserve their editorial structure rather than fabricating a single scene. The result must read as a purposeful photographic promotional composition with a clear main subject.`;
}
