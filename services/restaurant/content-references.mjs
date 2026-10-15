import { readFile } from 'node:fs/promises';
import { fingerprint } from './rules.mjs';

const sets = {
  'store-intro': {revision:'store-intro-v1',files:Array.from({length:6},(_,i)=>`store-intro-${i+1}.jpg`)},
  'signature-dish': {revision:'signature-dish-v1',files:Array.from({length:5},(_,i)=>`signature-dish-${i+1}.jpg`)},
  'consumption-scene': {revision:'consumption-scene-v2',files:Array.from({length:4},(_,i)=>`consumption-scene-${i+1}.jpg`)},
};
export async function contentReferences(type) {
  const set=sets[type]; if(!set) return {images:[],binding:null};
  const images=await Promise.all(set.files.map(async(file,i)=>({id:`type-reference-${i+1}`,bytes:await readFile(new URL(`./content-references/${file}`,import.meta.url)),mime:'image/jpeg',role:'style-only-never-source'})));
  return {images,binding:{type,revision:set.revision,count:images.length,fingerprint:fingerprint(images.map(p=>fingerprint(p.bytes.toString('base64'))))}};
}
