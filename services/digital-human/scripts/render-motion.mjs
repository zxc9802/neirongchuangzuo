import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {renderMedia, selectComposition, ensureBrowser} from '@remotion/renderer';
import {bundle} from '@remotion/bundler';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if(job.effectTemplate){
  const {renderEffectVideo}=await import('./motion-library/render.mjs');
  await renderEffectVideo({template:job.effectTemplate,output:job.output,source:job.source,edit:job.edit,duration:job.duration,onProgress:progress=>process.stdout.write(JSON.stringify({progress})+'\n')});
  process.exit(0);
}
const source = path.resolve(job.source);
const token = crypto.randomBytes(24).toString('hex');
// Only this render process can fetch the source; no public URL or session cookie is exposed.
const server = http.createServer((req, res) => {
  if (req.url !== `/${token}`) {res.writeHead(404).end(); return;}
  const size = fs.statSync(source).size;
  const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start > end || start >= size) {res.writeHead(416).end(); return;}
  res.writeHead(range ? 206 : 200, {'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', ...(range ? {'Content-Range': `bytes ${start}-${end}/${size}`} : {})});
  if (req.method === 'HEAD') {res.end(); return;}
  const stream = fs.createReadStream(source, {start, end}); stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  let serveUrl = path.resolve('.motion-bundle');
  if (!fs.existsSync(path.join(serveUrl, 'index.html'))) {
    const publicDir = path.resolve('.runtime/remotion-public'); fs.mkdirSync(publicDir, {recursive: true});
    serveUrl = await bundle({entryPoint: path.resolve('src/remotion/index.tsx'), publicDir});
  }
  const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE || undefined;
  await ensureBrowser({browserExecutable, logLevel: 'error'});
  const inputProps = {...job.edit, duration: job.duration, sourceUrl: `http://127.0.0.1:${server.address().port}/${token}`};
  const composition = await selectComposition({serveUrl, id: 'DigitalHumanMotion', inputProps, browserExecutable, logLevel: 'error'});
  let last = -1;
  await renderMedia({composition, serveUrl, inputProps, outputLocation: job.output, codec: 'h264', crf: 18, pixelFormat: 'yuv420p', colorSpace: 'bt709',
    audioCodec: undefined, muted: true, browserExecutable, concurrency: 2, logLevel: 'error',
    chromiumOptions: {enableMultiProcessOnLinux: true},
    onProgress: ({progress}) => {const percent = Math.floor(progress * 100); if (percent !== last) {last = percent; process.stdout.write(JSON.stringify({progress: percent}) + '\n');}},
  });
} finally {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
