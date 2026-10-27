import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { VideoError } from './provider.mjs';
import { downloadVideo } from './media.mjs';
import { createProviderStorage } from './provider-storage.mjs';
import { muxNarration } from './narration.mjs';

const run = promisify(execFile);
export const VOICE_CONVERSION_MODEL = 'fal-ai/chatterbox/speech-to-speech';
export const AUDIO_SEPARATION_MODEL = 'fal-ai/sam-audio/separate';
const failure = (message, code = 'VIDEO_CONVERSION_FAILED') => new VideoError(message, 502, code);

function queueUrl(value, id, status = false, model = VOICE_CONVERSION_MODEL) {
  const expected = `https://queue.fal.run/${model.split('/').slice(0, 2).join('/')}/requests/${id}${status ? '/status' : ''}`;
  if (value !== expected) throw failure('换声服务返回的任务地址无效，未重复提交。', 'VIDEO_CONVERSION_UNCERTAIN');
  return expected;
}

function audioUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password
    || !['fal.media', 'storage.googleapis.com'].some(host => url.hostname === host || url.hostname.endsWith('.' + host))) throw new Error('Invalid audio URL');
  return url.href;
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
  async function call(url, body, label = '换声') {
    try {
      const response = await fetchImpl(url, { method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) });
      if (!response.ok) {
        if ([400, 401, 402, 403, 422].includes(response.status)) throw failure(`${label}请求被拒绝，请检查账户权限、余额或参考音频。`);
        throw new Error();
      }
      return await response.json();
    } catch (cause) {
      if (cause instanceof VideoError || cause.providerNotDispatched) throw cause;
      throw failure(body ? `${label}提交尚未确认，未重复提交，请核对原任务。` : `${label}服务暂时不可用，正在查询原任务。`,
        body ? 'VIDEO_CONVERSION_UNCERTAIN' : 'VIDEO_CONVERSION_PENDING');
    }
  }
  async function submit(state, model, body, save, label = '换声') {
    state.submitting = true; await save();
    let data;
    try { data = await call(`https://queue.fal.run/${model}`, body, label); }
    catch (cause) {
      if (cause.providerNotDispatched) delete state.submitting;
      else if (cause.code === 'VIDEO_CONVERSION_FAILED') { state.failed = true; delete state.submitting; }
      await save(); throw cause;
    }
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(data.request_id || '')) throw failure(`${label}未返回任务编号，未重复提交。`, 'VIDEO_CONVERSION_UNCERTAIN');
    state.statusUrl = queueUrl(data.status_url, data.request_id, true, model);
    state.resultUrl = queueUrl(data.response_url, data.request_id, false, model);
    state.id = data.request_id; delete state.submitting; await save();
  }
  async function separate(task, folder, save) {
    const state = task.voiceConversion.separation ||= { ready: false };
    if (state.ready) return;
    if (state.failed) throw failure('原人声分离任务失败，请检查素材后新建复刻；未重复提交。');
    if (state.submitting && !state.id) throw failure('人声分离提交尚未确认，未重复提交，请核对原任务。', 'VIDEO_CONVERSION_UNCERTAIN');
    if (!state.sourceUrl) {
      const source = join(folder, 'separation-source.wav');
      // Preserve the full background bandwidth, stereo channels and leading silence.
      await run('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-i', join(folder, 'source.mp4'),
        '-map', '0:a:0', '-vn', '-af', 'aresample=48000:first_pts=0,apad', '-t', String(task.video.duration),
        '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', source], { timeout: 60_000 });
      state.sourceUrl = await upload(source, 'audio/wav'); await save();
    }
    if (!state.id) {
      await submit(state, AUDIO_SEPARATION_MODEL, { audio_url: state.sourceUrl, prompt: 'Human speech',
        output_format: 'wav', reranking_candidates: 1 }, save, '人声分离');
      return;
    }
    if (!state.vocalsUrl || !state.backgroundUrl) {
      try {
        const status = await call(queueUrl(state.statusUrl, state.id, true, AUDIO_SEPARATION_MODEL), undefined, '人声分离');
        if (status.error || ['FAILED', 'CANCELLED'].includes(status.status)) throw failure('人声分离失败，未继续替换声音。');
        if (status.status !== 'COMPLETED') return;
        const result = await call(queueUrl(state.resultUrl, state.id, false, AUDIO_SEPARATION_MODEL), undefined, '人声分离');
        try {
          const vocals = audioUrl(result.target?.url), background = audioUrl(result.residual?.url);
          state.vocalsUrl = vocals; state.backgroundUrl = background;
        } catch { throw failure('人声分离未返回有效的人声与背景声音轨，未继续替换声音。'); }
      } catch (cause) {
        if (cause.code === 'VIDEO_CONVERSION_FAILED') { state.failed = true; await save(); }
        throw cause;
      }
      await save();
    }
    for (const [kind, url] of [['vocals', state.vocalsUrl], ['background', state.backgroundUrl]]) {
      const output = join(folder, `separated-${kind}.wav`);
      try {
        await download(url, output, { maxBytes: 64 * 1024 * 1024 });
        await audioDuration(output);
      } catch { throw failure('正在重新保存已分离的人声与背景声，不会重新生成。', 'VIDEO_CONVERSION_PENDING'); }
    }
    state.ready = true; await save();
  }
  async function advance(task, folder, save) {
    if (!key) throw failure('音色转换尚未配置，请配置 fal 密钥。', 'VIDEO_VOICE_NOT_CONFIGURED');
    if (!task.video?.audio || !task.voice) throw failure('音色转换需要包含人声的原视频和目标声音参考。');
    // Existing receipts retain their original source and never trigger another paid conversion.
    const state = task.voiceConversion ||= { engine: 'chatterbox', ready: false,
      preserveBackground: task.mode === 'deep' && task.replacements?.voice === true };
    if (state.ready) return;
    if (state.failed) throw failure('原换声任务失败，请检查素材后新建复刻；未重复提交。');
    if (state.submitting && !state.id) throw failure('换声提交尚未确认，未重复提交，请核对原任务。', 'VIDEO_CONVERSION_UNCERTAIN');
    if (state.preserveBackground) {
      await separate(task, folder, save);
      if (!state.separation.ready) return;
    }
    const source = join(folder, 'conversion-source.wav'), output = join(folder, 'converted-voice.wav');
    if (!state.sourceUrl) {
      await run('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-i', join(folder, state.preserveBackground ? 'separated-vocals.wav' : 'source.mp4'),
        '-map', '0:a:0', '-vn', '-af', 'aresample=24000:first_pts=0', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', source], { timeout: 60_000 });
      state.sourceDuration = await audioDuration(source);
      state.sourceUrl = await upload(source, 'audio/wav'); await save();
    }
    if (!state.targetUrl) { state.targetUrl = await upload(join(folder, 'reference.wav'), 'audio/wav'); await save(); }
    if (!state.id) {
      await submit(state, VOICE_CONVERSION_MODEL, { source_audio_url: state.sourceUrl, target_voice_audio_url: state.targetUrl }, save);
      return;
    }
    if (!state.audioUrl) {
      const status = await call(queueUrl(state.statusUrl, state.id, true));
      if (status.error || ['FAILED', 'CANCELLED'].includes(status.status)) { state.failed = true; await save(); throw failure('换声生成失败，未重复提交。'); }
      if (status.status !== 'COMPLETED') return;
      const result = await call(queueUrl(state.resultUrl, state.id));
      try { state.audioUrl = audioUrl(result.audio?.url); }
      catch { state.failed = true; await save(); throw failure('换声服务未返回有效音频。'); }
      await save();
    }
    try { await download(state.audioUrl, output, { maxBytes: 32 * 1024 * 1024 }); }
    catch { throw failure('正在重新保存已有换声结果，不会重新生成。', 'VIDEO_CONVERSION_PENDING'); }
    state.duration = await audioDuration(output);
    state.ready = true; await save();
  }
  return { enabled: Boolean(key), advance, mux: muxConvertedVoice };
}

