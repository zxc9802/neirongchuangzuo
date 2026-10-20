import { WAN_MODEL, VideoError } from './provider.mjs';

const origin = 'https://queue.fal.run';
export function wanGenerationBody(task) {
  return { video_url: task.materials.video.id, image_url: task.materials.photo.id,
    resolution: '720p', enable_safety_checker: true };
}
function queueUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin !== origin || url.username || url.password || !url.pathname.startsWith('/fal-ai/wan/')) throw new Error();
    return url.href;
  } catch { throw new VideoError('Wan 返回的任务地址无效。', 502, 'VIDEO_PROVIDER_UNAVAILABLE'); }
}
export function createWanProvider(config, fetchImpl = fetch) {
  async function call(url, body) {
    if (!config.falKey) throw new VideoError('Wan 2.2 人物替换尚未配置。', 503, 'VIDEO_NOT_CONFIGURED');
    try {
      const response = await fetchImpl(queueUrl(url), { method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { Authorization: `Key ${config.falKey}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) });
      if (!response.ok) {
        if ([400, 401, 402, 403, 422].includes(response.status)) throw new VideoError('Wan 拒绝请求，请检查 fal 余额、权限或素材要求。', 502, 'VIDEO_PROVIDER_REJECTED');
        throw new Error();
      }
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length; if (size > 1024 * 1024) throw new Error(); chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString());
    } catch (cause) {
      if (cause instanceof VideoError || cause.providerNotDispatched) throw cause;
      throw new VideoError('Wan 服务暂时无法连接，正在查询原任务。', 502, 'VIDEO_PROVIDER_UNAVAILABLE');
    }
  }
  return {
    async generate(task) {
      const data = await call(`${origin}/${WAN_MODEL}`, wanGenerationBody(task));
      if (!data.request_id || !data.status_url || !data.response_url) throw new VideoError('Wan 未返回完整任务编号，未自动重新提交。', 502, 'VIDEO_SUBMISSION_UNCERTAIN');
      return { taskId: String(data.request_id), falQueue: { status: queueUrl(data.status_url), result: queueUrl(data.response_url) } };
    },
    async query(id, task) {
      const status = await call(task.falQueue?.status);
      if (status.error || ['FAILED', 'CANCELLED'].includes(status.status)) return { taskId: id, failed: true };
      if (status.status !== 'COMPLETED') return { taskId: id };
      try {
        const data = await call(task.falQueue?.result);
        if (data.error) return { taskId: id, failed: true };
        const url = data.video?.url;
        return { taskId: id, completed: true, url: typeof url === 'string' && /^https:\/\//.test(url) ? url : undefined };
      } catch (cause) {
        if (cause.code === 'VIDEO_PROVIDER_REJECTED') return { taskId: id, failed: true };
        throw cause;
      }
    },
  };
}
