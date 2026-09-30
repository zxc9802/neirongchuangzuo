import fs from 'node:fs';
import path from 'node:path';
import {compileEffect} from './motion-library/compile.mjs';
const templates=[['builtin_green_text','GreenText'],['builtin_green_diagram','GreenDiagram'],['builtin_green_diagram_v2','GreenSemanticDiagram']];
const compiled=Object.fromEntries(templates.map(([id,name])=>[id,compileEffect(fs.readFileSync(path.resolve(`src/remotion/templates/${name}.tsx`),'utf8'))]));
fs.writeFileSync(path.resolve('src/lib/motion-library/builtin-compiled.json'),JSON.stringify(compiled,null,2)+'\n');
console.log('Built-in motion templates compiled');
