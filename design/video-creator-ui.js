import { renderMarkdown } from './markdown.js';

export const uiEscape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const SKILL_ART = {
  'store-discovery': '/media/ai-cover-storefront.png',
  'store-visit': '/media/ai-cover-service.png',
  signature: '/media/ai-dining-dimsum.png',
  'group-buy': '/media/ai-cover-brand.png',
};
export const uiIcon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${({ close: 'M6 6l12 12M18 6 6 18', heart: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8', copy: 'M9 9h12v12H9zM15 5V3H3v12h2', download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5', fold: 'M4 4h16v16H4zM9 4v16M16 9l-3 3 3 3', unfold: 'M4 4h16v16H4zM9 4v16M13 9l3 3-3 3', down: 'm6 9 6 6 6-6', up: 'm6 14 6-6 6 6', plus: 'M12 5v14M5 12h14', edit: 'm4 16 12-12 4 4-12 12H4v-4M14 6l4 4', sparkle: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3', expand: 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5', play: 'm8 4 13 8-13 8z', pause: 'M8 4v16M16 4v16', sound: 'm11 5-5 4H3v6h3l5 4V5m4 3a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14', mute: 'm11 5-5 4H3v6h3l5 4V5m5 4 5 6m0-6-5 6', check: 'm5 12 5 5L20 6', trash: 'M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7' })[name] || 'M4 4h16v16H4z'}"/></svg>`;

