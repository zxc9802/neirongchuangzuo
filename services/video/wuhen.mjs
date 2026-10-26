import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { VideoError } from './provider.mjs';

const failure = (message, code, notDispatched = false) => Object.assign(new VideoError(message, 503, `VIDEO_CLEANUP_${code}`),
  { providerNotDispatched: notDispatched });

// https://www.wuhenai.com/api-docs/ — STD full-screen removal, never a local blur/inpaint fallback.
export function createWuhenProvider({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  let token, expires = 0, authenticating;
  function assertConfigured() {
    if (!env.WUHENAI_API_KEY) throw failure('全屏字幕清理尚未配置，请联系管理员设置 WUHENAI_API_KEY。', 'NOT_CONFIGURED', true);
  }
  async function request(path, { body, auth } = {}) {
    const url = new URL('https://api.wuhenai.com/v2' + path);
    url.searchParams.set('nonce', randomUUID()); url.searchParams.set('t', String(Math.floor(now() / 1000)));
    if (!auth) url.searchParams.set('api_key', env.WUHENAI_API_KEY);
    let response, data;
    try {
      response = await fetchImpl(url.href, { method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
      data = await response.json();
    } catch {
      throw failure(body ? '全屏清理提交未获确认，未重复提交，请核对无痕AI任务记录。'
        : '全屏清理服务暂时无法连接，已有进度已保留。', body ? 'UNCERTAIN' : 'PENDING', !body);
    }
    if (response.ok && data.code === 0) return data.data;
    if (data.code === 401 || response.status === 401) { token = undefined; expires = 0; }
    const rejected = [1001, 3001, 4001, 4003, 4004, 401, 7003, 7004].includes(data.code)
      || [400, 401, 402, 403, 404, 422].includes(response.status);
    if (body && !rejected) throw failure('全屏清理提交结果不确定，未重复提交，请核对无痕AI任务记录。', 'UNCERTAIN');
    const account = [3001, 4003, 401, 7003, 7004].includes(data.code) || [401, 402, 403].includes(response.status);
    throw failure(account ? data.code === 3001 ? '无痕AI积分不足，恢复额度后可继续清理已有成片。'
      : '无痕AI账户或密钥不可用，请联系管理员检查。' : `全屏清理请求未成功（状态码 ${Number(data.code) || response.status}），已有成片已保留。`,
    account ? 'ACCOUNT' : body ? 'REJECTED' : 'PENDING', rejected || !body);
  }
  async function authorize() {
    assertConfigured();
    if (token && expires > now() + 60000) return token;
    if (!authenticating) authenticating = request('/user/access_token').then(data => {
      if (!data?.access_token || !Number.isFinite(data.expired)) throw failure('全屏清理鉴权返回无效，请稍后重试。', 'PENDING', true);
      token = data.access_token; expires = data.expired * 1000; return token;
    }).finally(() => { authenticating = undefined; });
    return authenticating;
  }
  return {
    assertConfigured, authorize,
    async submit({ videoUrl, uploadUrl, uploadHeaders }) {
      const auth = await authorize();
      const data = await request('/video_removal', { auth, body: { video_url: videoUrl, model: 'video_removal_std',
        method: 'all_area', upload_url: uploadUrl, upload_headers: uploadHeaders } });
      if (typeof data?.task_id !== 'string' || !data.task_id) throw failure('全屏清理没有返回任务编号，未重复提交，请核对原任务。', 'UNCERTAIN');
      return data.task_id;
    },
    async query(id) {
      const data = await request('/status?task_id=' + encodeURIComponent(id), { auth: await authorize() });
      if (data?.task_id !== id || !['created', 'queued', 'processing', 'success', 'failed', 'paused'].includes(data.status)) {
        throw failure('全屏清理返回的任务状态无效，正在重新查询原任务。', 'PENDING');
      }
      return data;
    },
  };
}

export function createWuhenStorage({ env = process.env, cosClient } = {}) {
  const fields = ['SECRET_ID', 'SECRET_KEY', 'BUCKET', 'REGION'];
  const prefix = fields.every(field => env['MIX_MATERIAL_COS_' + field]) ? 'MIX_MATERIAL_COS_' : 'COS_';
  const configured = Boolean(cosClient || fields.every(field => env[prefix + field]));
  const settings = { Bucket: env[prefix + 'BUCKET'], Region: env[prefix + 'REGION'] };
  let client;
  function assertConfigured() {
    if (!configured) throw failure('全屏字幕清理的 COS 存储尚未配置，请联系管理员。', 'NOT_CONFIGURED', true);
  }
  function key(id, kind) {
    if (!/^[a-f0-9-]{36}$/.test(id) || !['input', 'output'].includes(kind)) throw new Error('Invalid cleanup object');
    return `workspace-video/subtitle-removal/${id}/${kind}.mp4`;
  }
  async function call(method, options) {
    assertConfigured();
    try {
      client ||= cosClient || import('cos-nodejs-sdk-v5').then(({ default: COS }) => new COS({
        SecretId: env[prefix + 'SECRET_ID'], SecretKey: env[prefix + 'SECRET_KEY'], Protocol: 'https:', Timeout: 60000,
      }));
      const cos = await client;
      return await new Promise((resolve, reject) => cos[method]({ ...settings, ...options }, (error, data) => error ? reject(error) : resolve(data)));
    } catch { throw failure('全屏清理的素材传输暂时失败，正在重试，已有任务不会重新提交。', 'PENDING', true); }
  }
  const signed = async (id, kind, method = 'GET', headers) => (await call('getObjectUrl', {
    Key: key(id, kind), Method: method, Sign: true, Protocol: 'https:', Expires: 36 * 3600, ...(headers ? { Headers: headers } : {}),
  })).Url;
  return {
    assertConfigured,
    async upload(id, path) {
      const size = (await stat(path)).size, body = createReadStream(path);
      try { await call('putObject', { Key: key(id, 'input'), Body: body, ContentLength: size, ContentType: 'video/mp4', ACL: 'private' }); }
      finally { body.destroy(); }
    },
    async submissionUrls(id) {
      const uploadHeaders = { 'Content-Type': 'video/mp4' };
      return { videoUrl: await signed(id, 'input'), uploadUrl: await signed(id, 'output', 'PUT', uploadHeaders), uploadHeaders };
    },
    outputUrl: id => signed(id, 'output'),
    async remove(id) { for (const kind of ['input', 'output']) await call('deleteObject', { Key: key(id, kind) }); },
  };
}
