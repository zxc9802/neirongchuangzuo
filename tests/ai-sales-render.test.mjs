import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { renderSalesMaterials, setSalesHtml } from '../design/ai-sales-render.js';

const options = { locked:false, expiredLabel:'文件已过期', deleteLabel:'删除' };
const assets = [
  {id:'photo',type:'image',name:'照片 & "原图"',url:'/photo.jpg',expired:false},
  {id:'voice',type:'audio',name:'声音.wav',url:'/voice.wav',expired:false},
];
function fixture() { return parseHTML('<main><div id="materials"></div></main>').document; }

test('polling, typing, rename and locking preserve media nodes and playback state', () => {
  const doc=fixture(), root=doc.querySelector('#materials');
  renderSalesMaterials(root,assets,options);
  const image=root.querySelector('img'), audio=root.querySelector('audio');
  audio.currentTime=7;
  for(let i=0;i<10;i++) renderSalesMaterials(root,structuredClone(assets),options);
  renderSalesMaterials(root,[{...assets[0],name:'新名称'},assets[1]],{...options,locked:true});
  assert.equal(root.querySelector('img'),image);
  assert.equal(root.querySelector('audio'),audio);
  assert.equal(audio.currentTime,7);
  assert.equal(image.alt,'新名称');
  assert.equal(root.querySelectorAll('button').length,0);
  renderSalesMaterials(root,assets,options);
  assert.equal(root.querySelector('audio'),audio);
  assert.equal(root.querySelectorAll('button').length,2);
});

test('adding and deleting materials preserves remaining media; expiry removes only affected source', () => {
  const doc=fixture(),root=doc.querySelector('#materials');
  renderSalesMaterials(root,assets,options);
  const audio=root.querySelector('audio');
  const extra={...assets[0],id:'extra',url:'/extra.jpg'};
  renderSalesMaterials(root,[...assets,extra],options);
  const extraImage=root.lastChild.querySelector('img');
  renderSalesMaterials(root,[assets[1],extra],options);
  assert.equal(root.querySelector('audio'),audio);
  assert.equal(root.querySelector('img'),extraImage);
  renderSalesMaterials(root,[{...assets[1],expired:true,url:null},extra],options);
  assert.equal(root.querySelector('audio'),null);
  assert.match(root.firstChild.textContent,/文件已过期/);
  assert.equal(root.querySelector('img'),extraImage);
  renderSalesMaterials(root,[],options);
  assert.equal(root.children.length,0);
});

test('stable HTML ignores browser serialization and still renders changes and remounts', () => {
  const doc=fixture();
  const html='<audio controls preload="metadata"></audio>';
  setSalesHtml(doc,'#materials',html);
  const audio=doc.querySelector('audio');
  audio.setAttribute('controls','');
  setSalesHtml(doc,'#materials',html);
  assert.equal(doc.querySelector('audio'),audio);
  setSalesHtml(doc,'#materials','<p>新脚本</p>');
  assert.equal(doc.querySelector('audio'),null);
  doc.querySelector('main').innerHTML='<div id="materials"></div>';
  setSalesHtml(doc,'#materials',html);
  assert.ok(doc.querySelector('audio'));
});
