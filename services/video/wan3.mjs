import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { generationBody, WAN3_MODEL, VideoError } from './provider.mjs';

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
  const media = [{ type: 'reference_image', url: task.materials.photo.id }, { type: 'reference_video', url: task.materials.video.id }];
  const prompt = replica.prompt + '\n保留视频1的完整画布和原始构图。只有视频1原本存在黑边时，才保留相应位置和宽度的黑边；原视频没有黑边时，不得新增黑边或缩小有效画面。原有黑边必须保持纯黑，不能扩图、填充背景或在黑边内添加任何内容；人物替换仅在原视频有效画面内进行。';
  return { model: WAN3_MODEL, input: { prompt, media },
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
      if ([400, 401, 402, 403, 404, 422].includes(response.status)) {
        await response.body?.cancel();
        throw new VideoError('万相请求被拒绝，请检查阿里云密钥、模型权限、余额或素材要求。', 502, 'VIDEO_PROVIDER_REJECTED');
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(); }
      const chunks = []; let length = 0;
      for await (const chunk of response.body) { length += chunk.length; if (length > 1024 * 1024) throw new Error(); chunks.push(chunk); }
      const data = JSON.parse(Buffer.concat(chunks).toString());
      if (data.code) throw new VideoError('万相请求被拒绝，请检查模型权限、余额或素材要求。', 502, 'VIDEO_PROVIDER_REJECTED');
      return data;
    } catch (cause) {
      if (cause instanceof VideoError || cause.providerNotDispatched) throw cause;
      throw new VideoError('万相服务暂时无法确认请求，请查询原任务。', 502, 'VIDEO_PROVIDER_UNAVAILABLE');
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
      if (!response.ok) throw new VideoError('万相素材上传暂未完成，将重试上传。', 502, 'VIDEO_PROVIDER_UNAVAILABLE');
      return { id: `oss://${object}`, status: 2 };
    },
    async generate(task) {
      const data = await call('/api/v1/services/aigc/video-generation/video-synthesis', wan3GenerationBody(task));
      if (!/^[a-zA-Z0-9-]{1,100}$/.test(data.output?.task_id || '')) throw new VideoError('万相未返回任务编号，未自动重新提交。', 502, 'VIDEO_SUBMISSION_UNCERTAIN');
      return { taskId: data.output.task_id };
    },
    async query(id) {
      const data = await call(`/api/v1/tasks/${encodeURIComponent(id)}`), output = data.output;
      if (['FAILED', 'CANCELED'].includes(output?.task_status)) return { taskId: id, failed: true };
      if (output?.task_status !== 'SUCCEEDED') return { taskId: id };
      let url;
      try { const target = new URL(output.video_url); if (target.protocol === 'https:' && !target.username && !target.password) url = target.href; } catch { /* Retry the original task for its download URL. */ }
      return { taskId: id, completed: true, url, usage: wan3Usage(data.usage) };
    },
  };
}
