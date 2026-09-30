import React from 'react';
import {createRoot} from 'react-dom/client';
import {EffectRuntime, type EffectFrameProps} from './EffectRuntime';
const root = createRoot(document.getElementById('root')!);
class Boundary extends React.Component<React.PropsWithChildren, {error:boolean}> {
  state={error:false};
  static getDerivedStateFromError(){return {error:true};}
  render(){return this.state.error ? <div style={{color:'#a1a1aa',padding:30,fontSize:28}}>动效预览暂不可用，请重新生成</div> : this.props.children;}
}
window.addEventListener('message', event => {
  if (event.source !== window.parent || event.data?.type !== 'effect-frame') return;
  const props=event.data.props as EffectFrameProps;
  root.render(<Boundary key={props.template.compiled}><EffectRuntime {...props}/></Boundary>);
});
window.parent.postMessage({type:'effect-ready'}, '*');