// Duplicate mono speech at unity gain; keep stereo stems in their existing channels.
const VOICE_STEREO = 'aresample=48000,pan=stereo|FL=FL+FC|FR=FR+FC';

async function voiceLoudness(path, duration) {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostats', '-nostdin', '-i', path, '-map', '0:a:0', '-vn',
    '-af', `${VOICE_STEREO},apad,atrim=duration=${duration},loudnorm=print_format=json`, '-f', 'null', '-'],
  { timeout: 120_000, maxBuffer: 1024 * 1024 });
  return Number(JSON.parse(stderr.slice(stderr.lastIndexOf('{'), stderr.lastIndexOf('}') + 1)).input_i);
}

async function muxConvertedVoice(video, audio, output, duration, background, originalVoice) {
  if (!background) return muxNarration(video, audio, output, duration);
  const [originalLoudness, convertedLoudness] = await Promise.all([
    voiceLoudness(originalVoice, duration), voiceLoudness(audio, duration),
  ]);
  // Silence and clips too short to measure must not produce an infinite gain.
  const gain = Number.isFinite(originalLoudness) && Number.isFinite(convertedLoudness)
    ? originalLoudness - convertedLoudness : 0;
  await run('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-i', video, '-i', audio, '-i', background,
    '-filter_complex', `[1:a:0]${VOICE_STEREO},volume=${gain}dB,apad[voice];`
      + '[2:a:0]aresample=48000,aformat=channel_layouts=stereo,apad[background];'
      + '[voice][background]amix=inputs=2:normalize=0,alimiter=limit=0.98:level=0:latency=1[mixed]',
    '-map', '0:v:0', '-map', '[mixed]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-t', String(duration), '-movflags', '+faststart', '-f', 'mp4', output], { timeout: 120_000 });
}
