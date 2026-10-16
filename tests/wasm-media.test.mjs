import test from 'node:test';
import assert from 'node:assert/strict';
import { createWasmMedia, mediaInfo } from '../design/wasm-media.js';

globalThis.location = new URL('https://workbench.example/mix');

function metadata({ duration = 90, start = 0, width = 1920, height = 1080 } = {}) {
  return { format: { duration: String(duration), start_time: String(start) },
    streams: [{ codec_type: 'video', codec_name: 'hevc', width, height, duration: String(duration) },
      { codec_type: 'audio', codec_name: 'aac' }] };
}

// A fake ffmpeg.wasm instance with an in-memory file system.
function engines({ probe = metadata(), probeCode = 0, frames = Infinity, execCode = 0, pendingExec = false } = {}) {
  const created = [];
  const create = async () => {
    const files = new Map(), calls = [];
    const ffmpeg = { calls, files,
      load: async options => { calls.push(['load', options]); },
      createDir: async path => { calls.push(['createDir', path]); },
      mount: async (...args) => { calls.push(['mount', ...args]); return true; },
      unmount: async path => { calls.push(['unmount', path]); },
      deleteDir: async path => { calls.push(['deleteDir', path]); },
      deleteFile: async path => { calls.push(['deleteFile', path]); files.delete(path); },
      ffprobe: async (args, timeout) => {
        calls.push(['ffprobe', args, timeout]);
        files.set(args.at(-1), JSON.stringify(probe));
        return probeCode;
      },
      exec: async (args, timeout) => {
        calls.push(['exec', args, timeout]);
        if (args[0] === '-version') return 0;
        if (pendingExec) return new Promise(() => {});
        const output = args.at(-1);
        if (output.includes('%02d')) {
          const count = Math.min(frames, Number(args[args.indexOf('-frames:v') + 1]));
          for (let i = 1; i <= count; i++) files.set(output.replace('%02d', String(i).padStart(2, '0')), new Uint8Array([0xff, 0xd8, i]));
        } else files.set(output, new Uint8Array([1, 2, 3, 4]));
        return execCode;
      },
      readFile: async (path, encoding) => {
        calls.push(['readFile', path, encoding]);
        if (!files.has(path)) throw new Error('ENOENT');
        return files.get(path);
      },
      terminate: () => { calls.push(['terminate']); } };
    created.push(ffmpeg);
    return ffmpeg;
  };
  return { created, create };
}

function source(name = '旅居.MOV') {
  const file = new File(['original media'], name, { type: 'video/quicktime' });
  file.arrayBuffer = () => { throw new Error('source must remain mounted, not copied'); };
  file.slice = () => { throw new Error('source must remain mounted, not copied'); };
  return file;
}

async function eventually(predicate) {
  // Deadline-based (performance.now, since tests freeze Date.now) so a busy machine does not fail slow timers.
  for (const deadline = performance.now() + 3000; performance.now() < deadline;) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  if (predicate()) return;
  assert.fail('ffmpeg work did not reach the expected state');
}

const arg = (args, key) => args[args.indexOf(key) + 1];

test('probe mounts the original read-only, loads the local core and cleans up', async () => {
  const { created, create } = engines({ probe: metadata({ duration: 95.5, start: 1.25 }) });
  const media = createWasmMedia({ createFFmpeg: create });
  const file = source();
  assert.deepEqual(await media.probe(file), { duration: 95.5, start: 1.25, width: 1920, height: 1080, codec: 'hevc', audio: 1 });
  const [ffmpeg] = created;
  assert.deepEqual(ffmpeg.calls.find(call => call[0] === 'exec')[1], ['-version']);
  assert.ok(ffmpeg.calls.findIndex(call => call[0] === 'exec') < ffmpeg.calls.findIndex(call => call[0] === 'mount'));
  assert.deepEqual(ffmpeg.calls.find(call => call[0] === 'load')[1], {
    coreURL: 'https://workbench.example/vendor/ffmpeg/ffmpeg-core.js',
    wasmURL: 'https://workbench.example/vendor/ffmpeg/ffmpeg-core.wasm' });
  assert.deepEqual(ffmpeg.calls.find(call => call[0] === 'mount'), ['mount', 'WORKERFS', { blobs: [{ name: 'source.mov', data: file }] }, '/m1']);
  const probe = ffmpeg.calls.find(call => call[0] === 'ffprobe')[1];
  assert.equal(probe[probe.indexOf('-o') - 1], '/m1/source.mov');
  assert.deepEqual(ffmpeg.calls.filter(call => ['deleteFile', 'unmount', 'deleteDir'].includes(call[0])),
    [['deleteFile', '/o1-probe.json'], ['unmount', '/m1'], ['deleteDir', '/m1']]);
  assert.equal(ffmpeg.files.size, 0);
});

