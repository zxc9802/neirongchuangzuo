import React from 'react';
import {interpolate} from 'remotion';

type Props={frame:number;fps:number;width:number;height:number;durationInFrames:number;scene:{headline:string;line1:string;line2:string;highlight:string;diagramLayout?:string}};
// Original SVG line drawings; no uploaded image or video is embedded in this template.
const icons=[
  {test:/离职|离开/,paths:['M25 87V13H63V87','M63 13L81 25V77L63 87','M48 54H95M82 41L95 54L82 67']},
  {test:/知识|经验库|资料库|学习/,paths:['M10 15Q30 6 50 20Q70 6 90 15V87Q68 77 50 91Q30 77 10 87Z','M50 20V91','M20 31Q32 27 42 35M20 46Q32 42 42 50M20 61Q32 57 42 65M59 35Q72 27 82 31M59 50Q72 42 82 46M59 65Q72 57 82 61']},
  {test:/智能|AI|ai|模型|工具/,paths:['M23 23H77V77H23Z','M33 33H67V67H33Z','M33 10V23M50 10V23M67 10V23M33 77V90M50 77V90M67 77V90M10 33H23M10 50H23M10 67H23M77 33H90M77 50H90M77 67H90','M38 59L44 40L50 59M41 51H48M57 41V59']},
  {test:/团队|新人|培训|带人/,paths:['M41 30A12 12 0 1 0 65 30A12 12 0 1 0 41 30','M28 88V66Q28 46 53 46Q78 46 78 66V88','M15 41A9 9 0 1 0 33 41A9 9 0 1 0 15 41','M9 86V65Q9 55 23 55','M77 42A8 8 0 1 0 93 42A8 8 0 1 0 77 42','M87 57Q97 58 97 69V85']},
  {test:/流程|自动|执行/,paths:['M42 8H58L62 21L74 27L88 24L96 38L86 50L88 63L97 74L87 88L72 83L60 88L55 98H39L35 85L23 79L10 82L2 68L12 56L10 43L1 32L11 18L26 23L38 18Z','M29 51A21 21 0 1 0 71 51A21 21 0 1 0 29 51','M45 39L61 51L45 63Z']},
  {test:/公司|企业|业务|专业的事/,paths:['M12 32H88V87H12Z','M35 32V18H65V32','M12 48Q50 71 88 48','M43 50H57V66H43Z']},
  {test:/员工|销冠|老板|专业的人|分身|人力|人/,paths:['M38 20A13 13 0 1 0 64 20A13 13 0 1 0 38 20','M17 89V71Q17 44 51 44Q85 44 85 71V89','M31 49L51 69L71 49M51 69V91']},
  {test:/结果|完成|落地|少出错|安全/,paths:['M22 10H65L83 28V88H22Z','M65 10V29H83','M32 42L38 49L49 34M54 43H70','M32 64L38 71L49 56M54 65H70','M63 86L75 98L97 68']},
  {test:/话术|沟通|表达|私信/,paths:['M10 18H90V73H41L20 91V73H10Z','M23 33H77M23 46H77M23 59H58']},
  {test:/.*/,paths:['M22 9H65L82 27V88H22Z','M65 9V28H82','M33 40H70M33 53H70M33 66H58','M33 96H93V36']},
];
export default function GreenDiagram({frame,fps,width,height,durationInFrames,scene}:Props) {
  const ivory='#eef2dd',yellow='#f4d83e';
  const beat=Math.max(1,Math.min(fps*.9,durationInFrames/4));
  const progress=(delay:number,length=beat*.5)=>interpolate(frame,[delay,delay+Math.max(1,length)],[0,1],{extrapolateLeft:'clamp',extrapolateRight:'clamp'});
  const texts=[scene.headline,scene.line1,scene.line2].filter(Boolean);
  const layout=texts.length===3?scene.diagramLayout||'flow':'flow';
  const last=texts.length-1;
  const mark=progress(beat*2.65,beat*.65);
  const icon=(value:string,delay:number,accent:boolean,small=false)=>{
    const drawing=icons.find(item=>item.test.test(value));
    return <svg width={small?64:94} height={small?64:94} viewBox="0 0 100 104" style={{flexShrink:0,overflow:'visible'}} fill="none" stroke={accent?yellow:ivory} strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">{drawing?.paths.map((d,i)=><path key={i} d={d} pathLength="1" strokeDasharray="1" strokeDashoffset={1-progress(delay+i*beat*.04,beat*.5)}/>)}</svg>;
  };
  const label=(value:string,accent:boolean)=>{
    const at=scene.highlight?value.indexOf(scene.highlight):-1;
    const circled=(word:string)=><span style={{position:'relative',display:'inline-block',color:yellow}}>{word}<svg viewBox="0 0 200 60" preserveAspectRatio="none" style={{position:'absolute',left:'-8%',top:'-9%',width:'116%',height:'125%',overflow:'visible'}}><ellipse cx="100" cy="30" rx="98" ry="28" fill="none" stroke={yellow} strokeWidth="2" pathLength="1" strokeDasharray="1" strokeDashoffset={1-mark}/></svg></span>;
    if(at>=0)return <span>{value.slice(0,at)}{circled(scene.highlight)}{value.slice(at+scene.highlight.length)}</span>;
    return accent&&value.length<=10?circled(value):value;
  };
  const node=(value:string,index:number,x:number,y:number,card=false,cardWidth=390)=>{
    const accent=index===last,delay=index*beat;
    const units=[...value].reduce((n,c)=>n+(/[\x00-\xff]/.test(c)?.55:1),0);
    const fontSize=card?Math.min(39,units>15?30:36):Math.min(44,units>17?32:units>10?36:44);
    return <div key={index} style={{position:'absolute',left:x-(card?cardWidth:270)/2,top:y-(card?70:104),width:card?cardWidth:270,minHeight:card?140:208,display:'flex',flexDirection:card?'row':'column',alignItems:'center',justifyContent:card?'flex-start':'center',gap:card?22:14,padding:card?'20px 22px':'0 5px',boxSizing:'border-box',border:card?`1.6px solid ${accent?yellow:'#8faa99'}`:undefined,borderRadius:card?8:0,background:card?'rgba(24,66,48,.28)':undefined,opacity:progress(delay,beat*.35),translate:`0 ${(1-progress(delay,beat*.45))*7}px`}}>
      {icon(value,delay,accent,card)}<div style={{position:'relative',flex:card?1:undefined,fontSize,lineHeight:1.32,fontWeight:800,textAlign:'center',color:accent?yellow:ivory,overflowWrap:'anywhere'}}>{label(value,accent)}{accent&&value.length>10&&!scene.highlight&&<span style={{position:'absolute',left:0,right:0,bottom:-9,height:2,background:yellow,scale:`${mark} 1`,transformOrigin:'left'}}/>}</div>
    </div>;
  };
  const arrow=(d:string,x:number,y:number,delay:number,accent=false)=><g key={d} fill="none" stroke={accent?yellow:'#ccdfcb'} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d={d} pathLength="1" strokeDasharray="1" strokeDashoffset={1-progress(delay,beat*.4)}/><path d={`M${x-9} ${y-6}L${x} ${y}L${x-9} ${y+6}`} opacity={progress(delay+beat*.28,beat*.12)}/></g>;
  const center=height/2;
  return <div style={{position:'relative',width,height,overflow:'hidden',boxSizing:'border-box',background:'radial-gradient(ellipse at 48% 42%, #1c4b39 0%, #103b2d 60%, #08291f 100%)',fontFamily:'"Noto Sans CJK SC","PingFang SC","Microsoft YaHei",sans-serif'}}>
    <div style={{position:'absolute',inset:0,border:'6px solid #af914e',boxShadow:'inset 0 0 0 2px #dfc477',boxSizing:'border-box'}}/><div style={{position:'absolute',inset:6,border:'1px solid #776536'}}/>
    <svg width={width} height={height} style={{position:'absolute',inset:0}}>
      {layout==='flow'&&(texts.length===3?<g>{arrow(`M337 ${center}H385`,385,center,beat*.55)}{arrow(`M697 ${center}H745`,745,center,beat*1.55)}</g>:arrow(`M457 ${center}H615`,615,center,beat*.55))}
      {layout==='branch'&&<g>{arrow(`M350 ${center}H424Q444 ${center} 444 ${center-20}V175Q444 160 462 160H535`,535,160,beat*.55)}{arrow(`M444 ${center}V369Q444 384 462 384H535`,535,384,beat*1.55,true)}</g>}
      {layout==='merge'&&<g>{arrow('M475 160H513Q533 160 533 180V252Q533 272 553 272H714',714,272,beat*.55)}{arrow('M475 384H513Q533 384 533 364V292Q533 272 553 272H714',714,272,beat*1.55,true)}</g>}
      {layout==='equation'&&<g fill={yellow} fontSize="48" fontWeight="700" textAnchor="middle"><text x="365" y={center+12} opacity={progress(beat*.55)}>+</text><text x="715" y={center+12} opacity={progress(beat*1.55)}>=</text></g>}
    </svg>
    {(layout==='flow'||layout==='equation')&&texts.map((value,i)=>node(value,i,texts.length===3?190+i*350:310+i*460,center))}
    {layout==='branch'&&<div>{node(texts[0],0,205,center)}{node(texts[1],1,770,160,true,420)}{node(texts[2],2,770,384,true,420)}</div>}
    {layout==='merge'&&<div>{node(texts[0],0,270,160,true)}{node(texts[1],1,270,384,true)}{node(texts[2],2,860,center)}</div>}
  </div>;
}
