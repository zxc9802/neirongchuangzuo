import {build} from 'esbuild';
await build({entryPoints:['src/remotion/effect-frame.tsx'],outfile:'public/effect-frame.js',bundle:true,minify:true,format:'iife',platform:'browser',define:{'process.env.NODE_ENV':'"production"'},logLevel:'error'});
console.log('Effect preview runtime bundled');
