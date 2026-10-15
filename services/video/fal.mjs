import { generationBody, VideoError } from './provider.mjs';

export const FAL_MODEL = 'minimax/h3-max/reference-to-video';
const origin = 'https://queue.fal.run';
export function falGenerationBody(task) {
  return { prompt: generationBody(task).prompt.replaceAll('视频1', 'Video 1').replaceAll('图片1', 'Image 1').replaceAll('音频1', 'Audio 1'),
    reference_image_urls: [task.materials.photo.id], reference_video_urls: [task.materials.video.id],
    ...(task.voice ? { reference_audio_urls: [task.materials.voice.id] } : {}),
    duration: task.duration, aspect_ratio: task.ratio, resolution: '768P', prompt_expansion_mode: 'disabled' };
}
function queueUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin !== origin || url.username || url.password || !url.pathname.startsWith('/minimax/h3-max/')) throw new Error();
    return url.href;
  } catch { throw new VideoError('极速模型任务队列地址无效。', 502, 'VIDEO_PROVIDER_UNAVAILABLE'); }
}
export function createFalVideoProvider(config, fetchImpl = fetch) {
  async function call(url, body) {
    if (!config.falKey) throw new VideoError('极速模型尚未配置。', 503, 'VIDEO_NOT_CONFIGURED');
    try {
      const response = await fetchImpl(queueUrl(url), { method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { Authorization: `Key ${config.falKey}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) });
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > 1024 * 1024) throw new Error(); chunks.push(chunk); }
      if (!response.ok) {
        if ([400, 401, 402, 403, 422].includes(response.status)) throw new VideoError('极速模型服务拒绝请求，请检查 fal 余额、密钥权限或素材要求。', 502, 'VIDEO_PROVIDER_REJECTED');
        throw new Error();
      }
      return JSON.parse(Buffer.concat(chunks).toString());
    } catch (cause) {
      if (cause instanceof VideoError) throw cause;
      throw new VideoError('极速模型服务暂时无法连接，正在查询原任务。', 502, 'VIDEO_PROVIDER_UNAVAILABLE');
    }
  }
  return {
    // fal accepts the same signed media URLs directly, without Seedance asset registration.
    async createMaterial(url) { return { id: url, status: 2 }; },
    async queryMaterial() { return 2; },
    async generate(task) {
      const data = await call(`${origin}/${FAL_MODEL}`, falGenerationBody(task));
      if (!data.request_id || !data.status_url || !data.response_url) throw new VideoError('极速模型未返回完整任务编号，未自动重新提交。', 502, 'VIDEO_SUBMISSION_UNCERTAIN');
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
