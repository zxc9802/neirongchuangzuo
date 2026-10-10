import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { writeFile, rm } from 'node:fs/promises';

const run = promisify(execFile);
const worker = fileURLToPath(new URL('./captions.py', import.meta.url));

// Caption text is authoritative; VAD supplies speech boundaries, never words.
export function captionSpeech(captions, intervals = []) {
  const segments = intervals.length ? intervals.map(interval => ({ ...interval, text: '', words: [] }))
    : captions.cues.map(cue => ({ start: cue.start, end: cue.end, text: '', words: [] }));
  for (const cue of captions.cues) {
    const overlap = segment => Math.max(0, Math.min(cue.end, segment.end) - Math.max(cue.start, segment.start));
    const distance = segment => Math.max(segment.start - cue.end, cue.start - segment.end, 0);
    const nearest = segments.reduce((best, segment) => overlap(segment) > overlap(best)
      || overlap(segment) === overlap(best) && distance(segment) < distance(best) ? segment : best);
    nearest.text += cue.text.replace(/\n/g, '');
  }
  const spoken = segments.filter(segment => segment.text);
  return { engine: captions.engine, source: 'subtitles', timingSource: intervals.length ? 'vad' : 'subtitles',
    start: spoken[0].start, end: spoken.at(-1).end, text: spoken.map(segment => segment.text).join(''), segments: spoken };
}

export function createCaptionService(env = {}) {
  const python = env.VIDEO_PYTHON_BIN || env.MIX_PYTHON_BIN || 'python3';
  async function extract(path) {
    const { stdout } = await run(python, [worker, 'extract', path], { maxBuffer: 2 * 1024 * 1024 });
    return JSON.parse(stdout);
  }
  async function process(mode, input, output, captions) {
    const metadata = output + '.captions.json';
    try {
      await writeFile(metadata, JSON.stringify(captions), { mode: 0o600 });
      await run(python, [worker, mode, input, output, metadata], { maxBuffer: 2 * 1024 * 1024 });
    } finally { await rm(metadata, { force: true }); }
  }
  return { extract, clean: (input, output, captions) => process('clean', input, output, captions),
    render: (input, output, captions) => process('render', input, output, captions) };
}
