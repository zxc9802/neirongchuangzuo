"use client";
import React, {useRef, useState} from "react";
import {Move, RotateCcw} from "lucide-react";
import {DEFAULT_MOTION_CROP, MOTION_LAYOUT, type MotionCrop} from "@/lib/motion/contract";
import {cropOverflow, motionVideoStyle, panMotionCrop} from "@/lib/motion/crop";

export default function MotionCropEditor({sourceUrl, crop, disabled, onChange}: {
  sourceUrl: string; crop: MotionCrop; disabled: boolean; onChange: (crop: MotionCrop) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{id: number; x: number; y: number; crop: MotionCrop; overflow: {x: number; y: number}} | null>(null);
  const [media, setMedia] = useState({width: 0, height: 0, duration: 0});
  const [time, setTime] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const unavailable = disabled || !media.width || error;
  const overflow = () => {
    const box = viewport.current!.getBoundingClientRect();
    return cropOverflow(media.width, media.height, box.width, box.height, crop.zoom);
  };
  function startDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (unavailable || event.button !== 0) return;
    event.preventDefault(); event.currentTarget.focus({preventScroll: true});
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {id: event.pointerId, x: event.clientX, y: event.clientY, crop: {...crop}, overflow: overflow()};
  }
  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
  }
  function nudge(event: React.KeyboardEvent<HTMLDivElement>) {
    if (unavailable) return;
    const directions: Record<string, [number, number]> = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]};
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault();
    const step = event.shiftKey ? 20 : 5;
    onChange(panMotionCrop(crop, direction[0] * step, direction[1] * step, overflow()));
  }
  return <div className="motion-crop-editor">
    <div className="motion-crop-heading"><span><Move size={14}/>选择中间保留画面</span><button type="button" className="motion-text-button" disabled={unavailable} onClick={() => onChange({...DEFAULT_MOTION_CROP})}><RotateCcw size={13}/>重置裁剪</button></div>
    <p className="motion-help">拖动画面调整位置，缩放选择范围。框内就是成片中间的人物区域。</p>
    <div ref={viewport} className="motion-crop-viewport" role="group" aria-label="裁剪画面，拖动或使用方向键调整位置" aria-disabled={Boolean(unavailable)} tabIndex={unavailable ? -1 : 0}
      style={{aspectRatio: `${MOTION_LAYOUT.width} / ${MOTION_LAYOUT.speaker}`}}
      onPointerDown={startDrag} onPointerMove={event => {const start = drag.current; if (!unavailable && start?.id === event.pointerId) onChange(panMotionCrop(start.crop, event.clientX - start.x, event.clientY - start.y, start.overflow));}}
      onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={() => {drag.current = null;}} onKeyDown={nudge}>
      {/* Explicitly request a first frame for browsers that leave paused media unpainted. */}
      <video ref={video} src={`${sourceUrl}#t=0.001`} preload="auto" muted playsInline style={motionVideoStyle("cover", crop)}
        onLoadStart={() => {setLoading(true); setError(false); setTime(0);}}
        onLoadedMetadata={event => {const v = event.currentTarget; setMedia({width: v.videoWidth, height: v.videoHeight, duration: v.duration}); setError(false);}}
        onLoadedData={() => setLoading(false)} onSeeking={() => setLoading(true)} onSeeked={() => setLoading(false)}
        onTimeUpdate={event => setTime(event.currentTarget.currentTime)} onError={() => {setError(true); setLoading(false);}}/>
      <div className="motion-crop-grid" aria-hidden="true"/>
      {loading && !error && <span className="motion-crop-loading" role="status">正在载入视频画面…</span>}
      {error && <span className="motion-crop-loading" role="alert">画面加载失败，请点击下方“重新加载画面”</span>}
      <span className="motion-crop-label" aria-hidden="true">中间保留区域</span>
    </div>
    <label className="motion-crop-control"><span>画面缩放</span><input aria-label="画面缩放" type="range" min={1} max={3} step={0.01} value={crop.zoom} disabled={unavailable} onChange={event => onChange({...crop, zoom: Number(event.target.value)})}/><output>{Math.round(crop.zoom * 100)}%</output></label>
    <label className="motion-crop-control"><span>预览时间</span><input aria-label="裁剪预览时间" aria-describedby="motion-crop-time-help" type="range" min={0} max={Math.max(0, media.duration - 0.05)} step={0.1} value={time} disabled={unavailable} onChange={event => {const next = Number(event.target.value); setTime(next); if (video.current) video.current.currentTime = next;}}/><output>{time.toFixed(1)} 秒</output></label>
    <small id="motion-crop-time-help" className="motion-crop-help">拖动查看不同时间的画面，确认人物在框内；不会改变视频时长。</small>
    <small className="motion-crop-help">可用方向键微调；同一裁剪范围应用于整条视频。</small>
    <button type="button" className="motion-text-button" disabled={disabled} onClick={() => video.current?.load()}><RotateCcw size={13}/>重新加载画面</button>
  </div>;
}