test('frames are one JPEG per second at most 640 pixels and the last frame repeats at the end of a file', async () => {
  const { created, create } = engines({ frames: 2 });
  const media = createWasmMedia({ createFFmpeg: create });
  const frames = await media.sampleFrames(source(), 16, 19.5);
  assert.equal(frames.length, 4);
  assert.ok(frames.every(frame => frame.startsWith('data:image/jpeg;base64,')));
  assert.notEqual(frames[0], frames[1]);
  assert.equal(frames[3], frames[1]);
  const args = created[0].calls.find(call => call[0] === 'exec' && call[1][0] !== '-version')[1];
  assert.equal(arg(args, '-ss'), '16');
  assert.equal(arg(args, '-t'), '3.5');
  assert.ok(args.indexOf('-ss') < args.indexOf('-i'), 'input seeking keeps long files fast');
  assert.match(arg(args, '-vf'), /^fps=1,scale=w='min\(640,iw\)':h='min\(640,ih\)'/);
  assert.equal(arg(args, '-frames:v'), '4');
  assert.equal(created[0].files.size, 0, 'frame files are deleted');
});

test('segments are stream copies around the request that keep the original timeline', async () => {
  const { created, create } = engines({ probe: metadata({ start: 0.5 }) });
  const media = createWasmMedia({ createFFmpeg: create });
  const result = await media.extractSegment(source('long.mkv'), 40, 42);
  assert.equal(result.origin, 0.5);
  assert.equal(result.file.type, 'video/x-matroska');
  assert.equal(result.file.size, 4);
  const args = created[0].calls.find(call => call[0] === 'exec' && call[1][0] !== '-version')[1];
  assert.equal(arg(args, '-ss'), '39.000');
  assert.equal(arg(args, '-t'), '4.000');
  assert.equal(arg(args, '-c'), 'copy');
  assert.ok(args.includes('-copyts'));
  assert.equal(arg(args, '-f'), 'matroska');
  assert.equal(created[0].files.size, 0);
});

test('a probe that reports -1 with fresh JSON is accepted and real failures are rejected', async () => {
  assert.equal((await createWasmMedia({ createFFmpeg: engines({ probeCode: -1 }).create }).probe(source())).duration, 90);
  await assert.rejects(createWasmMedia({ createFFmpeg: engines({ probeCode: 1 }).create }).probe(source()), { code: 'WASM_MEDIA' });
  await assert.rejects(createWasmMedia({ createFFmpeg: engines({ probe: { format: { duration: '9' },
    streams: [{ codec_type: 'audio' }] } }).create }).probe(source()), /画面信息/);
  await assert.rejects(createWasmMedia({ createFFmpeg: engines({ execCode: 1 }).create }).sampleFrames(source(), 0, 2), { code: 'WASM_MEDIA' });
  await assert.rejects(createWasmMedia({ createFFmpeg: engines({ frames: 0 }).create }).sampleFrames(source(), 0, 2), /未读到视频画面/);
});

test('cover art is not mistaken for the video stream', () => {
  const info = mediaInfo({ format: { duration: '12' }, streams: [
    { codec_type: 'video', codec_name: 'mjpeg', width: 300, height: 300, disposition: { attached_pic: 1 } },
    { codec_type: 'video', codec_name: 'prores', width: 3840, height: 2160 }] });
  assert.deepEqual(info, { duration: 12, start: 0, width: 3840, height: 2160, codec: 'prores', audio: 0 });
});

test('at most two ffmpeg instances run at once and loaded instances are reused', async () => {
  const gates = [];
  const { created, create } = engines();
  const media = createWasmMedia({ createFFmpeg: async () => {
    const ffmpeg = await create();
    const exec = ffmpeg.exec;
    ffmpeg.exec = async (...args) => { if (args[0][0] !== '-version') await new Promise(resolve => gates.push(resolve)); return exec(...args); };
    return ffmpeg;
  } });
  const runs = [1, 2, 3].map(() => media.sampleFrames(source(), 0, 1));
  await eventually(() => gates.length === 2);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(gates.length, 2, 'the third job waits for a free instance');
  assert.equal(created.length, 2);
  gates.shift()();
  await eventually(() => gates.length === 2);
  gates.splice(0).forEach(release => release());
  assert.equal((await Promise.all(runs)).length, 3);
  assert.equal(created.length, 2);
  assert.equal(created.flatMap(ffmpeg => ffmpeg.calls).filter(call => call[0] === 'load').length, 2);
});

