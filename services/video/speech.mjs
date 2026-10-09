import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { VideoError } from './provider.mjs';

const run = promisify(execFile);
const worker = fileURLToPath(new URL('./speech_vad.py', import.meta.url));
export const VOICE_LIMIT = 15 * 1024 * 1024;
export const speechText = text => String(text || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, (character, index, normalized) => {
  // Ignore sentence punctuation without merging distinct prices or signed numbers.
  if (character === '.' && /\d/.test(normalized[index - 1] || '') && /\d/.test(normalized[index + 1] || '')) return character;
  if ((character === '+' || character === '-') && /\d/.test(normalized[index + 1] || '')) return character;
  return '';
});
const invalid = message => new VideoError(message, 422, 'VIDEO_SPEECH_INVALID');
export function speechConfig(env = {}) {
  const prefix = env.VIDEO_TRANSCRIPTION_API_KEY ? 'VIDEO_TRANSCRIPTION' : env.MOTION_API_KEY ? 'MOTION' : 'INDEXTTS';
  return { key: env[`${prefix}_API_KEY`] || env.INDEXTTS_302_API_KEY,
    base: env[`${prefix}_BASE_URL`] || env[`${prefix}_API_BASE_URL`] || 'https://api.302.ai',
    python: env.VIDEO_PYTHON_BIN || env.MIX_PYTHON_BIN || 'python3' };
}
export async function detectSpeech(path, config = speechConfig(process.env)) {
  const pcm = path + '.vad.pcm';
  try {
    await run('ffmpeg', ['-v', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-i', path,
      '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', pcm], { timeout: 30_000 });
    const { stdout } = await run(config.python, [worker, pcm], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout);
  } catch { throw invalid('无法识别人声，请使用清晰的单人口播素材，并检查语音检测服务配置。'); }
  finally { await rm(pcm, { force: true }); }
}
export async function normalizeVoice(input, output) {
  try {
    const header = (await readFile(input)).subarray(0, 12);
    const wav = ['RIFF', 'RF64'].includes(header.toString('ascii', 0, 4)) && header.toString('ascii', 8, 12) === 'WAVE';
    const mp3 = header.toString('ascii', 0, 3) === 'ID3' || header[0] === 0xff && (header[1] & 0xe0) === 0xe0 && (header[1] & 6) === 2;
    if (!wav && !mp3) throw new Error();
    // Force the advertised audio format so uploaded playlists cannot read local files.
    await run('ffmpeg', ['-v', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-f', wav ? 'wav' : 'mp3', '-i', input,
      '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', '-t', '15.1', output], { timeout: 30_000 });
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', output], { timeout: 10_000 });
    const duration = Number(JSON.parse(stdout).format?.duration);
    if (!Number.isFinite(duration) || duration < 2 || duration > 15) throw new Error();
    return { duration: Math.round(duration * 1000) / 1000, ready: true };
  } catch { throw new VideoError('声音参考需为可播放的 MP3 / WAV，时长 2–15 秒。', 400, 'VIDEO_VOICE_INVALID'); }
}
export function speechTimeline(data, intervals, duration) {
  if (!Number.isFinite(duration) || duration <= 0 || intervals.some((interval, index) =>
    !Number.isFinite(interval.start) || !Number.isFinite(interval.end) || interval.start < 0
    || interval.end <= interval.start || interval.end > duration + 0.1
    || index && interval.start < intervals[index - 1].end)) {
    throw invalid('人声检测区间无效，请重新检查素材。');
  }
  const words = [];
  let pending = '';
  let previous = 0;
  for (const word of data.words || []) {
    if (!speechText(word.word)) continue;
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < 0 || word.end < word.start
      || word.end > duration + 0.1 || word.start < previous - 0.1) throw invalid('台词时间戳无效，暂时无法精确对齐。');
    previous = word.start;
    // Chinese ASR can put adjacent characters at the same instant. Retain the
    // untimed character with its following word rather than inventing a time.
    if (word.end === word.start) { pending += word.word; continue; }
    words.push({ ...word, word: pending + word.word }); pending = '';
  }
  if (pending && words.length) words.at(-1).word += pending;
  if (!words.length || !intervals.length) throw invalid('未识别到清晰的人声和台词，请更换口播素材。');
  const segments = intervals.map(interval => ({ ...interval, text: '', words: [] }));
  for (const word of words) {
    const center = (word.start + word.end) / 2;
    const nearest = segments.reduce((best, segment) => {
      const distance = value => Math.max(value.start - center, center - value.end, 0);
      return distance(segment) < distance(best) ? segment : best;
    });
    if (Math.max(nearest.start - center, center - nearest.end, 0) > 0.4) throw invalid('语音识别与人声检测结果不一致，请检查背景音乐或多人说话。');
    // VAD measures speech boundaries; ASR word timestamps must not extend them
    // across a pause. Keep every recognized word, including zero-length Chinese tokens.
    const clamp = value => Math.max(nearest.start, Math.min(nearest.end, value));
    nearest.words.push({ start: clamp(word.start), end: clamp(word.end), word: word.word });
    nearest.text += word.word;
  }
  const spoken = segments.filter(segment => segment.words.length);
  if (!spoken.length || spoken.length > 30) throw invalid('人声分段不符合单人口播要求。');
  return { engine: 'silero-vad+whisper-1', timingSource: 'vad', start: spoken[0].start, end: spoken.at(-1).end,
    text: words.map(word => word.word).join(''), segments: spoken };
}

