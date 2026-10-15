import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { VideoError } from './provider.mjs';

export function createProviderStorage(env = {}, fetchImpl = fetch) {
  const key = env.FAL_KEY || env.FAL_API_KEY || env.VIDEO_FAL_KEY;
  function mediaUrl(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password
      || !['fal.media', 'amazonaws.com', 'cloudflarestorage.com'].some(host => url.hostname === host || url.hostname.endsWith('.' + host))) throw new Error();
    return url.href;
  }
  return { async upload(input, contentType) {
    try {
      const response = await fetchImpl('https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3', {
        method: 'POST', redirect: 'error', headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json',
          'X-Fal-Object-Lifecycle': JSON.stringify({ expiration_duration_seconds: 3 * 86400 }) },
        body: JSON.stringify({ file_name: basename(input), content_type: contentType }), signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) throw new Error();
      const data = await response.json(), uploadUrl = mediaUrl(data.upload_url), fileUrl = mediaUrl(data.file_url);
      const uploaded = await fetchImpl(uploadUrl, { method: 'PUT', redirect: 'error', headers: { 'Content-Type': contentType },
        body: await readFile(input), signal: AbortSignal.timeout(60000) });
      if (!uploaded.ok) throw new Error();
      return fileUrl;
    } catch { throw new VideoError('配音素材正在重试传输，尚未重复提交生成。', 502, 'VIDEO_NARRATION_PENDING'); }
  } };
}
