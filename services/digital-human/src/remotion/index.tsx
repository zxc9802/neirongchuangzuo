import React from "react";
import { Composition, registerRoot } from "remotion";
import { MotionComposition, type MotionCompositionProps } from "./MotionComposition";
import { DEFAULT_MOTION_CROP } from "../lib/motion/contract";
import {EffectComposition} from "./EffectComposition";
import {EFFECT_SAMPLE,type EffectTemplate} from '../lib/motion-library/contract';
import type {MotionScene} from '../lib/motion/contract';
const defaults: MotionCompositionProps = {sourceUrl: "", duration: 10, title: "什么是超级员工？", subtitle: "给普通人配一个超级外挂", fit: "cover", crop: DEFAULT_MOTION_CROP, captions: [], scenes: []};
function Root() {
  return <><Composition id="DigitalHumanMotion" component={MotionComposition} width={1080} height={1920} fps={30} durationInFrames={300} defaultProps={defaults} calculateMetadata={({props}) => ({durationInFrames: Math.max(1, Math.ceil(props.duration * 30))})}/><Composition id="LibraryEffect" component={EffectComposition} width={1080} height={544} fps={30} durationInFrames={180} defaultProps={{template:{compiled:"",assets:[]} as EffectTemplate,scenes:[EFFECT_SAMPLE] as MotionScene[]}} calculateMetadata={({props})=>({durationInFrames:Math.max(1,Math.ceil((props.scenes?.at(-1)?.end||6)*30))})}/></>;
}
registerRoot(Root);
