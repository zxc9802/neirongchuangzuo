import { createHash } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { VideoError } from './provider.mjs';
import { createProviderStorage } from './provider-storage.mjs';

export const TRANSCRIPTION_MODEL = 'fal-ai/elevenlabs/speech-to-text/scribe-v2';
const ORIGIN = 'https://queue.fal.run';
const failure = (message, code = 'VIDEO_TRANSCRIPTION_FAILED') => new VideoError(message, 502, code);
const pending = () => failure('原声文稿正在识别，正在查询原任务。', 'VIDEO_TRANSCRIPTION_PENDING');
const uncertain = () => failure('语音识别提交未获得确认，未自动重复提交，请核对 fal 任务记录。', 'VIDEO_TRANSCRIPTION_UNCERTAIN');

function queueUrl(value, id, status = false) {
  try {
    const url = new URL(value);
    const suffix = `/requests/${id}${status ? '/status' : ''}`;
    if (url.origin !== ORIGIN || url.username || url.password || url.search || url.hash
      || ![`/fal-ai/elevenlabs${suffix}`, `/${TRANSCRIPTION_MODEL}${suffix}`].includes(url.pathname)) throw new Error();
    return url.href;
  } catch { throw failure('语音识别服务返回的任务地址无效。'); }
}

export function createTranscriptionService(env = {}, fetchImpl = fetch) {
  const key = env.FAL_KEY || env.FAL_API_KEY || env.VIDEO_FAL_KEY;
  const storage = createProviderStorage(env, fetchImpl);
  return { enabled: Boolean(key), async transcribe(audio, checkpoint) {
    if (!key) throw new VideoError('语音识别尚未配置，请配置 fal 密钥 FAL_KEY、FAL_API_KEY 或 VIDEO_FAL_KEY。', 503, 'VIDEO_SPEECH_NOT_CONFIGURED');
    const digest = createHash('sha256').update(await readFile(audio)).digest('hex');
    let job;
    try { job = JSON.parse(await readFile(checkpoint, 'utf8')); }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    if (job?.digest !== digest) job = { digest };
    const save = async () => {
      await writeFile(checkpoint + '.tmp', JSON.stringify(job), { mode: 0o600 });
      await rename(checkpoint + '.tmp', checkpoint);
    };
    if (job.state === 'completed') return job.result;
    if (job.state === 'failed') throw failure(job.error);
    if (job.state === 'submitting') throw uncertain();
    if (!job.id) {
      let audioUrl;
      try { audioUrl = await storage.upload(audio, 'audio/wav'); }
      catch (cause) {
        if (cause.code === 'VIDEO_NARRATION_PENDING') throw pending();
        throw cause;
      }
      job.state = 'submitting'; await save();
      let response;
      try {
        response = await fetchImpl(`${ORIGIN}/${TRANSCRIPTION_MODEL}`, {
          method: 'POST', redirect: 'error',
          headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ audio_url: audioUrl, tag_audio_events: false, diarize: false }),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (cause) {
        if (cause.providerNotDispatched) { delete job.state; await save(); throw cause; }
        throw uncertain();
      }
      if (!response.ok) {
        if ([400, 401, 402, 403, 404, 422].includes(response.status)) {
          job.state = 'failed';
          job.error = `语音识别请求被拒绝，请检查 fal 密钥、权限、余额或音频（HTTP ${response.status}）。`;
          await save(); throw failure(job.error);
        }
        throw uncertain();
      }
      let data;
      try { data = await response.json(); } catch { throw uncertain(); }
      if (typeof data.request_id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(data.request_id)) throw uncertain();
      job.id = data.request_id;
      job.statusUrl = queueUrl(data.status_url, job.id, true);
      job.resultUrl = queueUrl(data.response_url, job.id);
      job.state = 'pending'; await save();
    }
    async function query(url) {
      let response;
      try {
        response = await fetchImpl(url, { redirect: 'error', headers: { Authorization: `Key ${key}` },
          signal: AbortSignal.timeout(30_000) });
      } catch { throw pending(); }
      if (!response.ok) {
        if ([400, 401, 402, 403, 404, 422].includes(response.status)) {
          job.state = 'failed'; job.error = `语音识别任务查询被拒绝，请检查 fal 权限或任务记录（HTTP ${response.status}）。`;
          await save(); throw failure(job.error);
        }
        throw pending();
      }
      try { return await response.json(); } catch { throw pending(); }
    }
    const status = await query(queueUrl(job.statusUrl, job.id, true));
    if (status.error || ['FAILED', 'CANCELLED'].includes(status.status)) {
      job.state = 'failed'; job.error = '原声识别任务失败，请核对 fal 任务记录后重试。';
      await save(); throw failure(job.error);
    }
    if (status.status !== 'COMPLETED') throw pending();
    const result = await query(queueUrl(job.resultUrl, job.id));
    if (result.error || typeof result.text !== 'string' || !Array.isArray(result.words)) {
      job.state = 'failed'; job.error = '语音识别未返回有效文稿和词级时间戳。';
      await save(); throw failure(job.error);
    }
    job.state = 'completed'; job.result = result; await save();
    return result;
  } };
}
