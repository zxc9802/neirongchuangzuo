import {SemanticDiagram} from './SemanticDiagram';
import type {VisualPlan} from '../lib/motion-library/visual';
import React, {createContext, useContext, useEffect, useMemo, useRef} from 'react';
import {interpolate, spring, Easing, random, Video, Loop, getRemotionEnvironment} from 'remotion';
import type {EffectTemplate, EffectAsset} from '../lib/motion-library/contract';
import type {MotionScene} from '../lib/motion/contract';
export interface EffectFrameProps {template: EffectTemplate; scene: MotionScene; frame: number; fps: number}
const FrameContext=createContext({frame:0,fps:30,durationInFrames:180});
function Asset({asset,style}: {asset?:EffectAsset;style?:React.CSSProperties}) {
  const {frame,fps}=useContext(FrameContext), video=useRef<HTMLVideoElement>(null);
  const time=asset?.duration ? (frame/fps)%asset.duration : 0;
  useEffect(()=>{if(video.current&&Math.abs(video.current.currentTime-time)>.04)video.current.currentTime=time;},[time]);
  if(!asset)return null;
  if(asset.kind==='image')return <img src={asset.url} style={style}/>;
  if(getRemotionEnvironment().isRendering)return <Loop durationInFrames={Math.max(1,Math.floor(asset.duration*fps))} layout="none"><Video src={asset.url} muted style={style}/></Loop>;
  return <video ref={video} src={asset.url} muted playsInline preload="auto" style={style} onLoadedData={e=>{e.currentTarget.currentTime=time;}}/>;
}
function Diagram({plan,color,accent}: {plan?:VisualPlan;color?:string;accent?:string}) {
  return <SemanticDiagram {...useContext(FrameContext)} plan={plan} color={color} accent={accent}/>;
}
export function EffectRuntime({template, scene, frame, fps}: EffectFrameProps) {
  const Component = useMemo(() => {
    const module = {exports: {} as {default?: React.ComponentType<any>}};
    const require = (name: string) => {
      if (name === 'react') return React;
      if (name === '@motion') return {Asset,Diagram};
      if (name === 'remotion') return {interpolate, spring, Easing, random};
      throw new Error('不支持的动效依赖');
    };
    // Only mounted in an opaque sandbox iframe or the isolated render browser.
    new Function('require', 'module', 'exports', template.compiled)(require, module, module.exports);
    if (typeof module.exports.default !== 'function') throw new Error('动效组件无效');
    return module.exports.default;
  }, [template.compiled]);
  return <FrameContext.Provider value={{frame,fps,durationInFrames:Math.max(1, Math.round((scene.end-scene.start)*fps))}}><div style={{position:'absolute', inset:0, overflow:'hidden', width:1080, height:544}}><Component frame={frame} fps={fps} width={1080} height={544} durationInFrames={Math.max(1, Math.round((scene.end-scene.start)*fps))} scene={scene} assets={template.assets}/></div></FrameContext.Provider>;
}
