import { uploadSharedMaterial } from './generated-assets.js';
import { t } from './workspace-preferences.js';

export function openDouyinExtractor(ctx, { onUse, canUse = () => true, maxDuration = 60 }) {
  const owner = globalThis.workspaceUser?.id, controller = new AbortController();
  let file, url, duration = 0, busy = false, saved = false, used = false;
  ctx.openModal(t('抖音视频提取'), t('粘贴视频链接或分享文案，提取后选择用途。'), `<section id="douyin-extractor">
    <form id="douyin-form"><label for="douyin-link">${t('抖音视频链接')}</label><textarea id="douyin-link" rows="3" maxlength="5000" required placeholder="${t('粘贴抖音视频链接或完整分享文案')}"></textarea><button id="douyin-extract" type="submit" class="primary">${t('提取无水印视频')}</button></form>
    <p id="douyin-status" role="status" aria-live="polite"></p>
    <section id="douyin-result" hidden><video id="douyin-preview" controls playsinline preload="metadata" aria-label="${t('提取视频预览')}"></video><p id="douyin-name" data-no-i18n></p><p id="douyin-reference-hint"></p><div class="douyin-actions"><a id="douyin-download" class="secondary">${t('下载视频')}</a><button id="douyin-save" type="button" class="secondary">${t('保存到资产库')}</button><button id="douyin-use" type="button" class="primary">${t('用作当前参考视频')}</button></div></section>
    <footer class="modal-actions"><button id="douyin-close" type="button" class="secondary">${t('关闭')}</button></footer>
  </section>`, true);
  const root = document.querySelector('#douyin-extractor'), dialog = document.querySelector('#modal');
  const $ = selector => root.querySelector(selector);
  const current = () => !controller.signal.aborted && dialog.open && root.isConnected && owner === globalThis.workspaceUser?.id;
  const cleanup = () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  dialog.addEventListener('close', cleanup, { once: true });
  function paint() {
    $('#douyin-link').disabled = busy;
    $('#douyin-extract').disabled = busy;
    $('#douyin-extract').textContent = t(busy ? '正在处理…' : '提取无水印视频');
    $('#douyin-save').disabled = busy || !file || saved;
    $('#douyin-save').textContent = t(saved ? '已保存到资产库' : '保存到资产库');
    const fits = duration >= 2 && duration <= maxDuration;
    $('#douyin-use').disabled = busy || !file || used || !canUse() || !fits;
    $('#douyin-use').textContent = t(used ? '已设为参考视频' : '用作当前参考视频');
    $('#douyin-reference-hint').textContent = !file ? '' : !fits
      ? t('当前复刻支持 2–{seconds} 秒视频，此视频可下载或保存到资产库。', { seconds: maxDuration })
      : !canUse() ? t('当前任务已提交或已切换，请新建深度复刻后使用；也可保存到资产库。') : '';
  }
  $('#douyin-close').onclick = () => dialog.close();
  $('#douyin-form').onsubmit = async event => {
    event.preventDefault();
    const text = $('#douyin-link').value.trim();
    if (busy || !current() || !text) return;
    busy = true; paint(); $('#douyin-status').textContent = t('正在解析链接并下载视频，请稍候…');
    try {
      const response = await fetch('/api/video-replica/douyin', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(210_000)]) });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || t('视频提取失败，请稍后重试。'));
      }
      if (!response.headers.get('content-type')?.startsWith('video/mp4')) throw new Error(t('视频提取失败，请稍后重试。'));
      const blob = await response.blob();
      if (!current()) return;
      if (!blob.size || blob.size > 300 * 1024 * 1024) throw new Error(t('视频文件为空或超过 300 MB，请更换链接。'));
      const name = decodeURIComponent(response.headers.get('x-video-name') || 'douyin-video.mp4');
      file = new File([blob], name, { type: 'video/mp4' });
      duration = Number(response.headers.get('x-video-duration'));
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(file); saved = false; used = false;
      $('#douyin-preview').src = url;
      $('#douyin-download').href = url; $('#douyin-download').download = file.name;
      $('#douyin-name').textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
      $('#douyin-result').hidden = false;
      $('#douyin-status').textContent = t('提取完成，请选择视频用途。');
    } catch (cause) {
      if (current()) $('#douyin-status').textContent = cause.name === 'TimeoutError' ? t('提取超时，请稍后重试。')
        : cause instanceof TypeError ? t('连接视频服务失败，请稍后重试。') : cause.message;
    } finally { busy = false; if (current()) paint(); }
  };
  $('#douyin-save').onclick = async () => {
    if (!current() || busy || !file || saved) return;
    busy = true; paint(); $('#douyin-status').textContent = t('正在保存到资产库…');
    try {
      await uploadSharedMaterial('video', file, AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]));
      if (!current()) return;
      saved = true; $('#douyin-status').textContent = t('视频已保存到资产库，可在视频素材中找到。');
    } catch (cause) { if (current()) $('#douyin-status').textContent = cause.message; }
    finally { busy = false; if (current()) paint(); }
  };
  $('#douyin-use').onclick = async () => {
    if (!current() || busy || !file || used || !canUse() || duration < 2 || duration > maxDuration || !Number.isFinite(duration)) return;
    busy = true; paint();
    try {
      await onUse(file);
      if (!current()) return;
      used = true; $('#douyin-status').textContent = t('已放入当前参考视频，还可下载或保存到资产库。');
    } catch (cause) { if (current()) $('#douyin-status').textContent = cause.message; }
    finally { busy = false; if (current()) paint(); }
  };
  paint(); $('#douyin-link').focus();
}
