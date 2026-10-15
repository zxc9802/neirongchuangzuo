import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const workerPath = fileURLToPath(new URL('./python/subject_mask.py', import.meta.url));
const bundledModel = fileURLToPath(new URL('./models/u2net.onnx', import.meta.url));
const failure = () => Object.assign(new Error('主体提取暂不可用。'), { code: 'SUBJECT_MASK_FAILED' });

export function createSubjectMasker({ env = process.env, timeoutMs = 45_000, idleMs = 30_000 } = {}) {
  let child, pending, serial = Promise.resolve(), idleTimer, closing = false, queued = 0;
  function stop() { clearTimeout(idleTimer); child?.kill(); child = null; }
  async function run(bytes) {
    if (closing) throw failure();
    clearTimeout(idleTimer);
    if (!child) {
      const path = env.RESTAURANT_SUBJECT_MODEL_PATH || bundledModel;
      await access(path).catch(() => { throw failure(); });
      child = spawn(env.RESTAURANT_PYTHON_BIN || env.MIX_PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3'), ['-u', workerPath, path], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, OMP_NUM_THREADS: '2' } });
      const processRef = child;
      let output = '';
      processRef.stdout.setEncoding('utf8');
      processRef.stdout.on('data', chunk => {
        if (child !== processRef) return;
        output += chunk;
        if (output.length > 200_000) { pending?.reject(failure()); stop(); return; }
        const end = output.indexOf('\n');
        if (end < 0) return;
        const line = output.slice(0, end); output = output.slice(end + 1);
        try {
          const value = JSON.parse(line);
          if (typeof value.mask !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.mask)) throw failure();
          pending?.resolve(Buffer.from(value.mask, 'base64'));
        } catch { pending?.reject(failure()); }
      });
      processRef.stderr.on('data', () => {});
      const ended = () => { if (child !== processRef) return; child = null; pending?.reject(failure()); };
      processRef.on('error', ended); processRef.on('exit', ended);
      processRef.stdin.on('error', ended);
    }
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { reject(failure()); stop(); }, timeoutMs);
        pending = { resolve: mask => { clearTimeout(timer); resolve(mask); }, reject: cause => { clearTimeout(timer); reject(cause); } };
        child.stdin.write(`${JSON.stringify({ image: bytes.toString('base64') })}\n`);
      });
    } finally {
      pending = null;
      idleTimer = setTimeout(stop, idleMs); idleTimer.unref?.();
    }
  }
  return {
    mask(bytes) {
      if (closing || queued >= 16 || !Buffer.isBuffer(bytes) || bytes.length > 8 * 1024 * 1024) return Promise.reject(failure());
      queued++;
      const next = serial.catch(() => {}).then(() => run(bytes)).finally(() => { queued--; }); serial = next; return next;
    },
    async close() { closing = true; await serial.catch(() => {}); stop(); },
  };
}
