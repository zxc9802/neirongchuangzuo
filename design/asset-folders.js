import { ASSET_CATEGORIES, assetFolders, folderDescendants } from './asset-organization.js';
import { t } from './workspace-preferences.js';

export function renderAssetFolders(state, ctx) {
  const folders = assetFolders(state.organization), current = folders.find(folder => folder.id === state.folderId);
  const category = current?.type || state.category;
  const visible = folders.filter(folder => folder.parentId === (current?.id || null) && (category === 'all' || folder.type === category));
  return `<nav class="asset-category-tabs" aria-label="资产分类">${[['all', '全部'], ...Object.entries(ASSET_CATEGORIES)].map(([type, label]) => ctx.button('asset-category', label, category === type ? 'primary' : 'secondary', `data-type="${type}" aria-pressed="${category === type}"`)).join('')}</nav>
    <div class="asset-folder-heading"><div>${current ? ctx.button('asset-folder-open', '上一级', 'textbutton', `data-id="${ctx.esc(current.parentId || '')}" data-type="${current.type}"`) : ''}<strong>${ctx.esc(current?.name || ASSET_CATEGORIES[category] || '素材文件夹')}</strong></div>${ctx.button('asset-folder-create', '新建文件夹', 'secondary', state.busy ? 'disabled' : '')}</div>
    <div class="asset-folder-grid">${visible.map(folder => `<article class="asset-folder-card"><button data-action="asset-folder-open" data-id="${ctx.esc(folder.id)}" data-type="${folder.type}" aria-label="打开文件夹：${ctx.esc(folder.name)}">${ctx.icon('folder')}<span>${ctx.esc(folder.name)}</span><small>${ASSET_CATEGORIES[folder.type]}</small></button><div>${ctx.button('asset-folder-rename', '重命名', 'textbutton', `data-id="${ctx.esc(folder.id)}"`)}${ctx.button('asset-folder-move', '移动', 'textbutton', `data-id="${ctx.esc(folder.id)}"`)}${ctx.button('asset-folder-delete', '删除', 'textbutton', `data-id="${ctx.esc(folder.id)}"`)}</div></article>`).join('')}</div>`;
}
function options(folders, type, excluded = new Set(), selected = null) {
  const label = folder => {
    let text = folder.name, parent = folder.parentId, seen = new Set([folder.id]);
    while (parent && !seen.has(parent)) { seen.add(parent); const item = folders.find(f => f.id === parent); if (!item) break; text = item.name + ' / ' + text; parent = item.parentId; }
    return text;
  };
  const esc = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  return `<option value="">${t(ASSET_CATEGORIES[type])} / ${t('未分类')}</option>` + folders.filter(folder => folder.type === type && !excluded.has(folder.id)).map(folder => `<option value="${esc(folder.id)}" ${folder.id === selected ? 'selected' : ''}>${esc(label(folder))}</option>`).join('');
}
export function openFolderEditor(action, id, state, ctx) {
  const folders = assetFolders(state.organization), folder = folders.find(folder => folder.id === id), type = folder?.type || (state.category === 'all' ? 'image' : state.category);
  if (action !== 'folder-create' && !folder) return;
  const deleting = action === 'folder-delete', moving = action === 'folder-move';
  const title = deleting ? '删除文件夹' : moving ? '移动文件夹' : action === 'folder-create' ? '新建文件夹' : '重命名文件夹';
  const controls = deleting ? '' : moving ? `<label>目标文件夹<select id="asset-folder-parent">${options(folders, type, folderDescendants(id, folders), folder.parentId)}</select></label>` : `<label>文件夹名称<input id="asset-folder-name" maxlength="40" value="${ctx.esc(folder?.name || '')}" autocomplete="off"></label>${action === 'folder-create' && state.category === 'all' ? `<label>素材类型<select id="asset-folder-type">${Object.entries(ASSET_CATEGORIES).map(([value, name]) => `<option value="${value}">${t(name)}</option>`).join('')}</select></label>` : ''}`;
  ctx.openModal(title, deleting ? '文件夹内素材和下级文件夹将移到上一级，文件不会删除。' : '', `<div class="asset-folder-form">${controls}</div><footer class="modal-actions">${ctx.button('asset-cancel-delete','取消','secondary')}${ctx.button('asset-folder-submit', deleting ? '删除文件夹' : '保存', 'primary', `data-op="${action}" data-id="${ctx.esc(id || '')}" data-type="${type}"`)}</footer>`, true);
}
export function openMaterialMove(items, state, ctx) {
  if (!items.length) return;
  const types = new Set(items.map(item => item.type));
  if (types.size !== 1) { ctx.toast('请分别移动图片、音频或视频。'); return; }
  const type = items[0].type, generated = items.some(item => !item.permanent);
  ctx.openModal(generated ? '保存到素材文件夹' : '移动到文件夹', generated ? '保存成功后长期保留，不受原任务到期影响。' : '',
    `<div class="asset-folder-form"><label>目标文件夹<select id="asset-move-target">${options(assetFolders(state.organization), type, new Set(), state.folderId || (type === 'video' ? 'generated-video' : type === 'audio' ? 'imitated-voice' : 'photos'))}</select></label></div><footer class="modal-actions">${ctx.button('asset-cancel-delete','取消','secondary')}${ctx.button('asset-placement-submit', generated ? '保存并移动' : '移动', 'primary', `data-keys="${ctx.esc(JSON.stringify(items.map(item => item.key)))}" data-type="${type}"`)}</footer>`, true);
}

