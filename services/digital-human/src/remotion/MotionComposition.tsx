import React from "react";
import { AbsoluteFill, Sequence, OffthreadVideo, Video, getRemotionEnvironment, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { MotionEdit, MotionScene } from "../lib/motion/contract";
import { MOTION_LAYOUT } from "../lib/motion/contract";
import { motionVideoStyle } from "../lib/motion/crop";
import { MotionCaptions } from "./MotionCaptions";

import type {EffectTemplate} from "../lib/motion-library/contract";
import {EffectRuntime} from "./EffectRuntime";
import SandboxEffect from "../components/SandboxEffect";

export type MotionCompositionProps = MotionEdit & Record<string, unknown> & { sourceUrl: string; duration: number; effectTemplate?: EffectTemplate };
const font = '"Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif';
const yellow = "#f6da39";
const green = "radial-gradient(ellipse at 50% 40%, #235b3c 0%, #123c2a 60%, #09241b 100%)";
function fittedSize(text: string, preferred: number, width = 948) {
  const units = [...text].reduce((n, c) => n + (/[\x00-\xff]/.test(c) ? 0.61 : 1), 0);
  return Math.min(preferred, width / Math.max(1, units));
}
function Header({title, subtitle, backgroundColor}: Pick<MotionEdit, "title" | "subtitle"> & {backgroundColor?: string}) {
  return <div style={{height: MOTION_LAYOUT.top, background: backgroundColor ? `radial-gradient(ellipse at 50% 65%, ${backgroundColor}, #050b18)` : green, paddingTop: 202, boxSizing: "border-box"}}>
    <svg width="1080" height="128" viewBox="0 0 1080 128" style={{overflow: "visible"}}>
      <defs><pattern id="title-dots" width="7" height="7" patternUnits="userSpaceOnUse"><rect width="7" height="7" fill={yellow}/><circle cx="2" cy="2" r="1.1" fill="#ba9635"/></pattern></defs>
      {[{stroke: "#fffbee", width: 17, fill: yellow}, {stroke: "#101510", width: 10, fill: yellow}, {stroke: yellow, width: 1, fill: "url(#title-dots)"}].map((layer, i) =>
        <text key={i} x="540" y="98" textAnchor="middle" fontFamily={font} fontWeight="900" fontSize={fittedSize(title, 90)} stroke={layer.stroke} strokeWidth={layer.width} strokeLinejoin="round" paintOrder="stroke" fill={layer.fill}>{title}</text>)}
    </svg>
    <svg width="1080" height="114" viewBox="0 0 1080 114"><text x="540" y="78" textAnchor="middle" fontFamily={font} fontWeight="900" fontSize={fittedSize(subtitle, 80)} stroke="#070b08" strokeWidth="13" strokeLinejoin="round" paintOrder="stroke" fill="white">{subtitle}</text></svg>
  </div>;
}
function Highlight({text, word, reveal}: {text: string; word: string; reveal: number}) {
  const index = word ? text.indexOf(word) : -1;
  if (index < 0) return <>{text}</>;
  return <>{text.slice(0, index)}<span style={{color: yellow, position: "relative", display: "inline-block"}}>{word}<span style={{position: "absolute", bottom: -7, left: 0, right: 0, height: 3, background: yellow, transform: `scaleX(${reveal})`, transformOrigin: "left"}}/></span>{text.slice(index + word.length)}</>;
}
function Summary({scene, frame, fps}: {scene: MotionScene; frame: number; fps: number}) {
  const elapsed = frame - Math.round(scene.start * fps);
  const enter = (delay: number) => interpolate(elapsed, [delay, delay + 12], [0, 1], {extrapolateLeft: "clamp", extrapolateRight: "clamp"});
  const duration = (scene.end - scene.start) * fps;
  const delay = Math.min(8, Math.max(0, duration / 6));
  return <div style={{textAlign: "center", padding: "24px 60px", color: "#fafbed"}}>
    <div style={{fontSize: fittedSize(scene.headline, 68), lineHeight: 1.3, fontWeight: 900, color: yellow, opacity: enter(0), transform: `translateY(${(1-enter(0))*22}px)`}}>{scene.headline}</div>
    {[scene.line1, scene.line2].map((line, i) => line && <div key={i} style={{marginTop: i === 0 ? 34 : 18, whiteSpace: "nowrap", fontSize: fittedSize(line, 56, 950), lineHeight: 1.4, fontWeight: 800, opacity: enter(delay * (i+1)), transform: `translateY(${(1-enter(delay * (i+1)))*20}px)`}}><Highlight text={line} word={scene.highlight} reveal={enter(delay * 2 + 4)}/></div>)}
  </div>;
}
export function MotionComposition(props: MotionCompositionProps) {
  const frame = useCurrentFrame(); const {fps} = useVideoConfig(); const time = frame / fps;
  const scene = props.scenes.find(s => time >= s.start && time < s.end);
  const videoStyle = motionVideoStyle(props.fit, props.crop);
  return <AbsoluteFill style={{fontFamily: font, background: "#102e22", color: "white"}}>
    <Header title={props.title} subtitle={props.subtitle} backgroundColor={props.effectTemplate?.backgroundColor}/>
    <div style={{height: MOTION_LAYOUT.speaker, position: "relative", overflow: "hidden", background: "#101511"}}>
      {props.sourceUrl && (getRemotionEnvironment().isRendering && !props.effectTemplate ? <OffthreadVideo src={props.sourceUrl} muted style={videoStyle}/> : <Video src={props.sourceUrl} muted={getRemotionEnvironment().isRendering} style={videoStyle}/>)}
      {!props.sourceUrl && <AbsoluteFill style={{alignItems: "center", justifyContent: "center", color: "#6d8378", fontSize: 38}}>上传最终剪辑版后预览</AbsoluteFill>}
      <MotionCaptions captions={props.captions} time={time}/>
    </div>
    {props.effectTemplate ? <div style={{height:MOTION_LAYOUT.bottom,position:"relative",overflow:"hidden",background:"#10121a"}}>
      {scene && (getRemotionEnvironment().isRendering ? <Sequence from={Math.round(scene.start*fps)} layout="none"><EffectRuntime template={props.effectTemplate} scene={scene} frame={frame-Math.round(scene.start*fps)} fps={fps}/></Sequence> : <SandboxEffect template={props.effectTemplate} scene={scene} frame={frame-Math.round(scene.start*fps)} fps={fps}/>)}
    </div> : <div style={{height: MOTION_LAYOUT.bottom, position: "relative", background: green, borderTop: "9px solid #cfa854", boxSizing: "border-box", boxShadow: "inset 0 3px 0 #f2d494"}}>
      <div style={{position: "absolute", inset: "8px 8px 0", borderLeft: "5px double #cfa854", borderRight: "5px double #cfa854"}}/>
      {scene && <Summary scene={scene} frame={frame} fps={fps}/>}
    </div>}
  </AbsoluteFill>;
}
