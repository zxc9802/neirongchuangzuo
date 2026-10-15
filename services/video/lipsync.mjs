import { VideoError } from './provider.mjs';

const ORIGIN = 'https://queue.fal.run';
export function createLipsyncService(env = {}, fetchImpl = fetch) {
  const key = env.FAL_KEY || env.FAL_API_KEY || env.VIDEO_FAL_KEY;
  const model = env.FAL_VEED_MODEL || 'veed/lipsync';
  const failure = (message, code = 'VIDEO_LIPSYNC_FAILED') => new VideoError(message, 502, code);
  function queueUrl(value) {
    try {
      const url = new URL(value);
      if (url.origin !== ORIGIN || url.username || url.password || !/^\/veed\/lipsync(?:\/|$)/.test(url.pathname)) throw new Error();
      return url.href;
    } catch { throw failure('口型服务返回的任务地址无效。'); }
  }
  async function call(url, body) {
    try {
      const response = await fetchImpl(queueUrl(url), { method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) });
      if (!response.ok) {
        if ([400, 401, 402, 403, 422].includes(response.status)) throw failure('口型服务拒绝了请求，请检查 fal 权限、余额或视频素材。');
        throw new Error();
      }
      return await response.json();
    } catch (cause) {
      if (cause instanceof VideoError) throw cause;
      throw failure(body ? '口型提交未获得确认，未自动重复生成，请核对原口型任务。' : '口型服务暂时不可用，正在查询原口型任务。',
        body ? 'VIDEO_LIPSYNC_UNCERTAIN' : 'VIDEO_LIPSYNC_PENDING');
    }
  }
  return { enabled: Boolean(key) && /^veed\/lipsync(?:\/v2)?$/.test(model), model,
    async submit(videoUrl, audioUrl) {
      const data = await call(`${ORIGIN}/${model}`, { video_url: videoUrl, audio_url: audioUrl });
      if (!data.request_id || !data.status_url || !data.response_url) throw failure('口型服务未返回完整任务编号，未自动重新提交。', 'VIDEO_LIPSYNC_UNCERTAIN');
      return { id: String(data.request_id), statusUrl: queueUrl(data.status_url), resultUrl: queueUrl(data.response_url) };
    },
    async query(job) {
      const status = await call(job.statusUrl);
      if (status.error || ['FAILED', 'CANCELLED'].includes(status.status)) throw failure('口型同步未完成，未交付口型不一致的成片。');
      if (status.status !== 'COMPLETED') return null;
      const result = await call(job.resultUrl);
      if (result.error || !result.video?.url) throw failure('口型服务没有返回可用视频。');
      return result.video.url;
    },
  };
}