export function mediaUrl(value) {
  if (typeof value !== 'string' || !value) return '';
  if (/[\\\u0000-\u001f]/.test(value)) return '';
  if (/^(?:\/(?!\/)|https?:\/\/|blob:)/i.test(value)) return value;
  return '';
}
export function readUiStore(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; }
}
export function writeUiStore(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

export function referenceChip(asset, token, index) {
  if (!asset) return uiEscape(token);
  const url = mediaUrl(asset.url);
  return `<button type="button" class="vc-reference-chip" contenteditable="false" data-action="vc-preview-asset" data-id="${uiEscape(asset.id)}" data-token="${uiEscape(token)}" aria-label="预览 ${uiEscape(token)}">${asset.type === 'image' && url ? `<img src="${uiEscape(url)}" alt="">` : uiIcon('sound')}<span>${uiEscape(token || `@图片${index + 1}`)}</span></button>`;
}

export function promptMarkup(value, assets = []) {
  const images = assets.filter(a => a.type === 'image'), audio = assets.filter(a => a.type === 'audio');
  return renderMarkdown(String(value || '')).replace(/(^|>)([^<]*)(?=<|$)/g, (match, before, text) => before + text.replace(/\[已移除(?:图片|声音)\d+\]|@?(?:图片|image|声音|音频)(\d+)/gi, (token, number) => {
    if (!number) return token;
    const list = /图片|image/i.test(token) ? images : audio;
    return referenceChip(list[Number(number) - 1], token, Number(number) - 1);
  }));
}

export function readPromptEditor(root) {
  const walk = node => {
    if (node.nodeType === 3) return node.nodeValue;
    if (node.nodeType !== 1) return '';
    if (node.dataset.token) return node.dataset.token;
    if (node.tagName === 'BR') return '\n';
    const text = [...node.childNodes].map(walk).join('');
    if (/^H[1-6]$/.test(node.tagName)) return `${'#'.repeat(Number(node.tagName[1]))} ${text}\n\n`;
    if (node.tagName === 'LI') return `- ${text.trim()}\n`;
    if (['P', 'DIV', 'UL', 'OL', 'BLOCKQUOTE', 'PRE'].includes(node.tagName)) return text + '\n';
    if (['B', 'STRONG'].includes(node.tagName)) return `**${text}**`;
    return text;
  };
  return [...root.childNodes].map(walk).join('').replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export function insertEditorText(root, text) {
  root.focus();
  const selection = window.getSelection();
  let range = selection?.rangeCount && selection.getRangeAt(0);
  if (!range || !root.contains(range.commonAncestorContainer)) { range = document.createRange(); range.selectNodeContents(root); range.collapse(false); }
  range.deleteContents();
  const textNode = document.createTextNode(text); range.insertNode(textNode); range.setStartAfter(textNode); range.collapse(true);
  selection.removeAllRanges(); selection.addRange(range);
  root.dispatchEvent(new Event('input', { bubbles: true }));
}

export function directorDocument(result, assets) {
  const script = result?.script;
  if (!script) return result?.text || '';
  const plan = script.plan;
  const lines = [`## ${script.title || '视频脚本'}`, '', '### 剧情概述', script.summary || result.text || '', ''];
  const images = assets.filter(a => a.type === 'image');
  if (result.assets?.length) {
    lines.push('### 素材与职责');
    for (const role of result.assets) {
      const asset = assets.find(a => a.id === role.id); if (!asset) continue;
      lines.push(`- ${asset.type === 'image' ? `@图片${images.indexOf(asset) + 1}` : '@声音1'}：${[role.role, role.adopt || role.description].filter(Boolean).join('；')}${role.exclude ? `。不采用：${role.exclude}` : ''}`);
    }
    lines.push('');
  }
  if (plan) {
    lines.push('### 主体与全片设定');
    for (const [label, value] of [['到店理由', plan.objective], ['目标顾客', plan.audience], ['叙事视角', plan.perspective], ['体验与情绪', plan.storyArc], ['画面风格', plan.visualStyle]]) if (value) lines.push(`- ${label}：${value}`);
    for (const cast of plan.cast || []) lines.push(`- ${cast.name}：${[cast.role, cast.appearance].filter(Boolean).join('；')}`);
    if (plan.audio) for (const [label, value] of [['口播', plan.audio.voiceDirection], ['配乐', plan.audio.music], ['环境声', plan.audio.ambience]]) if (value) lines.push(`- ${label}：${value}`);
    lines.push('');
  }
  lines.push('### 镜头与时间轴');
  for (const shot of script.shots || []) {
    lines.push(`#### ${shot.start}—${shot.end}s${shot.intent ? ` · ${shot.intent}` : ''}`);
    const refs = (shot.referenceIds || []).map(id => images.findIndex(a => a.id === id)).filter(i => i >= 0).map(i => `@图片${i + 1}`);
    if (refs.length) lines.push(refs.join(' '));
    for (const [label, value] of [['画面', shot.visual], ['动作', shot.action], ['情绪', shot.emotion], ['运镜', shot.camera], ['旁白', shot.voiceover], ['声音', shot.sound], ['字幕', shot.caption]]) if (value) lines.push(`${label}：${value}`);
    lines.push('');
  }
  if (plan?.keep?.length || plan?.avoid?.length) {
    lines.push('### 保持与禁止');
    if (plan.keep?.length) lines.push('保持：' + plan.keep.join('；'));
    if (plan.avoid?.length) lines.push('禁止：' + plan.avoid.join('；'));
  }
  return lines.join('\n');
}

export function emptyDirectorArt() {
  return `<svg class="vc-director-art" viewBox="0 0 160 110" aria-hidden="true"><ellipse cx="80" cy="61" rx="61" ry="21" fill="none" stroke="currentColor" stroke-width="6"/><rect x="43" y="22" width="73" height="75" rx="13" fill="#f6f6f8"/><g fill="currentColor"><circle cx="60" cy="40" r="6"/><rect x="74" y="36" width="30" height="6" rx="3"/><circle cx="60" cy="58" r="6"/><rect x="74" y="54" width="25" height="6" rx="3"/><circle cx="60" cy="76" r="6"/><rect x="74" y="72" width="18" height="6" rx="3"/><path d="m122 8 3 6 6 3-6 3-3 6-3-6-6-3 6-3z"/></g><rect x="100" y="61" width="29" height="32" rx="9" fill="currentColor"/><path d="m111 70 10 7-10 7z" fill="#f6f6f8"/></svg>`;
}

export function previewArtwork() {
  return `<div class="vc-example-art" aria-hidden="true"><div class="vc-example-back"><img src="/media/ai-cover-storefront.png" alt=""></div><div class="vc-example-side"><img src="/media/ai-cover-brand.png" alt=""></div><div class="vc-example-front"><img src="/media/ai-dining-dimsum.png" alt=""><span>${uiIcon('play')}</span></div><span class="vc-example-badge">${uiIcon('sparkle')}</span><div class="vc-example-timeline"><i></i><i></i><i></i><i></i><span></span></div></div>`;
}

export function encodeWav(buffer) {
  const channels = Math.min(2, buffer.numberOfChannels), length = buffer.length, bytes = length * channels * 2;
  const data = new ArrayBuffer(44 + bytes), view = new DataView(data);
  const word = (at, text) => [...text].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  word(0, 'RIFF'); view.setUint32(4, 36 + bytes, true); word(8, 'WAVE'); word(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true); view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * channels * 2, true); view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); word(36, 'data'); view.setUint32(40, bytes, true);
  const samples = Array.from({ length: channels }, (_, i) => buffer.getChannelData(i));
  let at = 44;
  for (let i = 0; i < length; i++) for (let c = 0; c < channels; c++) { const value = Math.max(-1, Math.min(1, samples[c][i])); view.setInt16(at, value < 0 ? value * 32768 : value * 32767, true); at += 2; }
  return new Blob([data], { type: 'audio/wav' });
}
