export const MODEL = 'doubao-seedance-2-0-260128';
export const DURATIONS = [4, 5, 6, 8, 10, 12, 15];
export const PROMPT = '将参考视频中的人物替换成参考图片中的人物形象。替换后的人物形象100%参考图片中的人物形象，严格保持人物五官、脸型、发型和外观特征的一致性。保留参考视频的动作、镜头、场景与说话内容，逐时刻保持动作和镜头顺序，不增加动作、不重复片段、不延伸表演。人物说话要带有情绪和情感，自然一些，不要生硬。人物面部表情也自然不僵硬，带有表情。去除画面叠加的字幕，不生成新的字幕；保留真实商品包装与场景标识。';
export class VideoError extends Error {
  constructor(message, status = 400, code = 'VIDEO_INVALID_INPUT') { super(message); this.status = status; this.code = code; }
}
export function videoConfig(env = {}, publicOrigin) {
  const credentials = prefix => ({ base: env[`${prefix}_API_BASE_URL`] || env.VIDEO_API_BASE_URL,
    project: env[`${prefix}_PROJECT_CODE`] || env.VIDEO_PROJECT_CODE,
    access: env[`${prefix}_ACCESS_KEY`] || env.VIDEO_ACCESS_KEY, secret: env[`${prefix}_SECRET_KEY`] || env.VIDEO_SECRET_KEY });
  const config = { video: credentials('VIDEO'), material: credentials('MATERIAL'),
    publicOrigin: env.VIDEO_PUBLIC_BASE_URL || publicOrigin || env.AUTH_PUBLIC_URL,
    signingSecret: env.TEMP_ASSET_SIGNING_SECRET };
  config.enabled = Boolean(config.publicOrigin && config.signingSecret && Object.values(config.video).every(Boolean) && Object.values(config.material).every(Boolean));
  if (config.enabled) {
    try {
      const origin = new URL(config.publicOrigin);
      if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error();
      config.publicOrigin = origin.origin;
      for (const value of [config.video, config.material]) {
        const target = new URL(value.base);
        if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error();
      }
    } catch { config.enabled = false; }
  }
  return config;
}
export function generationBody(task) {
  const lengthPrompt = task.video?.duration ? `\n参考视频实际时长为${task.video.duration.toFixed(3)}秒。动作严格对应原视频时刻，输出超过原视频时长的部分保持末帧静止、闭嘴和无声。` : '';
  let voicePrompt = '';
  if (task.voice) {
    const segments = task.speech.segments;
    const gaps = [];
    let end = 0;
    for (const segment of segments) { if (segment.start > end) gaps.push(`${end.toFixed(3)}–${segment.start.toFixed(3)}秒`); end = segment.end; }
    if (task.duration > end) gaps.push(`${end.toFixed(3)}秒至成片结束`);
    voicePrompt = `\n以下用户确认的台词是唯一台词依据。参考视频提供动作和节奏，参考音频仅提供音色，不使用参考音频的台词。全片只有照片中的一个人物说话，使用参考音频的同一音色，不保留或混入原视频的人声，不添加旁白或第二个人声。原视频人声从第 ${task.speech.start.toFixed(3)} 秒开始，此前人物不得说话。严格按以下原视频时间线说话：${segments.map(segment => `${segment.start.toFixed(3)}–${segment.end.toFixed(3)} 秒：${segment.text}`).join('；')}。每段仅说一次，严格按顺序，价格、数字、单位按原字说，不改写、不补全、不重复。只在列出的台词区间说话，${gaps.length ? `${gaps.join('；')}必须保持静音。` : ''}最后一段结束后不得补说或复读。`;
  }
  return { modelId: MODEL, abilityType: 'VIDEO', prompt: PROMPT + lengthPrompt + voicePrompt,
    payload: { params: { mode: 'fusion_video', resolution: '720p', scale: task.ratio, duration: task.duration, generateAudio: true },
      resources: [`asset://${task.materials.photo.id}`], referVideoUrl: [`asset://${task.materials.video.id}`],
      ...(task.voice ? { referAudioUrl: [`asset://${task.materials.voice.id}`] } : {}) } };
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
