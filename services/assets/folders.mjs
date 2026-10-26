import { randomUUID } from 'node:crypto';
import { assetFolders, materialFolder, folderDescendants, ASSET_CATEGORIES } from '../../design/asset-organization.js';
const fail = (message, status = 400) => Object.assign(new Error(message), { status, code: 'ASSET_STORAGE_ERROR' });
export function editFolders(data, input, materials) {
  data.folders = assetFolders(data).map(folder => ({ ...folder }));
  data.assignments = { ...data.assignments };
  const folders = data.folders, current = folders.find(folder => folder.id === input.id);
  const parent = input.parentId ? folders.find(folder => folder.id === input.parentId) : null;
  const type = current?.type || input.type;
  if (!Object.hasOwn(ASSET_CATEGORIES, type)) throw fail('文件夹类型无效。');
  if (input.parentId && (!parent || parent.type !== type)) throw fail('请选择同类型的目标文件夹。');
  if (input.action !== 'folder-create' && !current) throw fail('文件夹不存在。', 404);
  if (['folder-create', 'folder-rename'].includes(input.action)) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 40 || /[\\/\u0000-\u001f]/.test(name)) throw fail('请输入1—40字的文件夹名称。');
    const parentId = current ? current.parentId : parent?.id || null;
    if (folders.some(folder => folder.id !== current?.id && folder.type === type && folder.parentId === parentId && folder.name === name)) throw fail('同一级已有同名文件夹。');
    if (current) current.name = name;
    else { if (folders.length >= 200) throw fail('最多创建200个文件夹。'); folders.push({ id: randomUUID(), name, type, parentId }); }
  } else if (input.action === 'folder-move') {
    if (folderDescendants(current.id, folders).has(input.parentId)) throw fail('不能移入自身或下级文件夹。');
    if (folders.some(folder => folder.id !== current.id && folder.type === type && folder.parentId === (parent?.id || null) && folder.name === current.name)) throw fail('目标位置已有同名文件夹。');
    current.parentId = parent?.id || null;
  } else if (input.action === 'folder-delete') {
    // Move contents and child folders up one level; never delete media implicitly.
    for (const item of materials) if (materialFolder(item, data) === current.id) data.assignments[item.id] = current.parentId;
    for (const child of folders.filter(folder => folder.parentId === current.id)) {
      child.parentId = current.parentId;
      let name = child.name, suffix = 1;
      while (folders.some(folder => folder.id !== child.id && folder.id !== current.id && folder.parentId === child.parentId && folder.type === child.type && folder.name === name)) name = `${child.name.slice(0, 32)} (${suffix++})`;
      child.name = name;
    }
    data.folders = folders.filter(folder => folder.id !== current.id);
  } else throw fail('文件夹操作无效。');
  return data;
}

export function assignMaterials(data, ids, folderId, type, materials) {
  const folder = assetFolders(data).find(item => item.id === folderId);
  if (!Object.hasOwn(ASSET_CATEGORIES, type) || folderId && (!folder || folder.type !== type)) throw fail('请选择同类型的素材文件夹。');
  if (!Array.isArray(ids) || !ids.length || ids.length > 500) throw fail('请选择要移动的素材。');
  data.assignments = { ...data.assignments };
  for (const id of ids) {
    const item = materials.find(item => item.id === id);
    if (!item) throw fail('素材不存在。', 404);
    if (({ photo: 'image', voice: 'audio', video: 'video' })[item.kind] !== type) throw fail('不同类型的素材不能放入同一个文件夹。');
    data.assignments[id] = folderId || null;
  }
  return data;
}
