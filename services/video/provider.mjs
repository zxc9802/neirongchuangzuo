export const MODEL = 'doubao-seedance-2-0-260128';
export const PIXVERSE_MODEL = 'fal-ai/pixverse/swap';
// Retained for recovery and settlement of tasks submitted before removal.
export const WAN_MODEL = 'fal-ai/wan/v2.2-14b/animate/replace';
export const WAN3_MODEL = 'wan3.0-video';
export const DURATIONS = [4, 5, 6, 8, 10, 12, 15];
export const MODELS = [
  // Opt-in custom duration: generate the opening 60 seconds in parts within each model's limit.
  { id: MODEL, name: 'qiya-2.0', description: '单段最多15秒，整条最多60秒，1元/秒', cnyPerSecond: 1, maxDuration: 15, extendedDuration: 60, durations: DURATIONS, resolution: '720p' },
  { id: 'doubao-seedance-2-5-260628', name: 'qiya-2.5', description: '单段最多30秒，整条最多60秒，1.5元/秒', cnyPerSecond: 1.5, maxDuration: 30, extendedDuration: 60, durations: [...DURATIONS, 20, 25, 30], resolution: '720p' },
  { id: 'doubao-seedance-2-0-fast-260128', name: 'qiya-2.0-f1', description: '单段最多15秒，整条最多60秒，0.8元/秒', cnyPerSecond: 0.8, maxDuration: 15, extendedDuration: 60, durations: DURATIONS, resolution: '720p' },
  { id: 'doubao-seedance-2-0-mini-260615', name: 'qiya-20-m1', description: '单段最多15秒，整条最多60秒，0.5元/秒', cnyPerSecond: 0.5, maxDuration: 15, extendedDuration: 60, durations: DURATIONS, resolution: '720p' },
  { id: WAN3_MODEL, name: 'qiya-3.0', description: '单段最多15秒 · 整条最多60秒 · 720P · 输入与输出均计费', cnyPerSecond: 0.6, maxDuration: 15, extendedDuration: 60, durations: DURATIONS, resolution: '720p' },
  { id: PIXVERSE_MODEL, name: 'PixVerse Swap', description: '最长30秒 · 720p · 按实际费用，配音口型另计', maxDuration: 30, durations: Array.from({ length: 29 }, (_, i) => i + 2), resolution: '720p' },
];
export const PROMPT = '编辑视频1。同时完成两项编辑：人物替换和原视频叠加水印去除。将视频1中的唯一人物完整替换为图片1中的人物。删除视频1画面中已有的平台和作者水印，包括抖音/TikTok、快手、小红书等平台的图标及名称、抖音号等账号ID、@用户名、作者昵称及其相邻角标；这些叠加标记属于水印，不属于需要保留的台词字幕或场景标识。无论水印位于左上角、右上角、底部还是随时间移动，都要从第一帧到最后一帧去除，包括半透明文字和图案水印，并自然重建被遮挡的背景，不得保留、复制或新增水印，不用模糊、马赛克、色块或裁切画面的方式遮盖水印。去水印要求优先于下文的背景、字幕和口型保留要求。图片1是人物外貌的唯一参考，头部、脸型、五官及其比例、眉眼、鼻子、嘴唇、耳朵、下颌轮廓、发际线和发型都必须采用图片1；不得保留视频1原人物的脸部特征，不得混合两个人的五官，不能只换衣服而保留原脸。人物的服装采用图片1，去掉原人物与图片1不一致的服装、配饰和衣服文字，不新增图片1中不存在的装饰。替换从第一帧开始并保持到最后一帧。沿用视频1的动作、表情变化、说话节奏、位置和镜头运动，不增加动作、不重复片段、不延伸表演。人物以外的场景、商品及包装、背景标识和已有字幕保持原样，但上述保留要求仅适用于非水印内容；保留正常台词字幕的原文、位置、排版和出现时间，不重画字幕。正常台词字幕、商品包装文字和场景中的真实招牌不属于水印，须保持原样。';
export class VideoError extends Error {
  constructor(message, status = 400, code = 'VIDEO_INVALID_INPUT') { super(message); this.status = status; this.code = code; }
}
export function videoConfig(env = {}, publicOrigin) {
  const credentials = prefix => ({ base: env[`${prefix}_API_BASE_URL`] || env.VIDEO_API_BASE_URL,
    project: env[`${prefix}_PROJECT_CODE`] || env.VIDEO_PROJECT_CODE,
    access: env[`${prefix}_ACCESS_KEY`] || env.VIDEO_ACCESS_KEY, secret: env[`${prefix}_SECRET_KEY`] || env.VIDEO_SECRET_KEY });
  const config = { video: credentials('VIDEO'), material: credentials('MATERIAL'),
    publicOrigin: env.VIDEO_PUBLIC_BASE_URL || publicOrigin || env.AUTH_PUBLIC_URL,
    signingSecret: env.TEMP_ASSET_SIGNING_SECRET, falKey: env.FAL_KEY || env.FAL_API_KEY || env.VIDEO_FAL_KEY,
    dashscopeKey: env.DASHSCOPE_API_KEY };
  config.wan3Enabled = Boolean(config.dashscopeKey);
  config.enabled = Boolean(config.publicOrigin && config.signingSecret && Object.values(config.video).every(Boolean) && Object.values(config.material).every(Boolean));
  config.falEnabled = Boolean(config.publicOrigin && config.signingSecret && config.falKey);
  if (config.enabled || config.falEnabled) {
    try {
      const origin = new URL(config.publicOrigin);
      if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error();
      config.publicOrigin = origin.origin;
    } catch { config.enabled = false; config.falEnabled = false; }
  }
  if (config.enabled) {
    try {
      for (const value of [config.video, config.material]) {
        const target = new URL(value.base);
        if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error();
      }
    } catch { config.enabled = false; }
  }
  return config;
}
export function generationBody(task) {
  // Separate audio services consume the source after the visual edit.
  const voiceConversion = task.voice && task.voiceEngine === 'chatterbox';
  const separateNarration = task.voice && ['indextts2', 'chatterbox'].includes(task.voiceEngine);
  const lengthPrompt = (!separateNarration || voiceConversion) && task.video?.duration ? `\n视频1实际时长为${task.video.duration.toFixed(3)}秒。动作严格对应原视频时刻，输出超过原视频时长的部分保持末帧静止、闭嘴和无声。` : '';
  const captionPrompt = !separateNarration && task.sourceAudioMode !== 'silent' && task.captions?.cues?.length ? `\n台词来自原视频字幕，优先于听辨结果，以下文字是唯一语音文案，不改写、不漏说，数字和价格按原字说：${task.speech.segments.map(segment => `${segment.start.toFixed(3)}–${segment.end.toFixed(3)}秒：${segment.text}`).join('；')}。${task.voice ? '' : '保留视频1的人声音色。'}保留视频1已有的清晰台词字幕，不重画字幕；台词字幕区域的背景仅在去除叠加水印时允许修复，平台图标、账号和昵称水印不得当成字幕保留；仅在成片未保留字幕时，系统会按原文补字幕。` : '';
  let voicePrompt = voiceConversion ? '\n逐帧保留视频1的说话节奏、开口闭口时间、嘴唇动作和面部表情，将人物外观替换为图片1，同时完成上述全片去水印编辑。不要重新设计口型，不要改变视频速度，不要新增台词或旁白。' : '';
  if (task.voice && !separateNarration) {
    const segments = task.speech.segments;
    const gaps = [];
    let end = 0;
    for (const segment of segments) { if (segment.start > end) gaps.push(`${end.toFixed(3)}–${segment.start.toFixed(3)}秒`); end = segment.end; }
    if (task.duration > end) gaps.push(`${end.toFixed(3)}秒至成片结束`);
    const sourceInstruction = task.sourceAudioMode === 'silent'
      ? '视频1已去除原声音轨，仅提供画面、动作、表情和说话节奏参考。以下台词和时间线来自原视频原声转写，是唯一配音依据。画面字幕可能不完整，只保留其视觉内容，不得据此省略、替换或增加台词。音频1是用户上传的声音，也是唯一音色参考；生成视频中人物的音色、声线、共鸣和音质必须跟随音频1，不根据视频1中的人物外貌推测声音，不推测或恢复原人物的声音。情绪表达参考视频1的表情、动作和台词语义，在音频1音色的基础上自然表达。人物口型与新生成的配音同步。'
      : '仅替换视频1的人声音色，以下从原视频提取的台词是唯一台词依据。直接编辑视频1的声音，仅更换音色，不重新设计配音表演。视频1原声提供完整的说话情绪，逐句保留原声的语速、重音、语调、停顿、气口和情绪起伏，包括兴奋、惊讶、强调和自然口语感，不把原声改成平直的朗读。';
    voicePrompt = `\n${sourceInstruction}音频1仅提供音色，不使用音频1的台词，也不同时播放音频1，不沿用音频1的平淡语气或情绪。全片只有图片1中的一个人物说话，使用音频1的同一音色，不保留或混入原视频的人声，不添加旁白或第二个人声。原视频人声从第 ${task.speech.start.toFixed(3)} 秒开始，此前人物不得说话。严格按以下原视频时间线说话：${segments.map(segment => `${segment.start.toFixed(3)}–${segment.end.toFixed(3)} 秒：${segment.text}`).join('；')}。每段仅说一次，严格按顺序，价格、数字、单位按原字说，不改写、不补全、不重复。只在列出的台词区间说话，${gaps.length ? `${gaps.join('；')}必须保持静音。` : ''}最后一段结束后不得补说或复读。`;
  }
  return { modelId: task.model || MODEL, abilityType: 'VIDEO', prompt: PROMPT + lengthPrompt + captionPrompt + voicePrompt,
    // Video editing follows the source; fixed ratio/duration values are rejected by Seedance.
    payload: { params: { mode: 'fusion_video', resolution: '720p', scale: 'adaptive', duration: -1, generateAudio: !voiceConversion && !(task.sourceAudioMode === 'silent' && separateNarration) },
      resources: [`asset://${task.materials.photo.id}`], referVideoUrl: [`asset://${task.materials.video.id}`],
      ...(task.voice && !separateNarration ? { referAudioUrl: [`asset://${task.materials.voice.id}`] } : {}) } };
}
function nestedVideoUrl(value, key = '', depth = 0) {
  if (depth > 6 || !value) return undefined;
  if (typeof value === 'string') {
    return /^https?:\/\//i.test(value) && (/\.(mp4|mov)(?:\?|$)/i.test(value) || /video.?url|download|file.?url|result.?url|output.?url|play.?url/i.test(key)) ? value : undefined;
  }
  if (typeof value !== 'object') return undefined;
  for (const [name, child] of Object.entries(value)) {
    const found = nestedVideoUrl(child, `${key}.${name}`, depth + 1); if (found) return found;
  }
}
export function parseGeneration(body) {
  const layers = [body, body?.data, body?.data?.result, body?.result].filter(item => item && typeof item === 'object');
  const first = keys => layers.flatMap(layer => keys.map(key => layer[key])).find(value => value !== undefined && value !== null && value !== '');
  const status = String(first(['status', 'state', 'task_status']) ?? '').trim().toLowerCase();
  const completed = ['2', 'succeeded', 'success', 'completed', 'done', 'finished'].includes(status);
  const taskId = first(['taskId', 'task_id', 'id']);
  // Seedance queryResult returns the finished media URL in message, including extensionless URLs.
  const url = layers.flatMap(layer => ['videoUrl', 'video_url', 'resultUrl', 'url', 'content', ...(completed ? ['message'] : [])].map(key => layer[key]))
    .find(value => typeof value === 'string' && /^https?:\/\//.test(value)) || nestedVideoUrl(body);
  return { taskId: taskId == null ? null : String(taskId), url, completed,
    failed: ['3', '4', 'failed', 'failure', 'error', 'cancelled', 'canceled'].includes(status) };
}
export function createVideoProvider(config, fetchImpl = fetch) {
  async function call(kind, path, body) {
    const values = config[kind];
    let response;
    try {
      response = await fetchImpl(new URL(path, values.base), { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', projectCode: values.project, 'X-Access-Key': values.access, 'X-Secret-Key': values.secret },
        body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
      if (response.status >= 500 || [408, 429].includes(response.status)) {
        await response.body?.cancel().catch(() => {});
        throw new VideoError('模型服务暂时无法确认请求，请稍后查询原任务。', 502, 'VIDEO_PROVIDER_UNAVAILABLE');
      }
      const chunks = []; let length = 0;
      for await (const chunk of response.body) { length += chunk.length; if (length > 1024 * 1024) throw new Error(); chunks.push(chunk); }
      const data = JSON.parse(Buffer.concat(chunks).toString());
      if (!response.ok || data.success === false) {
        if (/白名单|whitelist|allowlist/i.test(String(data.msg || data.message || ''))) throw new VideoError('当前服务器 IP 未获模型服务授权，请管理员配置供应商 IP 白名单。', 502, 'VIDEO_PROVIDER_IP_DENIED');
        throw new VideoError('模型服务拒绝了请求，请检查模型权限、余额或素材要求。', 502, 'VIDEO_PROVIDER_REJECTED');
      }
      return data;
    } catch (error) {
      if (error instanceof VideoError) throw error;
      throw new VideoError('模型服务暂时无法连接，请稍后查询原任务。', 502, 'VIDEO_PROVIDER_UNAVAILABLE');
    }
  }
  return {
    async createMaterial(url, kind) {
      const result = await call('material', '/openApi/material/create', { name: `replica-${kind}`, originalUrl: url, type: 1, fileType: kind === 'photo' ? 1 : kind === 'voice' ? 2 : 3, thirdChannel: 1 });
      if (!result.data?.materialId) throw new VideoError('素材服务未返回素材编号。', 502, 'VIDEO_MATERIAL_INVALID');
      return { id: String(result.data.materialId), status: Number(result.data.status || 1) };
    },
    async queryMaterial(id) {
      const result = await call('material', '/openApi/material/pageList', { materialId: id, pageNo: 1, pageSize: 10 });
      const item = result.data?.records?.find(record => String(record.materialId) === id);
      return Number(item?.status || 1);
    },
    async generate(task) { return parseGeneration(await call('video', '/openApi/generate', generationBody(task))); },
    async query(id) { return parseGeneration(await call('video', '/openApi/queryResult', { taskId: id, abilityType: 'VIDEO' })); },
  };
}
