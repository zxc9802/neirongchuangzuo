import COS from 'cos-nodejs-sdk-v5';
import { loadWorkspaceSettings } from '../services/runtime-settings.mjs';
import { mixMaterialEnvironment } from '../services/mix/material-config.mjs';

const env = mixMaterialEnvironment(loadWorkspaceSettings());
const names = ['MIX_MATERIAL_COS_SECRET_ID', 'MIX_MATERIAL_COS_SECRET_KEY', 'MIX_MATERIAL_COS_BUCKET', 'MIX_MATERIAL_COS_REGION'];
if (names.some(name => !env[name])) throw new Error('请先配置服务端 MIX_MATERIAL_COS_* 环境变量。');
const origins = new Set();
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  if (args[i] !== '--origin' || !args[i + 1]) throw new Error('用法：node scripts/configure-mix-materials-cors.mjs --origin https://你的站点');
  const url = new URL(args[i + 1]);
  if (url.username || url.password || !['https:', 'http:'].includes(url.protocol)
      || url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('生产站点必须使用 HTTPS。');
  origins.add(url.origin);
}
if (env.AUTH_PUBLIC_URL) origins.add(new URL(env.AUTH_PUBLIC_URL).origin);
if (!origins.size) throw new Error('请通过 --origin 指定应用站点，或配置 AUTH_PUBLIC_URL。');
const cos = new COS({ SecretId: env[names[0]], SecretKey: env[names[1]], Timeout: 15000 });
const base = { Bucket: env[names[2]], Region: env[names[3]] };
const invoke = (method, params = {}) => new Promise((resolve, reject) => cos[method]({ ...base, ...params },
  (error, result) => error ? reject(new Error(`COS 跨域配置失败：${error.code || error.statusCode || 'network'}`)) : resolve(result)));
const existing = await invoke('getBucketCors');
const id = 'mix-materials-direct-upload';
const rules = existing.CORSRules || [];
for (const origin of rules.find(rule => rule.ID === id)?.AllowedOrigins || []) origins.add(origin);
await invoke('putBucketCors', { CORSRules: [...rules.filter(rule => rule.ID !== id), {
  ID: id, AllowedOrigins: [...origins], AllowedMethods: ['PUT', 'GET', 'HEAD'],
  AllowedHeaders: ['*'], ExposeHeaders: ['ETag', 'Content-Length', 'Content-Range'], MaxAgeSeconds: 600,
}] });
console.log(JSON.stringify({ bucket: base.Bucket, region: base.Region, allowedOrigins: [...origins], configured: true }));