export function confirmSpeech(timeline, segments) {
  if (!timeline?.segments?.length || !Array.isArray(segments) || segments.length !== timeline.segments.length) {
    throw invalid('请保留原有台词分段，仅修改识别文字。');
  }
  const confirmed = timeline.segments.map((segment, index) => {
    const text = segments[index]?.text;
    if (typeof text !== 'string' || !speechText(text) || text.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
      throw invalid('每段台词不能为空，且不能超过2000个字符。');
    }
    return { ...segment, text: text.trim() };
  });
  const text = confirmed.map(segment => segment.text).join('');
  if (text.length > 5000) throw invalid('台词过长，请核对识别内容。');
  return { ...timeline, text, segments: confirmed };
}
export function createSpeechService(env = {}, fetchImpl = fetch) {
  const config = speechConfig(env);
  async function analyze(path, duration, { diagnosticsPath } = {}) {
    if (!config.key) throw new VideoError('声音参考的语音识别服务尚未配置。', 503, 'VIDEO_SPEECH_NOT_CONFIGURED');
    const intervals = await detectSpeech(path, config);
    if (!intervals.length) throw invalid('素材中未检测到人声，请上传清晰的单人口播。');
    const audio = path + '.asr.wav';
    try {
      await run('ffmpeg', ['-v', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-i', path,
        '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audio], { timeout: 30_000 });
      const form = new FormData();
      form.append('file', new Blob([await readFile(audio)], { type: 'audio/wav' }), 'speech.wav');
      form.append('model', 'whisper-1'); form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'word'); form.append('timestamp_granularities[]', 'segment');
      const response = await fetchImpl(new URL('/v1/audio/transcriptions', config.base), {
        method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${config.key}` }, body: form, signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new VideoError('语音识别服务未完成分析，请稍后重新分析素材。', 502, 'VIDEO_TRANSCRIPTION_FAILED');
      const data = await response.json();
      const diagnostic = { duration, vad: intervals, asr: { text: data.text, words: data.words } };
      try {
        const timeline = speechTimeline(data, intervals, duration);
        if (diagnosticsPath) await writeFile(diagnosticsPath, JSON.stringify({ ...diagnostic, timeline }), { mode: 0o600 });
        return timeline;
      } catch (cause) {
        if (diagnosticsPath) await writeFile(diagnosticsPath, JSON.stringify({ ...diagnostic, error: { code: cause.code, message: cause.message } }), { mode: 0o600 });
        throw cause;
      }
    } finally { await rm(audio, { force: true }); }
  }
  return { enabled: Boolean(config.key), analyze, detect: path => detectSpeech(path, config), align: alignSpeech };
}
export function alignmentSegments(original, generated) {
  if (speechText(original.text) !== speechText(generated.text)) throw invalid('成片台词与原视频不一致，未交付成片；请核对素材后重新生成。');
  const words = generated.segments.flatMap(segment => segment.words);
  let position = 0, index = 0;
  return original.segments.map(segment => {
    const begin = index, target = position + speechText(segment.text).length;
    while (index < words.length && position < target) position += speechText(words[index++].word).length;
    if (position !== target || index === begin) throw invalid('台词分段无法精确匹配，未交付成片。');
    const start = words[begin].start, end = words[index - 1].end;
    const interval = generated.segments.find(item => item.words.includes(words[begin]));
    const last = generated.segments.find(item => item.words.includes(words[index - 1]));
    const sourceStart = interval.words[0] === words[begin] ? interval.start : start;
    const sourceEnd = last.words.at(-1) === words[index - 1] ? last.end : end;
    const rate = (sourceEnd - sourceStart) / (segment.end - segment.start);
    if (rate < 0.7 || rate > 1.4) throw invalid('生成语速与原视频差异过大，无法自然对齐，请重新生成。');
    return { start: sourceStart, end: sourceEnd, targetStart: segment.start, targetEnd: segment.end, rate };
  });
}
export async function alignSpeech(video, output, original, generated, duration) {
  const segments = alignmentSegments(original, generated);
  const rate = 48000, track = Buffer.alloc(Math.ceil(duration * rate) * 4), pcm = output + '.aligned.pcm';
  try {
    for (const segment of segments) {
      const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', video, '-vn', '-af',
        `atrim=start=${segment.start}:end=${segment.end},asetpts=PTS-STARTPTS,atempo=${segment.rate}`,
        '-ar', String(rate), '-ac', '1', '-f', 'f32le', 'pipe:1'], { timeout: 30_000, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
      const offset = Math.round(segment.targetStart * rate) * 4;
      const length = Math.min(stdout.length, Math.round((segment.targetEnd - segment.targetStart) * rate) * 4, track.length - offset);
      stdout.copy(track, offset, 0, length);
    }
    await writeFile(pcm, track, { mode: 0o600 });
    await run('ffmpeg', ['-v', 'error', '-y', '-i', video, '-f', 'f32le', '-ar', String(rate), '-ac', '1', '-i', pcm,
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', String(duration), '-movflags', '+faststart', '-f', 'mp4', output], { timeout: 60_000 });
  } finally { await rm(pcm, { force: true }); }
  return { originalStart: original.start, generatedStart: generated.start,
    beforeOffsetMs: Math.round((generated.start - original.start) * 1000), corrected: true, transcriptMatched: true };
}
