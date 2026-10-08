import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoRepair } from '../design/material-repair.js';

const MiB = 1024 * 1024;
globalThis.location = new URL('https://workbench.example/materials');

function source(size = 2000) {
  const file = new File(['original media'], '旅居.MOV', { type: 'video/quicktime', lastModified: 123 });
  Object.defineProperty(file, 'size', { value: size });
  file.arrayBuffer = () => { throw new Error('source must remain mounted, not copied'); };
  return file;
}

function metadata({ duration = 90, codec = 'h264', pixel = 'yuv420p', width = 1920, height = 1080, audio = true, rotation, size = 2000 } = {}) {
  return {
    format: { duration: String(duration), size: String(size), format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
    streams: [
      { index: 0, codec_type: 'video', codec_name: codec, pix_fmt: pixel, width, height, duration: String(duration), sample_aspect_ratio: '1:1', ...(rotation ? { side_data_list: [{ rotation }] } : {}) },
      ...(audio ? [{ index: 1, codec_type: 'audio', codec_name: 'aac', duration: String(duration) }] : []),
    ],
  };
}

function engine({ input = metadata(), outputs = [metadata()], failRemux = false, pendingExec = false, pendingLoad = false, mountResult = true } = {}) {
  const calls = [];
  const events = new Map();
  let output;
  let probeData;
  let attempts = 0;
  const ffmpeg = {
    calls,
    on: (event, listener) => events.set(event, listener),
    off: (event) => events.delete(event),
    load: async options => { calls.push(['load', options]); if (pendingLoad) return new Promise(() => {}); },
    createDir: async path => calls.push(['createDir', path]),
    mount: async (...args) => { calls.push(['mount', ...args]); return mountResult; },
    unmount: async path => calls.push(['unmount', path]),
    deleteFile: async path => calls.push(['deleteFile', path]),
    ffprobe: async args => {
      calls.push(['ffprobe', args]);
      probeData = args.includes('/input/source') ? input : output;
      return 0;
    },
    readFile: async (path, encoding) => {
      calls.push(['readFile', path, encoding]);
      return encoding === 'utf8' ? JSON.stringify(probeData) : new Uint8Array(Number(output.format.size));
    },
    exec: async args => {
      calls.push(['exec', args]);
      events.get('progress')?.({ progress: 0.5, time: 45_000_000 });
      if (pendingExec) return new Promise(() => {});
      if (failRemux && args.includes('copy')) return 1;
      output = outputs[Math.min(attempts++, outputs.length - 1)];
      return 0;
    },
    terminate: () => calls.push(['terminate']),
  };
  return ffmpeg;
}

const commands = ffmpeg => ffmpeg.calls.filter(call => call[0] === 'exec').map(call => call[1]);
const arg = (args, key) => args[args.indexOf(key) + 1];

test('compatible MOV is losslessly remuxed from a read-only Blob mount and cleaned up', async () => {
  const ffmpeg = engine();
  const file = source();
  const updates = [];
  const result = await createVideoRepair(async () => ffmpeg)(file, { onProgress: value => updates.push(value) });
  assert.ok(result instanceof File);
  assert.equal(result.name, '旅居.mp4');
  assert.equal(result.type, 'video/mp4');
  assert.equal(file.name, '旅居.MOV');
  assert.deepEqual(ffmpeg.calls.find(call => call[0] === 'mount'), ['mount', 'WORKERFS', { blobs: [{ name: 'source', data: file }] }, '/input']);
  assert.deepEqual(ffmpeg.calls.find(call => call[0] === 'load')[1], {
    coreURL: 'https://workbench.example/vendor/ffmpeg/ffmpeg-core.js',
    wasmURL: 'https://workbench.example/vendor/ffmpeg/ffmpeg-core.wasm',
  });
  assert.equal(arg(commands(ffmpeg)[0], '-c:v'), 'copy');
  assert.equal(arg(commands(ffmpeg)[0], '-c:a'), 'copy');
  assert.ok(ffmpeg.calls.some(call => call[0] === 'unmount'));
  assert.equal(ffmpeg.calls.at(-1)[0], 'terminate');
  assert.equal(updates.at(-1).progress, 1);
});

test('573 MiB input is accepted and fully transcoded to bounded H264/AAC with portrait rotation', async () => {
  const ffmpeg = engine({ input: metadata({ duration: 600, width: 3840, height: 2160, rotation: 90 }), outputs: [metadata({ duration: 600, width: 1080, height: 1920 })] });
  await createVideoRepair(async () => ffmpeg)(source(573 * MiB));
  const [args] = commands(ffmpeg);
  assert.equal(commands(ffmpeg).length, 1);
  assert.equal(arg(args, '-c:v'), 'libx264');
  assert.equal(arg(args, '-pix_fmt'), 'yuv420p');
  assert.equal(arg(args, '-c:a'), 'aac');
  assert.equal(arg(args, '-vf'), 'scale=1080:1920,setsar=1');
  assert.ok(Number(arg(args, '-b:v')) < 480 * MiB * 8 / 600);
  for (const truncating of ['-fs', '-t', '-to', '-shortest']) assert.equal(args.includes(truncating), false);
  assert.ok(args.includes('0:a?'));
});

test('incompatible codec skips remux and accounts for anamorphic aspect', async () => {
  const input = metadata({ codec: 'hevc', width: 1440, height: 1080, audio: false });
  input.streams[0].sample_aspect_ratio = '4:3';
  const ffmpeg = engine({ input, outputs: [metadata({ width: 1920, height: 1080, audio: false })] });
  await createVideoRepair(async () => ffmpeg)(source());
  assert.equal(arg(commands(ffmpeg)[0], '-vf'), 'scale=1920:1080,setsar=1');
  assert.equal(arg(commands(ffmpeg)[0], '-c:v'), 'libx264');
});

test('failed remux falls back to transcoding without changing the source', async () => {
  const ffmpeg = engine({ failRemux: true });
  await createVideoRepair(async () => ffmpeg)(source());
  assert.deepEqual(commands(ffmpeg).map(args => arg(args, '-c:v')), ['copy', 'libx264']);
});

test('oversized output retries once at a lower bitrate without reading the oversized buffer', async () => {
  const ffmpeg = engine({ input: metadata({ codec: 'hevc', duration: 10 }), outputs: [metadata({ duration: 10, size: 1_200_000 }), metadata({ duration: 10, size: 800_000 })] });
  const result = await createVideoRepair(async () => ffmpeg)(source(), { maxSize: 1_000_000 });
  const args = commands(ffmpeg);
  assert.equal(args.length, 2);
  assert.ok(Number(arg(args[1], '-b:v')) < Number(arg(args[0], '-b:v')));
  assert.equal(result.size, 800_000);
  assert.equal(ffmpeg.calls.filter(call => call[0] === 'readFile' && call[2] !== 'utf8').length, 1);
});

test('persistent oversized output is rejected after at most one bitrate retry', async () => {
  const ffmpeg = engine({ input: metadata({ codec: 'hevc', duration: 10 }), outputs: [metadata({ duration: 10, size: 1_200_000 })] });
  await assert.rejects(createVideoRepair(async () => ffmpeg)(source(), { maxSize: 1_000_000 }), /大小|体积|限制/);
  assert.equal(commands(ffmpeg).length, 2);
  assert.equal(ffmpeg.calls.at(-1)[0], 'terminate');
});

test('truncated video or missing audio is rejected before it can replace the original', async () => {
  const shortenedAudio = metadata();
  shortenedAudio.streams[1].duration = '80';
  const unknownVideo = metadata();
  delete unknownVideo.streams[0].duration;
  for (const output of [metadata({ duration: 80 }), metadata({ audio: false }), shortenedAudio, unknownVideo]) {
    const ffmpeg = engine({ input: metadata({ codec: 'hevc' }), outputs: [output] });
    await assert.rejects(createVideoRepair(async () => ffmpeg)(source()), /时长|音频|完整/);
    assert.equal(ffmpeg.calls.at(-1)[0], 'terminate');
  }
});

test('the actual output buffer is checked even when probe size disagrees', async () => {
  const ffmpeg = engine();
  const read = ffmpeg.readFile;
  ffmpeg.readFile = async (path, encoding) => encoding === 'utf8' ? read(path, encoding) : new Uint8Array(20_001);
  await assert.rejects(createVideoRepair(async () => ffmpeg)(source(), { maxSize: 20_000 }), /大小|体积|限制/);
});

test('cancelling a stalled load or conversion promptly terminates and rejects with AbortError', async () => {
  for (const phase of ['pendingLoad', 'pendingExec']) {
    const ffmpeg = engine({ [phase]: true });
    const abort = new AbortController();
    const repairing = createVideoRepair(async () => ffmpeg)(source(), { signal: abort.signal });
    const rejected = assert.rejects(repairing, error => error.name === 'AbortError');
    await new Promise(resolve => setImmediate(resolve));
    abort.abort();
    await rejected;
    assert.ok(ffmpeg.calls.some(call => call[0] === 'terminate'));
  }
});

test('2 GiB sources and already cancelled work are rejected before loading the runtime', async () => {
  let loads = 0;
  const repair = createVideoRepair(async () => { loads++; return engine(); });
  await assert.rejects(repair(source(2 * 1024 * MiB)), /2\s*GiB|2\s*GB/);
  await assert.rejects(repair(source(), { signal: AbortSignal.abort() }), error => error.name === 'AbortError');
  assert.equal(loads, 0);
});

test('failed WORKERFS support returns a clear error and releases the worker', async () => {
  const ffmpeg = engine({ mountResult: false });
  await assert.rejects(createVideoRepair(async () => ffmpeg)(source()), /挂载|读取/);
  assert.equal(ffmpeg.calls.at(-1)[0], 'terminate');
});

test('pinned core ffprobe sentinel -1 is accepted only with valid fresh probe JSON', async () => {
  const ffmpeg = engine();
  const probe = ffmpeg.ffprobe;
  ffmpeg.ffprobe = async args => { await probe(args); return -1; };
  await createVideoRepair(async () => ffmpeg)(source());
  const files = ffmpeg.calls.filter(call => call[0] === 'ffprobe').map(call => arg(call[1], '-o'));
  assert.equal(new Set(files).size, files.length);
  const invalid = engine();
  invalid.ffprobe = async () => -1;
  invalid.readFile = async () => '{}';
  await assert.rejects(createVideoRepair(async () => invalid)(source()), /时长|信息/);
});

test('actual pinned WASM core converts a rotated MOV with complete audio and duration', { skip: process.env.MATERIAL_REPAIR_CORE_TEST !== '1' }, async t => {
  const { mkdir, readFile, writeFile } = await import('node:fs/promises');
  const { createRequire } = await import('node:module');
  const { fileURLToPath } = await import('node:url');
  const { spawnSync } = await import('node:child_process');
  const require = createRequire(import.meta.url);
  const previousSelf = globalThis.self;
  globalThis.self = { location: globalThis.location };
  t.after(() => { if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf; });
  const createCore = require('@ffmpeg/core');
  const wasmBinary = await readFile(require.resolve('@ffmpeg/core/wasm'));
  const folder = new URL('../outputs/index-repair-20261008/', import.meta.url);
  await mkdir(folder, { recursive: true });
  const original = fileURLToPath(new URL('core-input.mov', folder));
  const rotated = fileURLToPath(new URL('core-rotated.mov', folder));
  for (const args of [
    ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1.2', '-c:v', 'mpeg4', '-q:v', '3', '-c:a', 'pcm_s16le', original],
    ['-y', '-v', 'error', '-display_rotation', '90', '-i', original, '-c', 'copy', rotated],
  ]) {
    const generated = spawnSync('ffmpeg', args, { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr || generated.error?.message);
  }
  let core;
  const actualCommands = [];
  const callbacks = new Map();
  const adapter = {
    on: (name, fn) => callbacks.set(name, fn),
    off: (name) => callbacks.delete(name),
    load: async () => {
      core = await createCore({ wasmBinary });
      core.setProgress(event => callbacks.get('progress')?.(event));
    },
    createDir: async path => core.FS.mkdir(path),
    // Node has no FileReaderSync; only this tiny integration fixture uses MEMFS.
    mount: async (_, { blobs }, path) => {
      core.FS.writeFile(`${path}/${blobs[0].name}`, new Uint8Array(await blobs[0].data.arrayBuffer()));
      return true;
    },
    unmount: async () => {},
    deleteFile: async path => core.FS.unlink(path),
    readFile: async (path, encoding = 'binary') => core.FS.readFile(path, { encoding }),
    ffprobe: async args => { core.setTimeout(-1); core.ffprobe(...args); const code = core.ret; core.reset(); return code; },
    exec: async args => { actualCommands.push(args); core.setTimeout(-1); core.exec(...args); const code = core.ret; core.reset(); return code; },
    terminate: () => { core = null; },
  };
  const file = new File([await readFile(rotated)], 'rotated.MOV', { type: 'video/quicktime' });
  const result = await createVideoRepair(async () => adapter)(file);
  const output = fileURLToPath(new URL('core-repaired.mp4', folder));
  await writeFile(output, new Uint8Array(await result.arrayBuffer()));
  const inspected = spawnSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', output], { encoding: 'utf8' });
  assert.equal(inspected.status, 0, inspected.stderr);
  const info = JSON.parse(inspected.stdout);
  const video = info.streams.find(stream => stream.codec_type === 'video');
  assert.equal(video.codec_name, 'h264');
  assert.equal(video.pix_fmt, 'yuv420p');
  assert.deepEqual([video.width, video.height], [90, 160]);
  assert.equal(info.streams.find(stream => stream.codec_type === 'audio').codec_name, 'aac');
  assert.ok(Math.abs(Number(info.format.duration) - 1.2) <= 0.05);
  const compatible = fileURLToPath(new URL('core-compatible.mov', folder));
  const wrapped = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', output, '-c', 'copy', compatible], { encoding: 'utf8' });
  assert.equal(wrapped.status, 0, wrapped.stderr);
  const remuxed = await createVideoRepair(async () => adapter)(new File([await readFile(compatible)], 'compatible.MOV'));
  assert.ok(remuxed.size > 0);
  assert.equal(arg(actualCommands.at(-1), '-c:v'), 'copy');
});
