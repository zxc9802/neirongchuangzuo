import React from 'react';
import {interpolate} from 'remotion';
import type {VisualPlan} from '../lib/motion-library/visual';

const drawings = {
  person: ['M38 22a13 13 0 1 0 26 0a13 13 0 1 0-26 0', 'M17 90V70q0-26 34-26t34 26v20'],
  team: ['M40 27a12 12 0 1 0 24 0a12 12 0 1 0-24 0', 'M28 90V68q0-24 24-24t24 24v22', 'M12 37a9 9 0 1 0 18 0a9 9 0 1 0-18 0', 'M6 85V66q0-13 17-13M78 29a9 9 0 1 0 18 0a9 9 0 1 0-18 0M85 51q13 0 13 15v19'],
  book: ['M10 17q20-10 40 4q20-14 40-4v70q-20-10-40 4q-20-14-40-4Z', 'M50 21v70M20 36l20 4M20 52l20 4M60 40l20-4M60 56l20-4'],
  chip: ['M23 23h54v54H23Z', 'M35 35h30v30H35Z', 'M33 10v13M50 10v13M67 10v13M33 77v13M50 77v13M67 77v13M10 33h13M10 50h13M10 67h13M77 33h13M77 50h13M77 67h13'],
  gear: ['M40 8h20l4 14l14 8l14-2l8 17l-12 12v16L76 88l-16-4l-10 12l-12-12l-16 4L8 73V57L0 45l8-17l14 2l14-8Z', 'M30 52a20 20 0 1 0 40 0a20 20 0 1 0-40 0'],
  company: ['M12 32h76v55H12Z', 'M35 32V18h30v14M12 48q38 30 76 0M43 50h14v16H43Z'],
  check: ['M20 10h48l15 18v60H20Z', 'M68 10v18h15M32 54l15 15l27-31'],
  chat: ['M10 18h80v55H41L20 91V73H10Z', 'M23 33h54M23 46h54M23 59h35'],
  document: ['M22 9h43l17 18v61H22Z', 'M65 9v19h17M33 40h37M33 53h37M33 66h25'],
  chart: ['M12 10v78h78', 'M25 76V58h12v18M47 76V42h12v34M69 76V25h12v51', 'M20 40l25-18l17 7L85 9'],
  money: ['M10 50a40 40 0 1 0 80 0a40 40 0 1 0-80 0', 'M34 27l16 19l16-19M50 46v30M31 48h38M31 61h38'],
  none: [],
};
export function SemanticDiagram({plan, frame, fps, durationInFrames, color = '#eef2dd', accent = '#f4d83e'}: {
  plan?: VisualPlan; frame: number; fps: number; durationInFrames: number; color?: string; accent?: string;
}) {
  if (!plan) return null;
  const count = plan.nodes.length, beat = Math.max(1, Math.min(fps * .65, durationInFrames / (count + 1)));
  const enter = (delay: number) => interpolate(frame, [delay, delay + beat * .65], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const branching = plan.layout === 'branch', merging = plan.layout === 'merge';
  const verticalY = (i: number) => 130 + (i * 284 / Math.max(1, count - 2));
  const positions = plan.nodes.map((_, i) => branching ? (i === 0 ? {x: 240, y: 272} : {x: 790, y: verticalY(i - 1)}) :
    merging ? (i === count - 1 ? {x: 840, y: 272} : {x: 290, y: verticalY(i)}) : {x: (i + .5) * 980 / count + 50, y: 272});
  const connections = plan.layout === 'flow' ? positions.slice(1).map((to, i) => ({from: positions[i], to, delay: beat * (i + .5)})) :
    branching ? positions.slice(1).map((to, i) => ({from: positions[0], to, delay: beat * (i + .5)})) :
      merging ? positions.slice(0, -1).map((from, i) => ({from, to: positions[count - 1], delay: beat * (i + .5)})) : [];
  return <div style={{position: 'absolute', inset: 0, width: 1080, height: 544, color, fontFamily: '"Noto Sans CJK SC","PingFang SC",sans-serif'}}>
    <svg width="1080" height="544" style={{position: 'absolute', inset: 0}}>
      {connections.map(({from, to, delay}, i) => {
        const x1 = from.x + (branching || merging ? 175 : 95), x2 = to.x - (branching || merging ? 175 : 95);
        return <g key={i} fill="none" stroke={color} strokeWidth="2.5"><path d={`M${x1} ${from.y}C${(x1 + x2) / 2} ${from.y} ${(x1 + x2) / 2} ${to.y} ${x2} ${to.y}`} pathLength="1" strokeDasharray="1" strokeDashoffset={1 - enter(delay)}/><path d={`M${x2 - 9} ${to.y - 6}L${x2} ${to.y}L${x2 - 9} ${to.y + 6}`} opacity={enter(delay + beat * .3)}/></g>;
      })}
      {plan.layout === 'equation' && positions.slice(1).map((p, i) => <text key={i} x={(positions[i].x + p.x) / 2} y="280" fill={accent} fontSize="35" textAnchor="middle" opacity={enter(beat * (i + .5))}>{i === count - 2 ? '=' : '+'}</text>)}
    </svg>
    {plan.nodes.map((node, i) => {
      const compact = branching && i > 0 || merging && i < count - 1;
      const p = positions[i], width = compact ? 340 : branching || merging ? 280 : Math.min(250, 900 / count), ink = node.emphasis ? accent : color;
      const fontSize = count === 4 ? 29 : 34, opacity = enter(i * beat);
      return <div key={i} style={{position: 'absolute', left: p.x - width / 2, top: p.y - (compact ? 40 : 72), width, display: 'flex', flexDirection: compact ? 'row' : 'column', alignItems: 'center', gap: 12, textAlign: 'center', opacity, translate: `0 ${(1 - opacity) * 8}px`}}>
        {node.icon !== 'none' && <svg viewBox="0 0 104 104" width="72" height="72" style={{flexShrink: 0}} fill="none" stroke={ink} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">{drawings[node.icon].map((d, j) => <path key={j} d={d} pathLength="1" strokeDasharray="1" strokeDashoffset={1 - enter(i * beat + j * beat * .08)}/>)}</svg>}
        <div style={{fontSize, fontWeight: 800, lineHeight: 1.32, color: ink, overflowWrap: 'anywhere', flex: compact ? 1 : undefined, width: compact ? undefined : '100%'}}>{node.label}
          {node.emphasis && <div style={{height: 2, background: accent, margin: '12px 20px 0', scale: `${enter((count - .5) * beat)} 1`, transformOrigin: 'left'}}/>}
        </div>
      </div>;
    })}
  </div>;
}
