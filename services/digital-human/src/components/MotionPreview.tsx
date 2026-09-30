"use client";
import React from "react";
import { Player } from "@remotion/player";
import { MotionComposition, type MotionCompositionProps } from "@/remotion/MotionComposition";
export default function MotionPreview(props: MotionCompositionProps) {
  return <Player component={MotionComposition} inputProps={props} compositionWidth={1080} compositionHeight={1920}
    durationInFrames={Math.max(1, Math.ceil(props.duration * 30))} fps={30} controls clickToPlay
    style={{width: "100%", aspectRatio: "9 / 16", borderRadius: 12, overflow: "hidden"}}
    errorFallback={() => <div className="motion-player-error">视频预览加载失败，请刷新后重试</div>}/>;
}
