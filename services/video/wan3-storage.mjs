import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { VideoError } from './provider.mjs';

const TYPES = { photo: 'jpg', product: 'jpg', background: 'jpg', voice: 'wav', video: 'mp4' };

// Temporary provider inputs are private and separate from the permanent asset library.
export function createWan3Storage({ env = process.env, cosClient } = {}) {
  const configured = Boolean(cosClient || env.COS_SECRET_ID && env.COS_SECRET_KEY && env.COS_BUCKET && env.COS_REGION);
  const settings = { Bucket: env.COS_BUCKET, Region: env.COS_REGION };
  let client;
  function key(taskId, kind) {
    const extension = TYPES[kind] || (/^segment-\d$/.test(kind) ? 'mp4' : null);
    if (!/^[a-f0-9-]{36}$/.test(taskId) || !extension) throw new Error('Invalid Wan material');
    return `workspace-video/wan3/${taskId}/${kind}.${extension}`;
  }
  async function call(method, options) {
    if (!configured) throw new VideoError('首发 Wan 素材存储尚未配置，请配置 COS 后继续处理。', 503, 'VIDEO_SOURCE_STORAGE_NOT_CONFIGURED');
    try {
      client ||= cosClient || import('cos-nodejs-sdk-v5').then(({ default: COS }) => new COS({
        SecretId: env.COS_SECRET_ID, SecretKey: env.COS_SECRET_KEY, Protocol: 'https:', Timeout: 60000,
      }));
      const cos = await client;
      return await new Promise((resolve, reject) => cos[method]({ ...settings, ...options }, (error, result) => error ? reject(error) : resolve(result)));
    } catch {
      throw new VideoError('首发 Wan 素材云存储暂时不可用，正在重试传输，尚未提交新的生成请求。', 503, 'VIDEO_SOURCE_STORAGE_FAILED');
    }
  }
  return {
    async upload(taskId, kind, path, contentType) {
      const size = (await stat(path)).size, body = createReadStream(path);
      try {
        await call('putObject', { Key: key(taskId, kind), Body: body, ContentLength: size, ContentType: contentType, ACL: 'private' });
      } finally { body.destroy(); }
    },
    async url(taskId, kind) {
      // Refresh the signature before each submission, including retries after a restart.
      const result = await call('getObjectUrl', { Key: key(taskId, kind), Sign: true, Protocol: 'https:', Expires: 3 * 86400 });
      return result.Url;
    },
    async remove(taskId, kind) { await call('deleteObject', { Key: key(taskId, kind) }); },
  };
}
