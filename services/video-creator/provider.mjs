import { createVideoProvider, parseGeneration, VideoError } from '../video/provider.mjs';
import { createProviderStorage } from '../video/provider-storage.mjs';
import { VIDEO_PROVIDER_MODELS } from '../../design/video-catalog.js';
import { setTimeout as delay } from 'node:timers/promises';

export function creatorConfig(env = {}, publicOrigin) {
  const value = (suffix, fallback) => env[`VIDEO_CREATOR_${suffix}`] || fallback;
  const credentials = prefix => ({ base: value(`${prefix}_API_BASE_URL`, env[`${prefix}_API_BASE_URL`] || value('VIDEO_API_BASE_URL', env.VIDEO_API_BASE_URL)),
    project: value(`${prefix}_PROJECT_CODE`, env[`${prefix}_PROJECT_CODE`] || value('VIDEO_PROJECT_CODE', env.VIDEO_PROJECT_CODE)),
    access: value(`${prefix}_ACCESS_KEY`, env[`${prefix}_ACCESS_KEY`] || value('VIDEO_ACCESS_KEY', env.VIDEO_ACCESS_KEY)),
    secret: value(`${prefix}_SECRET_KEY`, env[`${prefix}_SECRET_KEY`] || value('VIDEO_SECRET_KEY', env.VIDEO_SECRET_KEY)) });
  const config = { video: credentials('VIDEO'), material: credentials('MATERIAL'),
    publicOrigin: value('PUBLIC_BASE_URL', publicOrigin || env.AUTH_PUBLIC_URL),
    signingSecret: value('SIGNING_SECRET', env.TEMP_ASSET_SIGNING_SECRET), storageKey: env.VIDEO_CREATOR_STORAGE_KEY };
  const dedicated = ['PROJECT_CODE', 'ACCESS_KEY', 'SECRET_KEY'].map(name => value(`SEEDANCE_25_${name}`, env[`VIDEO_SEEDANCE_25_${name}`]));
  config.dedicated25 = dedicated.some(Boolean) ? { ...config.video, project: dedicated[0], access: dedicated[1], secret: dedicated[2] } : null;
  try {
    if (config.publicOrigin) {
      const url = new URL(config.publicOrigin);
      if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
      config.publicOrigin = url.origin;
    }
    for (const v of [config.video, config.material]) {
      const url = new URL(v.base); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error();
    }
    config.enabled = [config.video, config.material].every(v => Object.values(v).every(Boolean))
      && Boolean(config.storageKey || config.publicOrigin && config.signingSecret);
  } catch { config.enabled = false; }
  return config;
}

export function creativeGenerationBody(input) {
  const model = VIDEO_PROVIDER_MODELS.find(m => m.id === input.model);
  if (!model || input.imageIds.length < 1 || input.imageIds.length > model.maxImages || input.audioIds.length > 1
    || !model.resolutions.includes(input.resolution) || !model.durations.includes(input.duration)) {
    throw new VideoError('当前素材数量或视频设置超出所选模型的支持范围。', 400, 'CREATOR_MODEL_LIMIT');
  }
  return { modelId: input.model, abilityType: 'VIDEO', prompt: input.prompt,
    payload: { params: { mode: 'fusion_video', resolution: input.resolution, scale: input.ratio, duration: input.duration, generateAudio: input.generateAudio },
      resources: input.imageIds.map(id => `asset://${id}`), ...(input.audioIds.length ? { referAudioUrl: input.audioIds.map(id => `asset://${id}`) } : {}) } };
}

