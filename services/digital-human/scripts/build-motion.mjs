import {bundle} from '@remotion/bundler';
import path from 'node:path';
import fs from 'node:fs';
await import('./build-builtin-effects.mjs');
const publicDir = path.resolve('.runtime/remotion-public');
fs.mkdirSync(publicDir, {recursive: true});
await bundle({entryPoint: path.resolve('src/remotion/index.tsx'), outDir: path.resolve('.motion-bundle'), publicDir});
console.log('Remotion template bundled');

await import("./build-effect-frame.mjs");
