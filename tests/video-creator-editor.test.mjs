import test from 'node:test';
import assert from 'node:assert/strict';
import { promptMarkup, readPromptEditor, directorDocument, mediaUrl, encodeWav } from '../design/video-creator-ui.js';

test('reference rendering preserves planned order and does not substitute inside link attributes', () => {
  const assets = [{ id:'second',type:'image',name:'食品',url:'/food.jpg' }, {id:'first',type:'image',name:'门店',url:'/store.jpg'}];
  const html = promptMarkup('## 运镜\n@图片1，接着看@图片2。\n[素材](https://example.com/@图片1)', assets);
  assert.match(html, /<h2>运镜<\/h2>/);
  assert.match(html, /data-id="second" data-token="@图片1"/);
  assert.match(html, /data-id="first" data-token="@图片2"/);
  assert.match(html, /href="https:\/\/example.com\/@%E5%9B%BE%E7%89%871"/);
});

test('model markup and stored media cannot inject executable HTML', () => {
  const html = promptMarkup('<script>alert(1)</script>\n[click](javascript:alert(1))\n@图片1', [{id:'" onclick="alert(1)',type:'image',url:'javascript:alert(1)'}]);
  assert.doesNotMatch(html, /<script>|href="javascript:|src="javascript:|data-id="" onclick=/);
  assert.match(html, /&lt;script&gt;/);
  for (const url of ['javascript:alert(1)', '//evil.example', '/\\evil.example', '/photo\n.jpg', 'data:text/html,<script>']) assert.equal(mediaUrl(url),'');
  assert.equal(mediaUrl('/api/video-creator/conversations/id/assets/id'),'/api/video-creator/conversations/id/assets/id');
});

const text = value => ({nodeType:3,nodeValue:value});
const element = (tagName, children, dataset={}) => ({nodeType:1,tagName,childNodes:children,dataset});
test('editing a rich prompt retains headings, reference tokens and paragraph boundaries', () => {
  const root={childNodes:[element('H2',[text('全片设定')]),element('P',[text('看这里'),element('BUTTON',[text('忽略缩略图文字')],{token:'@图片2'}),text('，保持门头。')]),element('UL',[element('LI',[text('不要新增菜品')])])]};
  assert.equal(readPromptEditor(root),'## 全片设定\n\n看这里@图片2，保持门头。\n- 不要新增菜品');
});

test('document presentation retains source facts, audio, continuity and every shot', () => {
  const result={script:{title:'门店介绍',summary:'只用真实素材',plan:{objective:'到店坐坐',cast:[{name:'店主',role:'介绍',appearance:'白衣'}],audio:{music:'轻音乐'},keep:['原店'],avoid:['虚构优惠']},shots:[{start:0,end:3,visual:'门头',referenceIds:['store']},{start:3,end:8,visual:'食品',referenceIds:['food'],voiceover:'欢迎来坐坐'}]},assets:[{id:'store',role:'入口',adopt:'真实招牌'}]};
  const doc=directorDocument(result,[{id:'store',type:'image'},{id:'food',type:'image'}]);
  for(const phrase of ['到店坐坐','店主','白衣','轻音乐','原店','虚构优惠','0—3s','3—8s','@图片1','@图片2','欢迎来坐坐','真实招牌']) assert.ok(doc.includes(phrase),phrase);
});

test('browser recordings become a valid PCM WAV and clamp sample amplitude', async () => {
  const blob=encodeWav({numberOfChannels:1,length:3,sampleRate:16000,getChannelData:()=>new Float32Array([-2,0,2])});
  const bytes=await blob.arrayBuffer(),view=new DataView(bytes);
  assert.equal(blob.type,'audio/wav');assert.equal(bytes.byteLength,50);
  assert.equal(new TextDecoder().decode(bytes.slice(0,4)),'RIFF');
  assert.equal(view.getUint32(24,true),16000);assert.equal(view.getInt16(44,true),-32768);assert.equal(view.getInt16(48,true),32767);
});