export function createCreatorProvider(config, fetchImpl = fetch) {
  const common = createVideoProvider(config, fetchImpl);
  const storage = config.storageKey ? createProviderStorage({ FAL_KEY: config.storageKey }, fetchImpl) : null;
  async function materialRequest(path, body, timeoutMs = 30000) {
    try {
      const c = config.material, response = await fetchImpl(new URL(path, c.base), { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', projectCode: c.project, 'X-Access-Key': c.access, 'X-Secret-Key': c.secret },
        body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > 1024 * 1024) throw new Error(); chunks.push(chunk); }
      const data = JSON.parse(Buffer.concat(chunks).toString());
      if (!response.ok || data.success === false) {
        if (/白名单|whitelist|allowlist/i.test(String(data.msg || data.message || ''))) throw new VideoError('当前服务器 IP 未获模型服务授权，请管理员配置供应商 IP 白名单。', 502, 'VIDEO_PROVIDER_IP_DENIED');
        throw new VideoError('素材服务拒绝请求，请检查素材或接口权限。', 502, 'VIDEO_PROVIDER_REJECTED');
      }
      return data;
    } catch (cause) {
      if (cause instanceof VideoError) throw cause;
      throw new VideoError('素材接口连接中断，请稍后查看任务。', 502, 'VIDEO_PROVIDER_UNAVAILABLE');
    }
  }
  const identity = value => { try { const u = new URL(value); return u.origin + u.pathname; } catch { return null; } };
  async function findMaterial(url, fileType) {
    const sourceIdentity = identity(url); if (!sourceIdentity) return null;
    const data = await materialRequest('/openApi/material/pageList', { pageNo: 1, pageSize: 50 });
    const found = data.data?.records?.find(r => r.materialId && identity(r.originalUrl) === sourceIdentity && Number(r.fileType || fileType) === fileType);
    return found ? { id: String(found.materialId), status: Number(found.status || 1) } : null;
  }
  return { ...common, async uploadSource(asset) {
    if (!storage) return null;
    try { return await storage.upload(asset.path, asset.type === 'image' ? 'image/jpeg' : 'audio/wav'); }
    catch { throw new VideoError('素材传输失败，尚未提交视频生成，请稍后重试。', 502, 'CREATOR_SOURCE_UPLOAD_FAILED'); }
  }, async createMaterial(url, kind) {
    const fileType = kind === 'photo' ? 1 : kind === 'voice' ? 2 : 3;
    const known = await findMaterial(url, fileType).catch(() => null); if (known) return known;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const data = await materialRequest('/openApi/material/create', { name: `qiya-video-${kind}`, originalUrl: url, type: 1, fileType, thirdChannel: 1 }, 120000);
        if (!data.data?.materialId) throw new VideoError('素材服务未返回素材编号。', 502, 'VIDEO_PROVIDER_UNAVAILABLE');
        return { id: String(data.data.materialId), status: Number(data.data.status || 1) };
      } catch (cause) {
        if (cause.code !== 'VIDEO_PROVIDER_UNAVAILABLE') throw cause;
        const recovered = await findMaterial(url, fileType).catch(() => null); if (recovered) return recovered;
        if (attempt === 2) throw cause;
        await delay(500 * (attempt + 1));
      }
    }
  }, async queryMaterial(id) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const data = await materialRequest('/openApi/material/pageList', { materialId: id, pageNo: 1, pageSize: 10 });
        return Number(data.data?.records?.find(r => String(r.materialId) === id)?.status || 1);
      } catch (cause) { if (cause.code !== 'VIDEO_PROVIDER_UNAVAILABLE' || attempt === 2) throw cause; await delay(500 * (attempt + 1)); }
    }
  }, async generateCreative(input) {
    const body = creativeGenerationBody(input), c = input.model === 'doubao-seedance-2-5-260628' && config.dedicated25 ? config.dedicated25 : config.video;
    if (!Object.values(c).every(Boolean)) throw new VideoError('所选模型的独立接口配置不完整。', 503, 'CREATOR_MODEL_NOT_CONFIGURED');
    try {
      const response = await fetchImpl(new URL('/openApi/generate', c.base), { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', projectCode: c.project, 'X-Access-Key': c.access, 'X-Secret-Key': c.secret },
        body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > 1024 * 1024) throw new Error(); chunks.push(chunk); }
      const result = JSON.parse(Buffer.concat(chunks).toString());
      if (!response.ok || result.success === false) {
        if (/白名单|whitelist|allowlist/i.test(String(result.msg || result.message || ''))) throw new VideoError('当前服务器 IP 未获模型服务授权，请管理员配置供应商 IP 白名单。', 502, 'VIDEO_PROVIDER_IP_DENIED');
        throw new VideoError('视频服务拒绝请求，请检查模型权限、余额或素材要求。', 502, 'VIDEO_PROVIDER_REJECTED');
      }
      return parseGeneration(result);
    } catch (cause) {
      if (cause instanceof VideoError) throw cause;
      throw new VideoError('视频提交暂时无法确认，请稍后查询原任务。', 502, 'VIDEO_PROVIDER_UNAVAILABLE');
    }
  }, async query(id, model) {
    const c = model === 'doubao-seedance-2-5-260628' && config.dedicated25 ? { ...config, video: config.dedicated25 } : config;
    return createVideoProvider(c, fetchImpl).query(id);
  } };
}
