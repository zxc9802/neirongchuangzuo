import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { VideoError } from './provider.mjs';
import { downloadVideo } from './media.mjs';
import { detectSpeech, speechConfig } from './speech.mjs';
import { createProviderStorage } from './provider-storage.mjs';
import { groupNarrationSegments, prepareEmotion, narrationWait, narrationDiagnostic, NARRATION_ATTEMPTS } from './narration-recovery.mjs';

const run = promisify(execFile);
const SAMPLE_RATE = 48000;
const FAL_ENDPOINT = 'https://queue.fal.run/fal-ai/index-tts-2/text-to-speech';
const failure = (message, code = 'VIDEO_NARRATION_FAILED') => new VideoError(message, 502, code);

function falQueueUrl(value, code) {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://queue.fal.run' || url.username || url.password || !/^\/fal-ai\/index-tts-2(?:\/|$)/.test(url.pathname)) throw new Error();
    return url.href;
  } catch { throw failure('配音服务返回的任务地址无效。', code); }
}

export function createNarrationService(env = {}, { fetchImpl = fetch, download = downloadVideo,
  detect = path => detectSpeech(path, speechConfig(env)), upload = createProviderStorage(env, fetchImpl).upload,
  recoverReceipt = async () => true, now = Date.now } = {}) {
  const key = env.INDEXTTS_302_API_KEY || env.INDEXTTS_API_KEY;
  const falKey = env.FAL_KEY || env.FAL_API_KEY || env.VIDEO_FAL_KEY;
  const base = env.INDEXTTS_BASE_URL || env.INDEXTTS_API_BASE_URL || 'https://api.302.ai';
  const endpoint = new URL('/302/index_tts2/task', base);
  async function call(id, body) {
    try {
      const url = new URL(endpoint); if (id) url.searchParams.set('task_id', id);
      const response = await fetchImpl(url, { method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) });
      if (!response.ok) {
        if ([400, 401, 402, 403, 422].includes(response.status)) throw failure('IndexTTS2 拒绝了配音请求，请检查配音权限、余额或参考音频。');
        throw new Error();
      }
      return await response.json();
    } catch (cause) {
      if (cause instanceof VideoError) throw cause;
      throw failure(body ? '配音提交未获得确认，未重复扣费提交，请核对原配音任务。' : '配音服务暂时不可用，正在查询原配音任务。',
        body ? 'VIDEO_NARRATION_UNCERTAIN' : 'VIDEO_NARRATION_PENDING');
    }
  }
  async function falCall(url, body) {
    const target = falQueueUrl(url);
    if (!falKey) throw failure('fal 配音服务尚未配置，请检查 fal 密钥。');
    try {
      const response = await fetchImpl(target, { method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { Authorization: `Key ${falKey}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) });
      if (!response.ok) {
        if ([400, 401, 402, 403, 422].includes(response.status)) {
          const data = await response.json().catch(() => ({}));
          const reason = Array.isArray(data.detail) ? data.detail[0]?.type : undefined;
          throw Object.assign(failure('fal IndexTTS2 请求失败，请检查配音权限、余额或参考音频。'),
            { httpStatus: response.status, reason: /^[a-z_]{1,80}$/.test(reason || '') ? reason : undefined, confirmedFailure: true });
        }
        throw new Error();
      }
      return await response.json();
    } catch (cause) {
      if (cause.providerNotDispatched) throw Object.assign(failure(cause.message), { providerNotDispatched: true, recoveryAction: 'account' });
      if (cause instanceof VideoError) throw cause;
      throw failure(body ? '配音提交未获得确认，未重复扣费提交，请核对原配音任务。' : '配音服务暂时不可用，正在查询原配音任务。',
        body ? 'VIDEO_NARRATION_UNCERTAIN' : 'VIDEO_NARRATION_PENDING');
    }
  }
  async function prepare(task, folder) {
    await mkdir(join(folder, 'narration'), { recursive: true });
    const segments = groupNarrationSegments(task.speech.segments);
    for (const [index, segment] of segments.entries()) {
      await prepareEmotion(task, folder, segment, index, detect);
    }
    return { engine: 'indextts2', provider: 'fal', recoveryVersion: 1, emotionSource: 'original-video', ready: false, segments };
  }
  async function recoverSubmission(segment, save) {
    if (!segment.submission || !segment.submittedAt) throw narrationWait('进度已保存，等待核对生成记录。', 'confirm');
    const url = new URL('https://api.fal.ai/v1/models/requests/by-endpoint');
    url.searchParams.set('endpoint_id', 'fal-ai/index-tts-2/text-to-speech');
    url.searchParams.set('start', new Date(segment.submittedAt - 5000).toISOString());
    url.searchParams.set('end', new Date(segment.submittedAt + 120_000).toISOString());
    url.searchParams.set('expand', 'payloads'); url.searchParams.set('limit', '50');
    try {
      const response = await fetchImpl(url, { headers: { Authorization: `Key ${falKey}` }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error();
      const data = await response.json();
      const matches = (data.items || []).filter(item => item.endpoint_id === 'fal-ai/index-tts-2/text-to-speech'
        && Object.entries(segment.submission).every(([name, value]) => item.json_input?.[name] === value));
      // A partial listing or multiple identical submissions cannot identify the paid call safely.
      if (data.has_more || data.next_cursor || matches.length !== 1 || !/^[a-f0-9-]{36}$/.test(matches[0].request_id || '')) throw new Error();
      if (!await recoverReceipt('fal-ai/index-tts-2/text-to-speech', segment.submission, matches[0].request_id)) throw new Error();
      segment.id = matches[0].request_id;
      const base = `https://queue.fal.run/fal-ai/index-tts-2/requests/${segment.id}`;
      segment.falQueue = { status: `${base}/status`, result: base };
      segment.status = 'pending'; await save();
    } catch {
      throw failure('正在确认原配音进度，已完成内容已保留。', 'VIDEO_NARRATION_PENDING');
    }
  }
  async function advance(task, folder, _sourceUrl, save) {
    if (task.narration.ready) return;
    const segments = task.narration.segments;
    // Narration saved before the migration belongs to 302; never move a paid job to fal.
    const usesFal = task.narration.provider === 'fal';
    const recovering = usesFal && task.narration.recoveryVersion === 1;
    if (recovering) {
      for (const segment of segments.filter(segment => segment.status === 'submitting')) await recoverSubmission(segment, save);
      const segment = segments.find(segment => segment.status === 'waiting');
      if (segment) throw narrationWait('进度已保存，等待确认后继续。', segment.recoveryAction || 'resume');
    }
    // Three in-flight segments, while Seedance runs independently.
    const pending = segments.filter(segment => segment.status === 'pending');
    const selected = [...pending, ...segments.filter(segment => !segment.status && (!segment.retryAt || segment.retryAt <= now())).slice(0, Math.max(0, 3 - pending.length))];
    async function referenceUrl(kind) {
      task.narration.references ||= {};
      if (!task.narration.references[kind]) {
        const input = kind === 'voice' ? join(folder, 'reference.wav') : join(folder, 'narration', `${kind}.wav`);
        try { task.narration.references[kind] = await upload(input, 'audio/wav'); }
        catch (cause) {
          if (!recovering) throw cause;
          if (cause.code === 'VIDEO_NARRATION_FAILED') throw narrationWait('等待账户或素材存储恢复，进度已保存。', 'account');
          throw failure('正在重新传送参考声音，进度已保存。', 'VIDEO_NARRATION_PENDING');
        }
        await save();
      }
      return task.narration.references[kind];
    }
    const speaker = selected.some(segment => !segment.id) ? await referenceUrl('voice') : null;
    const replies = await Promise.allSettled(selected.map(async segment => {
      const index = segments.indexOf(segment);
      try {
      if (!segment.id) {
        if (segment.status === 'submitting') throw failure('配音提交确认中断，未自动重复生成，请核对原配音任务。', 'VIDEO_NARRATION_UNCERTAIN');
        if (recovering && (segment.attempts || 0) >= NARRATION_ATTEMPTS) throw narrationWait('本段处理次数已达上限，进度已保存。', 'limit');
        if (recovering && segment.repairReference) {
          await prepareEmotion(task, folder, segment, index, detect, segment.attempts || 0);
          delete task.narration.references?.[`emotion-${index}`];
          delete segment.repairReference; await save();
        }
        const emotion = task.video.audio ? await referenceUrl(`emotion-${index}`) : speaker;
        const payload = { prompt: segment.text, audio_url: speaker,
          emotional_audio_url: emotion, strength: 0.8, should_use_prompt_for_emotion: false };
        segment.status = 'submitting';
        if (recovering) { segment.attempts = (segment.attempts || 0) + 1; segment.submittedAt = now(); segment.submission = payload; }
        await save();
        if (usesFal) {
          const data = await falCall(FAL_ENDPOINT, payload);
          if (!data.request_id || !data.status_url || !data.response_url) throw failure('fal IndexTTS2 未返回完整任务编号，未自动重新提交。', 'VIDEO_NARRATION_UNCERTAIN');
          segment.id = String(data.request_id);
          segment.falQueue = { status: falQueueUrl(data.status_url, 'VIDEO_NARRATION_UNCERTAIN'), result: falQueueUrl(data.response_url, 'VIDEO_NARRATION_UNCERTAIN') };
          segment.status = 'pending'; await save(); return;
        }
        const data = await call(null, { text: segment.text, speaker_audio_url: speaker,
          emotion_audio_url: emotion, emotion_alpha: 0.8 });
        if (!data.task_id) throw failure('IndexTTS2 未返回任务编号，未自动重新提交。', 'VIDEO_NARRATION_UNCERTAIN');
        segment.id = String(data.task_id); segment.status = 'pending'; await save(); return;
      }
      let data;
      if (usesFal) {
        const status = await falCall(segment.falQueue?.status);
        if (status.error || ['FAILED', 'CANCELLED'].includes(status.status)) throw Object.assign(failure('fal IndexTTS2 未完成配音。'), { confirmedFailure: true });
        if (status.status !== 'COMPLETED') return;
        const result = await falCall(segment.falQueue.result);
        if (result.error) throw Object.assign(failure('fal IndexTTS2 未完成配音。'), { confirmedFailure: true });
        data = { state: 'SUCCESS', audio_url: typeof result.audio === 'string' ? result.audio : result.audio?.url };
      } else data = await call(segment.id);
      if (['FAILURE', 'FAILED', 'ERROR', 'REVOKED'].includes(data.state)) {
        const detail = String(data.error?.detail || '');
        const unavailableReference = /download/i.test(detail) && /timed out|timeout|connection reset|connection aborted|name resolution|HTTP 5\d\d|SSLError|SSLEOFError|UNEXPECTED_EOF/i.test(detail);
        if (unavailableReference && (segment.downloadRetries || 0) < 5) {
          segment.downloadRetries = (segment.downloadRetries || 0) + 1;
          segment.previousIds = [...(segment.previousIds || []), segment.id];
          delete segment.id; delete segment.status; await save(); return;
        }
        throw failure(unavailableReference ? '配音服务下载参考音频已重试 5 次仍未成功，请稍后重试。' : 'IndexTTS2 未完成配音，请检查参考声音后重新生成。');
      }
      if (data.state !== 'SUCCESS') return;
      let url;
      try {
        url = new URL(data.audio_url);
        const hosts = (usesFal ? 'fal.media,storage.googleapis.com' : env.INDEXTTS_DOWNLOAD_HOSTS || '302.ai,302ai.cn').split(',').map(host => host.trim());
        if (url.protocol !== 'https:' || url.username || url.password || !hosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) throw new Error();
      } catch { throw failure('配音服务返回的音频地址无效。'); }
      const audio = join(folder, 'narration', `${index}.wav`);
      try { await download(url.href, audio, { maxBytes: 32 * 1024 * 1024 }); }
      catch { throw failure('配音已生成，正在重试下载原配音，不重新提交。', 'VIDEO_NARRATION_PENDING'); }
      const intervals = await detect(audio).catch(() => { throw Object.assign(failure('配音文件无法读取，请检查配音服务输出。'), { confirmedFailure: true }); });
      if (!intervals.length) throw Object.assign(failure('配音结果没有可用人声，未使用原视频声音替代。'), { confirmedFailure: true });
      segment.speechStart = intervals[0].start; segment.speechEnd = intervals.at(-1).end;
      segment.status = 'ready'; await save();
      } catch (cause) {
        if (!recovering) throw cause;
        segment.diagnostic = narrationDiagnostic(cause, now());
        if (cause.providerNotDispatched) {
          segment.attempts = Math.max(0, (segment.attempts || 0) - 1);
          segment.status = 'waiting'; segment.recoveryAction = 'account'; await save();
          throw narrationWait('等待账户或额度恢复，进度已保存。', 'account');
        }
        if (/content|moderation|safety/.test(cause.reason || '')) {
          segment.status = 'waiting'; segment.recoveryAction = 'input'; await save();
          throw narrationWait('请调整原素材后继续，当前进度已保存。', 'input');
        }
        if (cause.confirmedFailure && ![401, 402, 403].includes(cause.httpStatus)) {
          segment.previousJobs ||= [];
          segment.previousJobs.push({ id: segment.id, falQueue: segment.falQueue, diagnostic: segment.diagnostic });
          delete segment.id; delete segment.falQueue;
          if ((segment.attempts || 0) < NARRATION_ATTEMPTS) {
            delete segment.status;
            segment.repairReference = true;
            segment.retryAt = now() + (segment.attempts === 1 ? 10_000 : 30_000);
            await save(); return;
          }
          segment.status = 'waiting'; segment.recoveryAction = 'limit'; await save();
          throw narrationWait('本段处理次数已达上限，进度已保存。', 'limit');
        }
        if (cause.code === 'VIDEO_NARRATION_PENDING') { await save(); throw cause; }
        if (cause.code === 'VIDEO_NARRATION_UNCERTAIN') {
          await save();
          throw failure('正在确认原配音进度，已完成内容已保留。', 'VIDEO_NARRATION_PENDING');
        }
        if (segment.status !== 'submitting') segment.status = 'waiting';
        segment.recoveryAction = cause.recoveryAction || ([401, 402, 403].includes(cause.httpStatus) ? 'account' : 'confirm');
        if (cause.confirmedFailure) segment.status = 'waiting';
        await save();
        throw narrationWait(segment.recoveryAction === 'account' ? '等待账户或额度恢复，进度已保存。' : '进度已保存，等待确认后继续。', segment.recoveryAction);
      }
    }));
    const rejected = replies.find(reply => reply.status === 'rejected');
    if (rejected) throw rejected.reason;
    if (recovering && segments.some(segment => segment.retryAt > now())) {
      throw failure('正在重新处理配音片段，已完成内容已保留。', 'VIDEO_NARRATION_PENDING');
    }
    if (segments.some(segment => segment.status === 'submitting')) throw failure('配音提交确认中断，未自动重复生成。', 'VIDEO_NARRATION_UNCERTAIN');
    if (!segments.every(segment => segment.status === 'ready') || !task.actualDuration) return;
    await assembleNarration(segments, join(folder, 'narration'), join(folder, 'narration.wav'), task.actualDuration);
    task.narration.ready = true; await save();
  }
  return { enabled: Boolean(falKey), prepare, advance, mux: muxNarration };
}

export async function assembleNarration(segments, folder, output, duration) {
  const track = Buffer.alloc(Math.ceil(duration * SAMPLE_RATE) * 4);
  // Fit every spoken segment into a shorter generated video without dropping
  // the last words or turning the removed output-duration gate into a TTS error.
  const scale = duration / Math.max(duration, ...segments.map(segment => segment.end));
  for (const [index, segment] of segments.entries()) {
    const start = segment.start * scale, end = Math.min(duration, segment.end * scale);
    const target = end - start;
    let rate = (segment.speechEnd - segment.speechStart) / target;
    if (!(target > 0 && rate > 0 && start >= 0)) throw failure('配音时间范围无效。');
    const tempo = [];
    while (rate > 2) { tempo.push('atempo=2'); rate /= 2; }
    while (rate < 0.5) { tempo.push('atempo=0.5'); rate /= 0.5; }
    tempo.push(`atempo=${rate}`);
    const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', join(folder, `${index}.wav`), '-vn',
      '-af', `atrim=start=${segment.speechStart}:end=${segment.speechEnd},asetpts=PTS-STARTPTS,${tempo.join(',')},apad,atrim=duration=${target}`,
      '-ar', String(SAMPLE_RATE), '-ac', '1', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
    stdout.copy(track, Math.round(start * SAMPLE_RATE) * 4, 0, Math.round(target * SAMPLE_RATE) * 4);
  }
  const pcm = output + '.pcm', temporary = output + '.tmp.wav';
  try {
    await writeFile(pcm, track, { mode: 0o600 });
    await run('ffmpeg', ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', pcm,
      '-c:a', 'pcm_s16le', temporary]);
    await rename(temporary, output);
  } finally { await rm(pcm, { force: true }); await rm(temporary, { force: true }); }
}

export async function muxNarration(video, audio, output, duration) {
  // Always map the IndexTTS track, including when the lip-sync provider returns its own audio.
  await run('ffmpeg', ['-v', 'error', '-y', '-i', video, '-i', audio, '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-af', 'apad', '-c:a', 'aac', '-b:a', '192k', '-t', String(duration), '-movflags', '+faststart', '-f', 'mp4', output]);
}