test('stopping terminates the running instance and the next job loads a fresh one', async () => {
  const pending = engines({ pendingExec: true }), fresh = engines();
  let loads = 0;
  const media = createWasmMedia({ createFFmpeg: () => (++loads === 1 ? pending : fresh).create() });
  await assert.rejects(media.probe(source(), AbortSignal.abort()), { name: 'AbortError' });
  assert.equal(loads, 0, 'an already stopped job never loads ffmpeg');
  const controller = new AbortController();
  const running = media.sampleFrames(source(), 0, 2, controller.signal);
  await eventually(() => pending.created[0]?.calls.some(call => call[0] === 'exec' && call[1][0] !== '-version'));
  controller.abort();
  await assert.rejects(running, { name: 'AbortError' });
  assert.ok(pending.created[0].calls.some(call => call[0] === 'terminate'));
  assert.equal((await media.sampleFrames(source(), 0, 2)).length, 2);
  assert.equal(loads, 2, 'a terminated worker is never reused');
});

test('actual pinned WASM core probes, samples and stream-copies an HEVC MOV', { skip: process.env.WASM_MEDIA_CORE_TEST !== '1' }, async t => {
  const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createRequire } = await import('node:module');
  const { spawnSync } = await import('node:child_process');
  const require = createRequire(import.meta.url);
  const previousSelf = globalThis.self;
  globalThis.self = { location: globalThis.location };
  const folder = await mkdtemp(join(tmpdir(), 'wasm-media-'));
  t.after(async () => {
    if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf;
    await rm(folder, { recursive: true, force: true });
  });
  const createCore = require('@ffmpeg/core');
  const wasmBinary = await readFile(require.resolve('@ffmpeg/core/wasm'));
  const input = join(folder, 'input.mov');
  const generated = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '6', '-c:v', 'libx265', '-tag:v', 'hvc1',
    '-x265-params', 'log-level=error', '-c:a', 'aac', input], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr || generated.error?.message);
  const createFFmpeg = async () => {
    let core;
    return {
      load: async () => { core = await createCore({ wasmBinary }); },
      createDir: async path => core.FS.mkdir(path),
      // Node has no FileReaderSync for WORKERFS; this fixture copies the small input into MEMFS.
      mount: async (_, { blobs }, path) => {
        core.FS.writeFile(`${path}/${blobs[0].name}`, new Uint8Array(await blobs[0].data.arrayBuffer()));
        return true;
      },
      unmount: async path => {
        for (const name of core.FS.readdir(path)) if (name !== '.' && name !== '..') core.FS.unlink(`${path}/${name}`);
      },
      deleteDir: async path => core.FS.rmdir(path),
      deleteFile: async path => core.FS.unlink(path),
      readFile: async (path, encoding = 'binary') => core.FS.readFile(path, { encoding }),
      ffprobe: async (args, timeout = -1) => { core.setTimeout(timeout); core.ffprobe(...args); const code = core.ret; core.reset(); return code; },
      exec: async (args, timeout = -1) => { core.setTimeout(timeout); core.exec(...args); const code = core.ret; core.reset(); return code; },
      terminate: () => { core = null; },
    };
  };
  const media = createWasmMedia({ createFFmpeg, instances: 1 });
  const file = new File([await readFile(input)], 'input.MOV', { type: 'video/quicktime' });
  const info = await media.probe(file);
  assert.equal(info.codec, 'hevc');
  assert.deepEqual([info.width, info.height], [1280, 720]);
  assert.ok(Math.abs(info.duration - 6) < 0.1);
  const frames = await media.sampleFrames(file, 3, 6);
  assert.equal(frames.length, 3);
  const jpeg = Buffer.from(frames[0].split(',')[1], 'base64');
  assert.deepEqual([...jpeg.subarray(0, 2)], [0xff, 0xd8]);
  const segment = await media.extractSegment(file, 2, 4);
  const output = join(folder, 'segment.mkv');
  await writeFile(output, new Uint8Array(await segment.file.arrayBuffer()));
  const probed = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output], { encoding: 'utf8' });
  assert.equal(probed.status, 0, probed.stderr);
  const streams = JSON.parse(probed.stdout).streams;
  assert.deepEqual(streams.map(stream => stream.codec_name), ['hevc', 'aac']);
  assert.ok(segment.file.size < file.size, 'only the requested range is copied');
});
