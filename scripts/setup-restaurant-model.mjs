import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const target = fileURLToPath(new URL('../services/restaurant/models/u2net.onnx', import.meta.url));
const url = 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx';
const expectedMD5 = '60024c5c889badc19c04ad937298a77b';
const valid = bytes => bytes.length === 175997641 && createHash('md5').update(bytes).digest('hex') === expectedMD5;
if (valid(await readFile(target).catch(() => Buffer.alloc(0)))) {
  console.log('Restaurant subject model already verified.');
} else {
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.download`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error(`Subject model download failed: HTTP ${response.status}`);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 180_000_000) throw new Error('Subject model exceeds size limit.');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (!valid(bytes)) throw new Error('Subject model checksum mismatch.');
    await writeFile(temp, bytes); await rename(temp, target);
    console.log('Restaurant subject model installed and verified.');
  } finally { await rm(temp, { force: true }); }
}
