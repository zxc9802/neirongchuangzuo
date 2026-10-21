import { VideoError } from './provider.mjs';

const BASE = 'https://api.heygen.com/v3/lipsyncs';
const failure = (message, code = 'VIDEO_LIPSYNC_FAILED') => new VideoError(message, 502, code);
export function createHeygenLipsyncService(env = {}, fetchImpl = fetch) {
  const key = env.VIDEO_HEYGEN_API_KEY || env.HEYGEN_API_KEY;
  async function call(url, body) {
    if (!key) throw new VideoError('HeyGen 官方对口型尚未配置。', 503, 'VIDEO_HEYGEN_NOT_CONFIGURED');
    let response;
    try {
      response = await fetchImpl(url, { method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) });
    } catch (cause) {
      if (cause.providerNotDispatched) throw cause;
      throw failure(body ? 'HeyGen 提交未获确认，已保留现场，请核对原任务，未重复扣费提交。' : '正在查询已有 HeyGen 任务。',
        body ? 'VIDEO_LIPSYNC_UNCERTAIN' : 'VIDEO_LIPSYNC_PENDING');
    }
    if (!response.ok) {
      if ([400, 401, 402, 403, 404, 422, 429].includes(response.status)) {
        throw Object.assign(failure(`HeyGen 请求被拒绝（HTTP ${response.status}），请检查 API 余额、权限或素材。`), { providerNotDispatched: Boolean(body) });
      }
      throw failure('HeyGen 暂未确认处理结果，未重复提交。', body ? 'VIDEO_LIPSYNC_UNCERTAIN' : 'VIDEO_LIPSYNC_PENDING');
    }
    try { return (await response.json()).data; }
    catch { throw failure('HeyGen 返回结果暂不可读。', body ? 'VIDEO_LIPSYNC_UNCERTAIN' : 'VIDEO_LIPSYNC_PENDING'); }
  }
  return { enabled: Boolean(key), model: 'heygen-lipsync-precision',
    async submit(videoUrl, audioUrl) {
      const data = await call(BASE, { video: { type: 'url', url: videoUrl }, audio: { type: 'url', url: audioUrl },
        mode: 'precision', enable_dynamic_duration: false, keep_the_same_format: true, fps_mode: 'passthrough',
        disable_music_track: true, enable_caption: false, enable_speech_enhancement: false });
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(data?.lipsync_id || '')) throw failure('HeyGen 未返回任务编号，请核对原记录。', 'VIDEO_LIPSYNC_UNCERTAIN');
      return { id: data.lipsync_id, provider: 'heygen', model: 'precision' };
    },
    async query(job) {
      if (job.provider !== 'heygen' || !/^[A-Za-z0-9_-]{1,200}$/.test(job.id || '')) throw failure('HeyGen 任务编号无效。');
      const data = await call(`${BASE}/${job.id}`);
      if (['failed', 'cancelled'].includes(data?.status)) throw failure('HeyGen 对口型失败，已保留配音和原生成画面，未重新提交。');
      if (data?.status !== 'completed') return null;
      try {
        const url = new URL(data.video_url);
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error();
        return url.href;
      } catch { throw failure('HeyGen 尚未返回可下载的成片。', 'VIDEO_LIPSYNC_PENDING'); }
    },
  };
}
