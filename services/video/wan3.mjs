import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { generationBody, WAN3_MODEL, VideoError } from './provider.mjs';
import { providerFailure, readProviderResponse, safeVideoError } from './errors.mjs';
import { deepImageKinds, isDeepReplica } from './deep-replica.mjs';

const base = 'https://dashscope.aliyuncs.com';
// Beijing standard 720P: the published 30% discount ends after October 31.
export function wan3Price(at = Date.now()) {
  return at >= Date.parse('2026-08-24T00:00:00+08:00') && at < Date.parse('2026-11-01T00:00:00+08:00') ? .42 : .6;
}
export function wan3GenerationBody(task) {
  if (task.voice && !['indextts2', 'chatterbox'].includes(task.voiceEngine)) {
    throw new VideoError('Wan 3.0 换声请使用 Chatterbox 音色转换。', 400, 'VIDEO_VOICE_ENGINE_INVALID');
  }
  const replica = generationBody(task);
  const images = isDeepReplica(task) ? deepImageKinds(task) : ['photo'];
  const media = [...images.map(kind => ({ type: 'reference_image', url: task.materials[kind].id })), { type: 'reference_video', url: task.materials.video.id }];
  return { model: WAN3_MODEL, input: { prompt: isDeepReplica(task) ? replica.prompt.replaceAll('图片', '图') : replica.prompt, media },
    parameters: { resolution: '720P', ratio: 'adaptive', duration: -1,
      audio: replica.payload.params.generateAudio, prompt_extend: false, watermark: false } };
}
export function wan3Usage(value) {
  if (![value?.duration, value?.input_video_duration, value?.output_video_duration].every(number => typeof number === 'number' && Number.isFinite(number) && number > 0)
    || Math.abs(value.duration - value.input_video_duration - value.output_video_duration) > .05
    || value.duration > 30.1 || value.SR !== 720) return undefined;
  return { duration: value.duration, input_video_duration: value.input_video_duration, output_video_duration: value.output_video_duration, SR: value.SR };
}
export function createWan3Provider(config, fetchImpl = fetch) {
  async function call(path, body) {
    if (!config.dashscopeKey) throw Object.assign(new VideoError('Wan 3.0 尚未配置阿里云 API Key。', 503, 'VIDEO_NOT_CONFIGURED'), { providerNotDispatched: true });
    try {
      const response = await fetchImpl(base + path, { method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { Authorization: `Bearer ${config.dashscopeKey}`, 'Content-Type': 'application/json',
          ...(body ? { 'X-DashScope-Async': 'enable', 'X-DashScope-OssResourceResolve': 'enable' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) });
      const data = await readProviderResponse(response), detail = providerFailure(data, [config.dashscopeKey]);
      if (response.status === 429) {
        const retry = response.headers.get('retry-after');
        const retryAfterMs = retry ? /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now() : 5000;
        throw Object.assign(new VideoError(`万相请求频率或并发额度受限（HTTP 429）${detail ? `：${detail}` : '，正在排队等待。'}`, 429, 'VIDEO_PROVIDER_RATE_LIMITED'),
          { providerNotDispatched: true, retryAfterMs: Number.isFinite(retryAfterMs) ? Math.max(1000, retryAfterMs) : 5000 });
      }
      if ([400, 401, 402, 403, 404, 422].includes(response.status)) {
        throw Object.assign(new VideoError(`万相请求被拒绝（HTTP ${response.status}）${detail ? `：${detail}` : '，上游未返回具体原因。'}`, 502, 'VIDEO_PROVIDER_REJECTED'), { providerNotDispatched: true });
      }
      if (!response.ok) throw new VideoError(`万相请求暂未成功（HTTP ${response.status}）${detail ? `：${detail}` : '，上游未返回具体原因。'}`, 502, 'VIDEO_PROVIDER_UNAVAILABLE');
      if (data.code) throw Object.assign(new VideoError(`万相请求被拒绝：${detail}`, 502, 'VIDEO_PROVIDER_REJECTED'), { providerNotDispatched: true });
      return data;
    } catch (cause) {
      if (cause instanceof VideoError || cause.providerNotDispatched) throw cause;
      const detail = safeVideoError([cause.name, cause.message, cause.cause?.code].filter(Boolean).join('：'), [config.dashscopeKey]);
      throw new VideoError(`万相请求连接或响应读取失败：${detail}`, 502, 'VIDEO_PROVIDER_UNAVAILABLE');
    }
  }
  return {
    async upload(path, contentType) {
      const { data: policy } = await call(`/api/v1/uploads?action=getPolicy&model=${WAN3_MODEL}`);
      let host;
      try {
        host = new URL(policy.upload_host);
        if (host.protocol !== 'https:' || host.username || host.password || host.port || !host.hostname.endsWith('.aliyuncs.com')
          || !policy.upload_dir || !policy.oss_access_key_id || !policy.policy || !policy.signature) throw new Error();
      } catch { throw new VideoError('万相素材上传凭据无效。', 502, 'VIDEO_MATERIAL_INVALID'); }
      const name = basename(path), object = `${policy.upload_dir}/${name}`, form = new FormData();
      for (const [key, value] of Object.entries({ OSSAccessKeyId: policy.oss_access_key_id, policy: policy.policy, Signature: policy.signature,
        key: object, 'x-oss-object-acl': policy.x_oss_object_acl, 'x-oss-forbid-overwrite': policy.x_oss_forbid_overwrite, success_action_status: '200' })) {
        if (value !== undefined) form.append(key, String(value));
      }
      form.append('file', new Blob([await readFile(path)], { type: contentType }), name);
      const response = await fetchImpl(host, { method: 'POST', body: form, redirect: 'error', signal: AbortSignal.timeout(120_000) });
      await response.body?.cancel();
      if (!response.ok) throw new VideoError(`万相素材上传失败（HTTP ${response.status}），将重试上传。`, 502, 'VIDEO_PROVIDER_UNAVAILABLE');
      return { id: `oss://${object}`, status: 2 };
    },
    async generate(task) {
      const data = await call('/api/v1/services/aigc/video-generation/video-synthesis', wan3GenerationBody(task));
      if (!/^[a-zA-Z0-9-]{1,100}$/.test(data.output?.task_id || '')) throw new VideoError('万相未返回任务编号，未自动重新提交。', 502, 'VIDEO_SUBMISSION_UNCERTAIN');
      return { taskId: data.output.task_id };
    },
    async query(id) {
      const data = await call(`/api/v1/tasks/${encodeURIComponent(id)}`), output = data.output;
      if (['FAILED', 'CANCELED'].includes(output?.task_status)) return { taskId: id, failed: true, error: providerFailure(data, [config.dashscopeKey]) };
      if (output?.task_status !== 'SUCCEEDED') return { taskId: id };
      let url;
      try { const target = new URL(output.video_url); if (target.protocol === 'https:' && !target.username && !target.password) url = target.href; } catch { /* Retry the original task for its download URL. */ }
      return { taskId: id, completed: true, url, usage: wan3Usage(data.usage) };
    },
  };
}
