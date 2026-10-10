import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { VideoError } from './provider.mjs';
import { downloadVideo } from './media.mjs';
import { detectSpeech, speechConfig } from './speech.mjs';

const run = promisify(execFile);
const SAMPLE_RATE = 48000;
const failure = (message, code = 'VIDEO_NARRATION_FAILED') => new VideoError(message, 502, code);

export function createNarrationService(env = {}, { fetchImpl = fetch, download = downloadVideo,
  detect = path => detectSpeech(path, speechConfig(env)) } = {}) {
  const key = env.INDEXTTS_302_API_KEY || env.INDEXTTS_API_KEY;
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
  async function prepare(task, folder) {
    await mkdir(join(folder, 'narration'), { recursive: true });
    const segments = task.speech.segments.map(segment => ({ start: segment.start, end: segment.end, text: segment.text }));
    for (const [index, segment] of segments.entries()) {
      if (task.video.audio) await run('ffmpeg', ['-v', 'error', '-y', '-i', join(folder, 'source.mp4'),
        '-ss', String(segment.start), '-t', String(segment.end - segment.start), '-vn', '-ac', '1', '-ar', '24000',
        '-c:a', 'pcm_s16le', join(folder, 'narration', `emotion-${index}.wav`)]);
    }
    return { engine: 'indextts2', emotionSource: task.video.audio ? 'original-video' : 'reference', ready: false, segments };
  }
  async function advance(task, folder, sourceUrl, save) {
    if (task.narration.ready) return;
    const segments = task.narration.segments;
    // Three in-flight segments, while Seedance runs independently.
    const pending = segments.filter(segment => segment.status === 'pending');
    const selected = [...pending, ...segments.filter(segment => !segment.status).slice(0, Math.max(0, 3 - pending.length))];
    const replies = await Promise.allSettled(selected.map(async segment => {
      const index = segments.indexOf(segment);
      if (!segment.id) {
        if (segment.status === 'submitting') throw failure('配音提交确认中断，未自动重复生成，请核对原配音任务。', 'VIDEO_NARRATION_UNCERTAIN');
        segment.status = 'submitting'; await save();
        const data = await call(null, { text: segment.text, speaker_audio_url: sourceUrl('voice'),
          emotion_audio_url: sourceUrl(task.video.audio ? `emotion-${index}` : 'voice'), emotion_alpha: 0.8 });
        if (!data.task_id) throw failure('IndexTTS2 未返回任务编号，未自动重新提交。', 'VIDEO_NARRATION_UNCERTAIN');
        segment.id = String(data.task_id); segment.status = 'pending'; await save(); return;
      }
      const data = await call(segment.id);
      if (['FAILURE', 'FAILED', 'ERROR', 'REVOKED'].includes(data.state)) {
        const detail = String(data.error?.detail || '');
        const unavailableReference = /download/i.test(detail) && /timed out|timeout|connection reset|connection aborted|name resolution|HTTP 5\d\d/i.test(detail);
        if (unavailableReference && (segment.downloadRetries || 0) < 5) {
          segment.downloadRetries = (segment.downloadRetries || 0) + 1;
          segment.previousIds = [...(segment.previousIds || []), segment.id];
          delete segment.id; delete segment.status; await save(); return;
        }
        throw failure(unavailableReference ? '配音参考下载已重试 5 次仍未成功，未使用原声替代。' : 'IndexTTS2 未完成配音，请检查参考声音后重新生成。');
      }
      if (data.state !== 'SUCCESS') return;
      let url;
      try {
        url = new URL(data.audio_url);
        const hosts = (env.INDEXTTS_DOWNLOAD_HOSTS || '302.ai,302ai.cn').split(',').map(host => host.trim());
        if (url.protocol !== 'https:' || url.username || url.password || !hosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) throw new Error();
      } catch { throw failure('配音服务返回的音频地址无效。'); }
      const audio = join(folder, 'narration', `${index}.wav`);
      try { await download(url.href, audio, { maxBytes: 32 * 1024 * 1024 }); }
      catch { throw failure('配音已生成，正在重试下载原配音，不重新提交。', 'VIDEO_NARRATION_PENDING'); }
      const intervals = await detect(audio).catch(() => { throw failure('配音文件无法读取，请检查配音服务输出。'); });
      if (!intervals.length) throw failure('配音结果没有可用人声，未使用原视频声音替代。');
      segment.speechStart = intervals[0].start; segment.speechEnd = intervals.at(-1).end;
      segment.status = 'ready'; await save();
    }));
    const rejected = replies.find(reply => reply.status === 'rejected');
    if (rejected) throw rejected.reason;
    if (segments.some(segment => segment.status === 'submitting')) throw failure('配音提交确认中断，未自动重复生成。', 'VIDEO_NARRATION_UNCERTAIN');
    if (!segments.every(segment => segment.status === 'ready') || !task.actualDuration) return;
    await assembleNarration(segments, join(folder, 'narration'), join(folder, 'narration.wav'), task.actualDuration);
    task.narration.ready = true; await save();
  }
  return { enabled: Boolean(key), prepare, advance, mux: muxNarration };
}

export async function assembleNarration(segments, folder, output, duration) {
  const track = Buffer.alloc(Math.ceil(duration * SAMPLE_RATE) * 4);
  for (const [index, segment] of segments.entries()) {
    const target = segment.end - segment.start;
    let rate = (segment.speechEnd - segment.speechStart) / target;
    if (!(target > 0 && rate > 0 && segment.start >= 0 && segment.end <= duration)) throw failure('配音时间范围无效。');
    const tempo = [];
    while (rate > 2) { tempo.push('atempo=2'); rate /= 2; }
    while (rate < 0.5) { tempo.push('atempo=0.5'); rate /= 0.5; }
    tempo.push(`atempo=${rate}`);
    const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', join(folder, `${index}.wav`), '-vn',
      '-af', `atrim=start=${segment.speechStart}:end=${segment.speechEnd},asetpts=PTS-STARTPTS,${tempo.join(',')},apad,atrim=duration=${target}`,
      '-ar', String(SAMPLE_RATE), '-ac', '1', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
    stdout.copy(track, Math.round(segment.start * SAMPLE_RATE) * 4, 0, Math.round(target * SAMPLE_RATE) * 4);
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