export function openAssetUpload(state, ctx, upload) {
  const folders = assetFolders(state.organization), current = folders.find(folder => folder.id === state.folderId);
  const initialType = current?.type || (state.category === 'all' ? 'image' : state.category);
  const settings = {
    image: { kind: 'photo', accept: '.jpg,.jpeg,.png,.webp', extensions: /\.(jpe?g|png|webp)$/i, limit: 50 * 1024 * 1024 - 1, help: 'JPG / PNG / WebP，单张小于50MB' },
    audio: { kind: 'voice', accept: '.mp3,.wav', extensions: /\.(mp3|wav)$/i, limit: 50 * 1024 * 1024 - 1, help: 'MP3 / WAV，单个小于50MB，保留完整音频' },
    video: { kind: 'video', accept: '.mp4,.mov', extensions: /\.(mp4|mov)$/i, limit: 300 * 1024 * 1024, help: 'MP4 / MOV，单个不超过300MB' },
  };
  ctx.openModal('上传素材', '上传后长期保存，可在创作时复用。', `<div class="asset-folder-form asset-upload-form"><label>${t('素材类型')}<select id="asset-upload-type">${Object.entries(ASSET_CATEGORIES).map(([type, label]) => `<option value="${type}" ${type === initialType ? 'selected' : ''}>${t(label)}</option>`).join('')}</select></label><label>${t('目标文件夹')}<select id="asset-upload-folder"></select></label><label>${t('选择文件')}<input id="asset-upload-files" type="file" multiple></label><small id="asset-upload-help"></small><ol id="asset-upload-results" aria-live="polite"></ol></div><footer class="modal-actions"><button type="button" class="primary" id="asset-upload-start">${t('开始上传')}</button></footer>`, true);
  const typeInput = document.querySelector('#asset-upload-type'), folderInput = document.querySelector('#asset-upload-folder');
  const filesInput = document.querySelector('#asset-upload-files'), button = document.querySelector('#asset-upload-start'), results = document.querySelector('#asset-upload-results');
  const refresh = () => {
    const type = typeInput.value;
    folderInput.innerHTML = options(folders, type, new Set(), current?.type === type ? current.id : ({ image: 'photos', audio: 'own-voice', video: 'own-video' })[type]);
    filesInput.accept = settings[type].accept; filesInput.value = '';
    document.querySelector('#asset-upload-help').textContent = t(settings[type].help);
    button.textContent = t('开始上传');
    results.replaceChildren();
  };
  typeInput.addEventListener('change', refresh); refresh();
  button.addEventListener('click', async () => {
    const files = [...filesInput.files];
    if (!files.length) { ctx.toast('请选择素材文件。'); return; }
    const config = settings[typeInput.value], folderId = folderInput.value || null;
    for (const control of [typeInput, folderInput, filesInput, button]) control.disabled = true;
    results.replaceChildren();
    const rows = files.map(file => { const row = document.createElement('li'); row.textContent = `${file.name} — ${t('等待上传')}`; results.append(row); return row; });
    const failed = [];
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        try {
          if (!config.extensions.test(file.name)) throw new Error(t('文件格式与所选类型不符'));
          if (!file.size || file.size > config.limit) throw new Error(t('文件为空或超过大小限制'));
          rows[i].textContent = `${file.name} — ${t('正在上传…')}`;
          await upload(config.kind, file, folderId);
          rows[i].textContent = `${file.name} — ${t('上传成功')}`;
        } catch (error) { failed.push(file); rows[i].textContent = `${file.name} — ${t('上传失败')}：${t(error.message)}`; }
      }
      if (typeof DataTransfer !== 'undefined') { const transfer = new DataTransfer(); failed.forEach(file => transfer.items.add(file)); filesInput.files = transfer.files; }
      else filesInput.value = '';
      button.textContent = t(failed.length ? '重试失败文件' : '继续上传');
    } finally { for (const control of [typeInput, folderInput, filesInput, button]) control.disabled = false; }
  });
}
