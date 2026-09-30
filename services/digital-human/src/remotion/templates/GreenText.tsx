import React from 'react';
import {interpolate} from 'remotion';

type Props = {frame:number; fps:number; width:number; height:number; durationInFrames:number; scene:{headline:string; line1:string; line2:string; highlight:string}};
export default function GreenText({frame,fps,width,height,durationInFrames,scene}:Props) {
  const yellow='#f6da39';
  const beat=Math.min(fps*.3,durationInFrames/6);
  const enter=(delay:number)=>interpolate(frame,[delay,delay+Math.max(1,beat)],[0,1],{extrapolateLeft:'clamp',extrapolateRight:'clamp'});
  const size=(value:string,preferred:number)=>Math.min(preferred,(width-120)/Math.max(1,[...value].reduce((n,c)=>n+(/[\x00-\xff]/.test(c)?.58:1),0)));
  const content=(value:string)=>{
    const at=scene.highlight?value.indexOf(scene.highlight):-1;
    if(at<0)return value;
    return <span>{value.slice(0,at)}<span style={{color:yellow,position:'relative',display:'inline-block'}}>{scene.highlight}<span style={{position:'absolute',bottom:-7,left:0,right:0,height:3,background:yellow,scale:`${enter(beat*2.5)} 1`,transformOrigin:'left'}}/></span>{value.slice(at+scene.highlight.length)}</span>;
  };
  return <div style={{width,height,position:'relative',overflow:'hidden',boxSizing:'border-box',background:'radial-gradient(ellipse at 50% 40%, #235b3c 0%, #123c2a 60%, #09241b 100%)',fontFamily:'"Noto Sans CJK SC","PingFang SC","Microsoft YaHei",sans-serif'}}>
    <div style={{position:'absolute',inset:0,borderTop:'8px solid #cfa854',boxShadow:'inset 0 3px 0 #f2d494'}}/>
    <div style={{position:'absolute',inset:'12px 7px 0',borderLeft:'5px double #cfa854',borderRight:'5px double #cfa854'}}/>
    <div style={{position:'absolute',inset:'42px 60px 35px',display:'flex',flexDirection:'column',justifyContent:'center',textAlign:'center',color:'#fafbed'}}>
      <div style={{fontSize:size(scene.headline,68),lineHeight:1.3,fontWeight:900,color:yellow,opacity:enter(0),translate:`0 ${(1-enter(0))*22}px`,marginBottom:30}}>{scene.headline}</div>
      {[scene.line1,scene.line2].map((line,i)=>line&&<div key={i} style={{marginTop:i?18:0,whiteSpace:'nowrap',fontSize:size(line,56),lineHeight:1.4,fontWeight:800,opacity:enter(beat*(i+1)),translate:`0 ${(1-enter(beat*(i+1)))*20}px`}}>{content(line)}</div>)}
    </div>
  </div>;
}
