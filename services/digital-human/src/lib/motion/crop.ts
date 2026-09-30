import type { CSSProperties } from "react";
import { DEFAULT_MOTION_CROP, type MotionCrop, type MotionEdit } from "./contract";

// The editor, Remotion Player and exported video all use this exact transform.
export function motionVideoStyle(fit: MotionEdit["fit"], crop = DEFAULT_MOTION_CROP): CSSProperties {
  const position = fit === "cover" ? `${crop.x * 100}% ${crop.y * 100}%` : "50% 50%";
  return {width: "100%", height: "100%", objectFit: fit, objectPosition: position,
    transform: `scale(${fit === "cover" ? crop.zoom : 1})`, transformOrigin: position};
}

export function cropOverflow(sourceWidth: number, sourceHeight: number, width: number, height: number, zoom: number) {
  const scale = Math.max(width / sourceWidth, height / sourceHeight) * zoom;
  return {x: Math.max(0, sourceWidth * scale - width), y: Math.max(0, sourceHeight * scale - height)};
}

export function panMotionCrop(crop: MotionCrop, dx: number, dy: number, overflow: {x: number; y: number}): MotionCrop {
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  return {...crop, x: overflow.x > 0.01 ? clamp(crop.x - dx / overflow.x) : crop.x,
    y: overflow.y > 0.01 ? clamp(crop.y - dy / overflow.y) : crop.y};
}
