import { assetThumbnailUrl, loadAssetLibrary, uploadSharedMaterial } from './generated-assets.js';
import { t } from './workspace-preferences.js';

const TYPES = { video: 'video', voice: 'audio', photo: 'image', product: 'image', background: 'image' };
const TITLES = { video: '选择参考视频', voice: '选择参考声音', photo: '选择人物形象', product: '选择商品图片', background: '选择背景图片' };
const ACCEPT = { image: 'image/jpeg,image/png,image/webp', audio: 'audio/mpeg,audio/wav,.mp3,.wav', video: 'video/mp4,video/quicktime,.mp4,.mov' };

export async function openReplicaAssetPicker(ctx, kind, onSelect) {
  const type = TYPES[kind], owner = globalThis.workspaceUser?.id;
  const controller = new AbortController();
  let items = (ctx.assets || []).filter(item => item.type === type && item.file).map(item => ({ ...item, key: `local:${item.id}`, origin: 'uploaded' }));
  let selected = null, query = '', filter = 'all', busy = false, loading = true;
  ctx.openModal(t(TITLES[kind]), t('选择一个素材，确认后填入当前复刻。'), `<section id="replica-asset-picker">
    <div class="rap-heading"><strong>${t('我的资产')}</strong><span>${t(type === 'image' ? '图片' : type === 'audio' ? '声音' : '视频')}</span></div>
    <div class="rap-toolbar"><label class="rap-search">${ctx.icon('search')}<input id="rap-search" type="search" placeholder="${t('按文件名搜索素材')}" aria-label="${t('按文件名搜索素材')}"></label><div class="rap-filters" role="group" aria-label="${t('素材来源')}">${[['all', '全部'], ['uploaded', '我上传的'], ['generated', 'AI生成的']].map(([value, label]) => `<button type="button" data-rap-filter="${value}" aria-pressed="${value === 'all'}">${t(label)}</button>`).join('')}</div></div>
    <p id="rap-status" role="status">${t('正在读取资产…')}</p><div id="rap-grid" class="rap-grid"><label class="rap-upload">${ctx.icon('plus')}<strong>${t('上传素材')}</strong><small>${t('支持本地文件上传')}</small><input id="rap-upload" type="file" accept="${ACCEPT[type]}"></label><p class="rap-empty" hidden></p></div>
    <footer class="modal-actions"><span id="rap-count"></span><button id="rap-cancel" type="button" class="secondary">${t('取消')}</button><button id="rap-confirm" type="button" class="primary" disabled>${t('确认选择')}</button></footer>
  </section>`, true);
  const dialog = document.querySelector('#modal'), root = document.querySelector('#replica-asset-picker');
  const $ = selector => root.querySelector(selector);
  const current = () => !controller.signal.aborted && dialog.open && root.isConnected && owner === globalThis.workspaceUser?.id;
  const cleanup = () => controller.abort();
  dialog.addEventListener('close', cleanup, { once: true });
  function paint() {
    if (!current()) return;
    const visible = items.filter(item => (!item.expires || item.expires > Date.now()) && (filter === 'all' || item.origin === filter) && `${item.name} ${item.filename || ''}`.toLocaleLowerCase().includes(query));
    const grid = $('#rap-grid'), existing = new Map([...grid.querySelectorAll('[data-rap-key]')].map(node => [node.dataset.rapKey, node]));
    let previous = $('.rap-upload');
    visible.forEach((item, index) => {
      let card = existing.get(item.key);
      if (!card) {
        card = document.createElement('button'); card.type = 'button'; card.className = 'rap-item'; card.dataset.rapKey = item.key;
        card.innerHTML = `<span class="rap-cover">${type === 'image' ? `<img src="${ctx.esc(assetThumbnailUrl(item))}" alt="" loading="${index < 7 ? 'eager' : 'lazy'}" decoding="async" width="320" height="320">` : ctx.icon(type === 'audio' ? 'audio' : 'video')}<span class="rap-check" aria-hidden="true"></span></span><strong title="${ctx.esc(item.name)}" data-no-i18n>${ctx.esc(item.name)}</strong><small>${t(item.origin === 'generated' ? 'AI生成的' : '我上传的')}</small>`;
      }
      card.setAttribute('aria-pressed', String(selected === item.key)); card.disabled = busy;
      card.querySelector('.rap-check').textContent = selected === item.key ? '✓' : '';
      if (previous.nextElementSibling !== card) previous.after(card);
      previous = card; existing.delete(item.key);
    });
    for (const card of existing.values()) card.remove();
    $('.rap-empty').hidden = visible.length > 0 || loading;
    $('.rap-empty').textContent = visible.length || loading ? '' : t(query ? '没有找到匹配素材' : '暂无可用素材，可从本地上传。');
    $('#rap-upload').disabled = busy;
    $('#rap-count').textContent = t('已选 {count}/1', { count: selected ? 1 : 0 });
    $('#rap-confirm').disabled = !selected || busy;
    $('#rap-upload').onchange = async event => {
      const file = event.target.files[0]; if (!file || busy) return;
      event.target.value = '';
      if (!validFile(file)) return;
      busy = true; $('#rap-status').textContent = t('正在保存素材到资产库…'); paint();
      try {
        const material = await uploadSharedMaterial(kind, file, AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]));
        if (!current()) return;
        items = items.filter(item => item.key !== material.id);
        items.unshift({ ...material, key: material.id, material, origin: 'uploaded' });
        selected = material.id; query = ''; filter = 'all'; $('#rap-search').value = ''; updateFilters();
        $('#rap-status').textContent = t('已存入资产库，取消选择不会删除素材。');
      } catch (error) { if (current()) $('#rap-status').textContent = error.message || t('素材入库失败，请重试。'); }
      finally { busy = false; paint(); }
    };
  }
  function validFile(file) {
    const max = kind === 'video' ? 300 : kind === 'voice' ? 15 : 10;
    if (file.size > max * 1024 * 1024) { $('#rap-status').textContent = t('素材不能超过 {size} MB。', { size: max }); return false; }
    const extensions = { image: /\.(?:jpe?g|png|webp)$/i, audio: /\.(?:mp3|wav)$/i, video: /\.(?:mp4|mov)$/i };
    if (!extensions[type].test(file.name)) { $('#rap-status').textContent = t('文件类型不符，请按当前入口选择素材。'); return false; }
    return true;
  }
  function updateFilters() { root.querySelectorAll('[data-rap-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.rapFilter === filter))); }
  $('#rap-search').oninput = event => { query = event.target.value.trim().toLocaleLowerCase(); paint(); };
  root.onclick = event => {
    if (busy) return;
    const choice = event.target.closest('[data-rap-key]'), tab = event.target.closest('[data-rap-filter]');
    if (choice) { selected = selected === choice.dataset.rapKey ? null : choice.dataset.rapKey; paint(); }
    if (tab) { filter = tab.dataset.rapFilter; updateFilters(); paint(); }
  };
  $('#rap-cancel').onclick = () => dialog.close();
  $('#rap-confirm').onclick = async () => {
    const item = items.find(item => item.key === selected); if (!item || busy || !current()) return;
    busy = true; $('#rap-status').textContent = t('正在读取素材…'); paint();
    try {
      let file = item.file;
      if (!file && !item.material) {
        if (item.expires && item.expires <= Date.now()) throw new Error(t('这份成品已到期，请刷新作品列表。'));
        const response = await fetch(item.url, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]) });
        if (!response.ok) throw new Error(t('素材下载失败，请重试。'));
        file = new File([await response.blob()], item.filename, { type: response.headers.get('content-type') || '' });
      }
      if (!current()) return;
      if (file && !validFile(file)) return;
      await onSelect(file ? { file } : { material: item.material });
      if (current()) dialog.close();
    } catch (error) { if (current()) $('#rap-status').textContent = error.message || t('素材读取失败，请重试。'); }
    finally { busy = false; paint(); }
  };
  paint();
  try {
    await loadAssetLibrary(controller.signal, { type, onUpdate(library) {
      if (!current()) return;
      loading = library.loading;
      items = [...items.filter(item => item.file),
        ...library.materials.filter(item => item.type === type).map(item => ({ ...item, key: item.id, material: item, origin: 'uploaded' })),
        ...library.records.filter(item => item.type === type).map(item => ({ ...item, name: item.title, origin: 'generated' }))];
      if (!busy) $('#rap-status').textContent = library.errors.join(' ') || (loading && !items.length ? t('正在读取资产…') : '');
      paint();
    } });
  } catch (error) { if (current()) $('#rap-status').textContent = error.message || t('素材读取失败，请重试。'); }
}
