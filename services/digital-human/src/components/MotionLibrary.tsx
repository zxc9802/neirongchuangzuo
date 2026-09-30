"use client";
import React,{useEffect,useRef,useState} from 'react';
import {Plus,Sparkles,Upload,X,Save,Loader2,ArrowUpRight,FolderOpen} from 'lucide-react';
import {uploadMediaFile} from '@/lib/client-media-upload';
import type {EffectRef,LibraryEffect} from '@/lib/motion-library/contract';
async function request(url:string,init?:RequestInit){const r=await fetch(url,{...init,cache:'no-store'}),d=await r.json();if(!r.ok)throw new Error(d.error||'操作失败，请重试');return d;}
export default function MotionLibrary({onApply,applied,disabled}: {onApply:(effect:LibraryEffect)=>void;applied?:EffectRef;disabled:boolean}) {
  const [builtins,setBuiltins]=useState<LibraryEffect[]>([]);
  const [effects,setEffects]=useState<LibraryEffect[]>([]),[selected,setSelected]=useState<LibraryEffect|null>(null),[editing,setEditing]=useState(false);
  const [prompt,setPrompt]=useState(''),[name,setName]=useState(''),[files,setFiles]=useState<File[]>([]),[pending,setPending]=useState(false),[error,setError]=useState(''),[uploadStatus,setUploadStatus]=useState('');
  const input=useRef<HTMLInputElement>(null),editor=useRef<HTMLDivElement>(null);
  const selection=useRef(0),requestedEffect=useRef<string|undefined>(undefined);
  const building=selected?.status==='building',busy=pending||building;
  async function refresh(){const data=await request('/api/motion-library');setEffects(data.effects);setBuiltins(data.builtins||[]);}
  useEffect(()=>{void refresh().catch(e=>setError(e.message));},[]);
  useEffect(()=>{if(editing)editor.current?.scrollIntoView({behavior:'smooth',block:'start'});},[editing,selected?.id]);
  useEffect(()=>{
    if(!effects.some(e=>e.status==='building')&&!building)return;
    let stopped=false;
    const timer=setInterval(async()=>{try{
      const data=await request('/api/motion-library');if(stopped)return;setEffects(data.effects);
      if(selected?.status==='building'){const d=await request(`/api/motion-library/${selected.id}`);if(!stopped&&requestedEffect.current===selected.id)setSelected(d.effect);}
    }catch(e){if(!stopped)setError((e as Error).message);}},2500);
    return()=>{stopped=true;clearInterval(timer);};
  },[effects.some(e=>e.status==='building'),selected?.id,building]);
  function create(){selection.current++;requestedEffect.current=undefined;setSelected(null);setName('');setPrompt('');setFiles([]);setError('');setEditing(true);}
  async function open(id:string){const current=++selection.current;requestedEffect.current=id;setPending(true);try{const d=await request(`/api/motion-library/${id}`);if(current!==selection.current)return;setSelected(d.effect);setName(d.effect.name);setPrompt('');setFiles([]);setError('');setEditing(true);}catch(e){if(current===selection.current)setError((e as Error).message);}finally{if(current===selection.current)setPending(false);}}
  function choose(incoming:FileList|null){
    if(!incoming)return;
    const list=Array.from(incoming);
    if(list.length+files.length+(selected?.assets.length||0)>4){setError('每个动效最多使用 4 个素材');return;}
    if(list.some(f=>!(/\.(png|jpe?g|webp)$/i.test(f.name)&&f.size<=10*1024*1024||/\.(mp4|mov|webm|m4v)$/i.test(f.name)&&f.size<=100*1024*1024))){setError('请上传图片（10 MB 内）或视频（100 MB 内）');return;}
    setFiles(current=>[...current,...list]);setError('');
  }
  async function generate(){
    if(!prompt.trim()||busy)return;setPending(true);setError('');
    try{
      const uploads=[];
      for(const [index,file] of files.entries()){
        const kind=/\.(png|jpe?g|webp)$/i.test(file.name)?'image':'video';
        const uploaded=await uploadMediaFile(file,file.name,kind==='image'?'thumbnails':'videos',percent=>setUploadStatus(`正在上传素材 ${index+1}/${files.length} · ${percent}%`));
        uploads.push({key:uploaded.uploadKey,name:file.name,kind});
      }
      setUploadStatus('正在提交动效需求');
      const data=await request(selected?`/api/motion-library/${selected.id}`:'/api/motion-library',{method:selected?'PATCH':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'generate',prompt,name,uploads})});
      requestedEffect.current=data.effect.id;setSelected(data.effect);setFiles([]);setPrompt('');await refresh();
    }catch(e){setError((e as Error).message);}finally{setPending(false);setUploadStatus('');}
  }
  async function save(){if(!selected)return;setPending(true);setError('');try{const d=await request(`/api/motion-library/${selected.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'save'})});setSelected(d.effect);await refresh();}catch(e){setError((e as Error).message);}finally{setPending(false);}}
  return <section id="motion-library" className="effect-library">
    <div className="effect-library-heading"><div><h2><FolderOpen size={19}/>动效库</h2><p>内置模板直接使用，个人创作的动效仅当前账号可见。</p></div><button className="motion-button secondary" onClick={create} disabled={pending}><Plus size={16}/>创作动效</button></div>
    {error&&<div className="motion-alert" role="alert">{error}</div>}
    {!!builtins.length&&<div className="effect-builtin-section"><h3>内置固定模板 <small>替换文案即可使用</small></h3><div className="effect-grid effect-builtin-grid">{builtins.map(effect=><article key={effect.id} className={`effect-card ${applied?.id===effect.id?'selected':''}`}>
      <video src={effect.previewUrl} poster={`/motion-templates/${effect.id}-v${effect.revision}.jpg`} controls muted playsInline preload="metadata" aria-label={`${effect.name}预览`}/>
      <div className="effect-card-body"><div><h3>{effect.name}</h3><span>内置 · 固定</span></div><p>{effect.message}</p><div className="effect-card-actions"><span className="motion-help">{effect.semantics?.required?'应用后按口播自动编排图解':'应用后编辑当前片段的文案'}</span><button className="motion-button secondary" disabled={disabled} onClick={()=>onApply(effect)}>{applied?.id===effect.id&&applied.revision===effect.revision?'已应用':'应用到成片'}<ArrowUpRight size={14}/></button></div></div>
    </article>)}</div></div>}
    <h3 className="effect-personal-heading">我的动效 <small>仅当前账号可见</small></h3>
    {editing&&<div ref={editor} className="motion-panel effect-editor">
      <div className="effect-editor-heading"><h3>{selected?selected.name:'创作我的动效'}</h3><button type="button" className="motion-text-button" aria-label="收起动效编辑器" onClick={()=>setEditing(false)}><X size={18}/></button></div>
      <div className="effect-editor-grid"><div className="effect-conversation">
        <label className="motion-field"><span>动效名称</span><input aria-label="动效名称" placeholder="例如：蓝色科技总结卡" value={name} maxLength={40} disabled={busy} onChange={e=>setName(e.target.value)}/></label>
        {!!selected?.messages.length&&<div className="effect-messages" aria-label="动效创作对话">{selected.messages.map((m,i)=><div key={i} className={`effect-message ${m.role}`}><small>{m.role==='user'?'我的需求':'动效助手'}</small><p>{m.content}</p></div>)}</div>}
        {selected?.error&&<div className="motion-alert" role="alert">{selected.error}</div>}
        {(busy)&&<div className="effect-working" role="status"><Loader2 size={16} className="motion-spin"/>{uploadStatus||selected?.message||'正在处理'}</div>}
        <label className="motion-field"><span>{selected?'继续描述修改':'想做什么样的动效？'}</span><textarea aria-label="动效需求" placeholder={selected?'例如：文字再大一些，让重点词从左到右亮起来。':'例如：深蓝科技感背景，标题从下方弹入，两行总结依次出现，重点词加蓝色发光下划线。'} value={prompt} maxLength={4000} rows={5} disabled={busy} onChange={e=>setPrompt(e.target.value)}/></label>
        <p className="motion-help">应用于底部总结区，顶部标题背景同步配色。请描述颜色、排版和运动方式；上传素材默认仅供参考，需要放入画面时请明确说明。</p>
        <div className="effect-attachments">{selected?.assets.map(a=><span key={a.id}>{a.kind==='image'?'图片':'视频'} · {a.name}</span>)}{files.map((f,i)=><span key={i}>{f.name}<button aria-label={`移除素材 ${f.name}`} disabled={busy} onClick={()=>setFiles(all=>all.filter((_,j)=>i!==j))}><X size={12}/></button></span>)}</div>
        <input ref={input} hidden type="file" multiple accept=".png,.jpg,.jpeg,.webp,.mp4,.mov,.webm,.m4v" onChange={e=>{choose(e.target.files);e.target.value='';}}/>
        <div className="effect-prompt-actions"><button className="motion-text-button" disabled={busy||(files.length+(selected?.assets.length||0))>=4} onClick={()=>input.current?.click()}><Upload size={15}/>图片 / 视频</button><button className="motion-button primary" disabled={busy||!prompt.trim()} onClick={generate}><Sparkles size={15}/>{busy?'正在制作…':selected?'生成修改版':'生成动效'}</button></div>
        <small className="effect-upload-note">最多 4 个素材；图片 ≤10 MB，视频 ≤100 MB，视频取前 15 秒作为静音循环片段。</small>
      </div><div className="effect-inspector"><span className="effect-preview-title">动效预览</span>
        {selected?.previewUrl?<video key={selected.previewUrl} src={`${selected.previewUrl}#t=1`} controls playsInline preload="auto"/>:<div className="effect-empty-preview"><Sparkles size={28}/><span>你的想法，会在这里动起来</span></div>}
        <p className="motion-help">使用示例文案展示节奏；应用到成片时会替换为当前总结。</p>
        {selected?.semantics&&<p className="motion-help" role="status">{selected.semantics.required?'按内容编排图解':'直接套用，无需额外内容分析'}：{selected.semantics.reason}</p>}
        {!!selected?.revision&&<div className="effect-save-actions"><button className="motion-button secondary" disabled={busy||selected.saved} onClick={save}><Save size={15}/>{selected.saved?'已保存到动效库':'保存到动效库'}</button><button className="motion-button primary" disabled={busy||!selected.saved||disabled} onClick={()=>onApply(selected)}><ArrowUpRight size={15}/>应用到成片</button></div>}
      </div></div>
    </div>}
    <div className="effect-grid">{effects.map(effect=><article key={effect.id} className={`effect-card ${applied?.id===effect.id?'selected':''}`}>
      {effect.previewUrl?<video src={`${effect.previewUrl}#t=1`} muted playsInline preload="metadata"/>:<div className="effect-card-placeholder"><Sparkles size={24}/>{effect.status==='building'?'制作中':'等待生成'}</div>}
      <div className="effect-card-body"><div><h3>{effect.name}</h3><span>{effect.status==='building'?'制作中':effect.status==='failed'?'需重试':effect.saved?'已保存':'草稿'}</span></div><p>{effect.semantics?effect.semantics.required?'按口播内容自动编排图解':'直接套用，无需额外内容分析':effect.messages.length?effect.messages[0].content:effect.assets.length?`${effect.assets.length} 个参考素材`:'可复用的总结动效'}</p>
        <div className="effect-card-actions"><button className="motion-text-button" disabled={pending} onClick={()=>open(effect.id)}>继续编辑</button><button className="motion-button secondary" disabled={disabled||effect.status==='building'||!effect.saved||!effect.revision} onClick={()=>onApply(effect)}>{applied?.id===effect.id&&applied.revision===effect.revision?'已应用':'应用到成片'}<ArrowUpRight size={14}/></button></div>
      </div></article>)}</div>
    {!effects.length&&!editing&&<button className="effect-empty" onClick={create}><Sparkles size={25}/><strong>创作第一个专属动效</strong><span>从一句描述开始，也可以加入图片或视频素材。</span><span className="effect-empty-link">开始创作 <Plus size={13}/></span></button>}
  </section>;
}
