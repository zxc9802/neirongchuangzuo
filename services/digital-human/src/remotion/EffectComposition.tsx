import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {EffectRuntime} from './EffectRuntime';
import {EFFECT_SAMPLE, type EffectTemplate} from '../lib/motion-library/contract';
import type {MotionScene} from '../lib/motion/contract';
export function EffectComposition({template,scenes=[EFFECT_SAMPLE]}: {template:EffectTemplate;scenes?:MotionScene[]}) {
  const frame=useCurrentFrame(),{fps}=useVideoConfig();
  const scene=scenes.find(s=>frame/fps>=s.start&&frame/fps<s.end);
  return <AbsoluteFill style={{background:'#10121a',fontFamily:'"Noto Sans CJK SC","PingFang SC",sans-serif'}}>{scene&&<EffectRuntime template={template} scene={scene} frame={frame-Math.round(scene.start*fps)} fps={fps}/>}</AbsoluteFill>;
}
