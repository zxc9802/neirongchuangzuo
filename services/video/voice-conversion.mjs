import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { VideoError } from './provider.mjs';
import { downloadVideo } from './media.mjs';
import { createProviderStorage } from './provider-storage.mjs';
import { muxNarration } from './narration.mjs';

const run = promisify(execFile);
export const VOICE_CONVERSION_MODEL = 'fal-ai/chatterbox/speech-to-speech';
const endpoint = `https://queue.fal.run/${VOICE_CONVERSION_MODEL}`;
const failure = (message, code = 'VIDEO_CONVERSION_FAILED') => new VideoError(message, 502, code);

function queueUrl(value, id, status = false) {
  const expected = `https://queue.fal.run/fal-ai/chatterbox/requests/${id}${status ? '/status' : ''}`;
  if (value !== expected) throw failure('换声服务返回的任务地址无效，未重复提交。', 'VIDEO_CONVERSION_UNCERTAIN');
  return expected;
}

async function audioDuration(path) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe',
    '-show_entries', 'format=duration:stream=codec_type,duration', '-of', 'json', path], { timeout: 20_000 });
  const data = JSON.parse(stdout), audio = data.streams?.find(stream => stream.codec_type === 'audio');
  const duration = Number(audio?.duration || data.format?.duration);
  if (!audio || !Number.isFinite(duration) || duration <= 0) throw failure('换声结果没有可读取的音轨。');
  return duration;
}

export function createVoiceConversionService(env = {}, { fetchImpl = fetch, download = downloadVideo,
  upload = createProviderStorage(env, fetchImpl).upload } = {}) {
  const key = env.FAL_KEY || env.FAL_API_KEY || env.VIDEO_FAL_KEY;
  async function call(url, body) {
    try {
      const response = await fetchImpl(url, { method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) });
      if (!response.ok) {
        if ([400, 401, 402, 403, 422].includes(response.status)) throw failure('换声请求被拒绝，请检查账户权限、余额或参考音频。');
        throw new Error();
      }
      return await response.json();
    } catch (cause) {
      if (cause instanceof VideoError || cause.providerNotDispatched) throw cause;
      throw failure(body ? '换声提交尚未确认，未重复提交，请核对原任务。' : '换声服务暂时不可用，正在查询原任务。',
        body ? 'VIDEO_CONVERSION_UNCERTAIN' : 'VIDEO_CONVERSION_PENDING');
    }
  }
  async function advance(task, folder, save) {
    if (!key) throw failure('音色转换尚未配置，请配置 fal 密钥。', 'VIDEO_VOICE_NOT_CONFIGURED');
    if (!task.video?.audio || !task.voice) throw failure('音色转换需要包含人声的原视频和目标声音参考。');
    const state = task.voiceConversion ||= { engine: 'chatterbox', ready: false };
    if (state.ready) return;
    if (state.failed) throw failure('原换声任务失败，请检查素材后新建复刻；未重复提交。');
    if (state.submitting && !state.id) throw failure('换声提交尚未确认，未重复提交，请核对原任务。', 'VIDEO_CONVERSION_UNCERTAIN');
    const source = join(folder, 'conversion-source.wav'), output = join(folder, 'converted-voice.wav');
    if (!state.sourceUrl) {
      await run('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-i', join(folder, 'source.mp4'),
        '-map', '0:a:0', '-vn', '-af', 'aresample=24000:first_pts=0', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', source], { timeout: 60_000 });
      state.sourceDuration = await audioDuration(source);
      state.sourceUrl = await upload(source, 'audio/wav'); await save();
    }
    if (!state.targetUrl) { state.targetUrl = await upload(join(folder, 'reference.wav'), 'audio/wav'); await save(); }
    if (!state.id) {
      state.submitting = true; await save();
      let data;
      try { data = await call(endpoint, { source_audio_url: state.sourceUrl, target_voice_audio_url: state.targetUrl }); }
      catch (cause) {
        if (cause.providerNotDispatched) delete state.submitting;
        else if (cause.code === 'VIDEO_CONVERSION_FAILED') { state.failed = true; delete state.submitting; }
        await save(); throw cause;
      }
      if (!/^[a-zA-Z0-9-]{1,100}$/.test(data.request_id || '')) throw failure('换声未返回任务编号，未重复提交。', 'VIDEO_CONVERSION_UNCERTAIN');
      state.statusUrl = queueUrl(data.status_url, data.request_id, true);
      state.resultUrl = queueUrl(data.response_url, data.request_id);
      state.id = data.request_id; delete state.submitting; await save(); return;
    }
    if (!state.audioUrl) {
      const status = await call(queueUrl(state.statusUrl, state.id, true));
      if (status.error || ['FAILED', 'CANCELLED'].includes(status.status)) { state.failed = true; await save(); throw failure('换声生成失败，未重复提交。'); }
      if (status.status !== 'COMPLETED') return;
      const result = await call(queueUrl(state.resultUrl, state.id));
      try {
        const url = new URL(result.audio?.url);
        if (url.protocol !== 'https:' || url.username || url.password
          || !['fal.media', 'storage.googleapis.com'].some(host => url.hostname === host || url.hostname.endsWith('.' + host))) throw new Error();
        state.audioUrl = url.href;
      } catch { state.failed = true; await save(); throw failure('换声服务未返回有效音频。'); }
      await save();
    }
    try { await download(state.audioUrl, output, { maxBytes: 32 * 1024 * 1024 }); }
    catch { throw failure('正在重新保存已有换声结果，不会重新生成。', 'VIDEO_CONVERSION_PENDING'); }
    state.duration = await audioDuration(output);
    state.ready = true; await save();
  }
  return { enabled: Boolean(key), advance, mux: muxNarration };
}
