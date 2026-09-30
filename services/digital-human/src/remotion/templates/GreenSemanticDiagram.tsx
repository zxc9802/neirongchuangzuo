import React from 'react';
import {Diagram} from '@motion';

export default function GreenSemanticDiagram({width,height,scene}: {width:number;height:number;scene:{visual?:React.ComponentProps<typeof Diagram>['plan'];headline:string}}) {
  return <div style={{position:'relative',width,height,overflow:'hidden',boxSizing:'border-box',background:'radial-gradient(ellipse at 48% 42%, #1c4b39 0%, #103b2d 60%, #08291f 100%)',fontFamily:'"Noto Sans CJK SC","PingFang SC","Microsoft YaHei",sans-serif'}}>
    <div style={{position:'absolute',inset:0,border:'6px solid #af914e',boxShadow:'inset 0 0 0 2px #dfc477',boxSizing:'border-box'}}/>
    <div style={{position:'absolute',inset:6,border:'1px solid #776536'}}/>
    {scene.visual?<Diagram plan={scene.visual} color="#eef2dd" accent="#f4d83e"/>:<div style={{position:'absolute',inset:50,display:'flex',alignItems:'center',justifyContent:'center',textAlign:'center',fontSize:44,color:'#eef2dd'}}>{scene.headline}</div>}
  </div>;
}
