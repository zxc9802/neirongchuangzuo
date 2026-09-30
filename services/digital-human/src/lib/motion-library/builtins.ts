import 'server-only';
import compiled from './builtin-compiled.json' with {type:'json'};
import type {LibraryEffect} from './contract';
import type {StoredEffect} from './store';
import {VISUAL_LAYOUTS} from './visual';

const templates=[
  {id:'builtin_green_text',name:'绿金文字总结',description:'深绿金边背景，黄色标题、两行白字依次入场，重点词高亮。',code:compiled.builtin_green_text},
  {id:'builtin_green_diagram',name:'绿金流程图解',description:'根据口播选择节点、线稿图标和关系，支持流程、分支、汇总、对比、公式和并列要点。',code:compiled.builtin_green_diagram},
];
export function getBuiltinEffect(id:string):StoredEffect|undefined {
  const item=templates.find(t=>t.id===id);if(!item)return;
  const row:StoredEffect={id:item.id,name:item.name,status:'ready',message:item.description,saved:true,revision:1,updatedAt:0,messages:[],assets:[],versions:[{revision:1,sourceCode:'',compiled:item.code,backgroundColor:'#194b36',assets:[],preview:`/motion-templates/${item.id}-v1.mp4`}]};
  if(id==='builtin_green_diagram'){
    row.revision=2;
    row.versions.push({revision:2,sourceCode:'',compiled:compiled.builtin_green_diagram_v2,backgroundColor:'#194b36',assets:[],preview:`/motion-templates/${id}-v2.mp4`,semantics:{required:true,reason:'根据口播内容选择图标、节点及它们的关系',layouts:[...VISUAL_LAYOUTS]}});
  }
  return row;
}
export function publicBuiltinEffect(id:string,detail=false,revision?:number):LibraryEffect|undefined {
  const row=getBuiltinEffect(id);if(!row)return;
  const version=row.versions.find(v=>v.revision===(revision??row.revision));if(!version)return;
  return {id:row.id,name:row.name,builtin:true,status:'ready',message:row.message,saved:true,revision:version.revision,semantics:version.semantics,updatedAt:0,messages:[],assets:[],previewUrl:version.preview,...(detail?{template:{compiled:version.compiled,assets:[],backgroundColor:version.backgroundColor,semantics:version.semantics}}:{})};
}
export const listBuiltinEffects=()=>templates.map(t=>publicBuiltinEffect(t.id)!);
