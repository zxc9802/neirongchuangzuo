"use client";
import React, {useEffect, useRef, useState} from 'react';
import type {EffectFrameProps} from '@/remotion/EffectRuntime';
let runtime: Promise<string> | undefined;
export default function SandboxEffect(props: EffectFrameProps) {
  const frame=useRef<HTMLIFrameElement>(null), current=useRef(props);
  current.current=props;
  const [html,setHtml]=useState(''), [error,setError]=useState(false);
  const [template,setTemplate]=useState<EffectFrameProps['template']>();
  useEffect(() => {
    let stopped=false;
    runtime ??= fetch('/effect-frame.js').then(r=>{if(!r.ok)throw new Error();return r.text();}).catch(e=>{runtime=undefined;throw e;});
    void runtime.then(code=>{if(!stopped)setHtml(`<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; media-src data:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"><style>body{margin:0;background:#10121a;font-family:Arial,'PingFang SC',sans-serif}#root{width:1080px;height:544px;position:relative}</style></head><body><div id="root"></div><script>${code.replace(/<\/script/gi,'<\\/script')}</script></body></html>`);}).catch(()=>{if(!stopped)setError(true);});
    return()=>{stopped=true;};
  },[]);
  useEffect(()=>{
    let stopped=false; const controller=new AbortController(); setTemplate(undefined); setError(false);
    void Promise.all(props.template.assets.map(async asset=>{
      const response=await fetch(asset.url,{signal:controller.signal}); if(!response.ok)throw new Error();
      const blob=await response.blob();
      const url=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=reject;reader.readAsDataURL(blob);});
      return {...asset,url};
    })).then(assets=>{if(!stopped)setTemplate({...props.template,assets});}).catch(()=>{if(!stopped)setError(true);});
    return()=>{stopped=true;controller.abort();};
  },[props.template]);
  useEffect(()=>{
    if(!template)return;
    const send=()=>frame.current?.contentWindow?.postMessage({type:'effect-frame',props:{...current.current,template}},'*');
    const ready=(event:MessageEvent)=>{if(event.source===frame.current?.contentWindow&&event.data?.type==='effect-ready')send();};
    window.addEventListener('message',ready);send();return()=>window.removeEventListener('message',ready);
  },[template,props.frame,props.scene,html]);
  if(error)return <div style={{padding:35,color:'#a1a1aa',fontSize:28}}>动效素材加载失败，请重新选择动效</div>;
  if(!template||!html)return <div style={{padding:35,color:'#a1a1aa',fontSize:28}}>正在加载动效预览…</div>;
  return <iframe ref={frame} title="自定义动效预览" sandbox="allow-scripts" srcDoc={html} style={{width:1080,height:544,border:0,pointerEvents:'none'}}/>;
}
