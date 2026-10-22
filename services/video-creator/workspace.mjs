import { creatorError } from './model.mjs';

export const WORKSPACE_COLLECTIONS = ['drafts', 'prompts', 'favorites', 'folders', 'asset-meta', 'hidden-tasks', 'hidden-drafts', 'hidden-local-drafts'];
const bad = message => creatorError(message, 400, 'WORKSPACE_INVALID');
export function applyWorkspaceChanges(current, changes, now = Date.now()) {
  if (!Array.isArray(changes) || !changes.length || changes.length > 50) throw bad('同步内容过多，请分批保存。');
  const next = structuredClone(current), seen = new Set();
  for (const change of changes) {
    const { collection, id, value, revision } = change || {};
    if (!WORKSPACE_COLLECTIONS.includes(collection) || typeof id !== 'string' || !/^[\w:.-]{1,180}$/.test(id)
      || !Number.isSafeInteger(revision) || revision < 0 || value === undefined || Buffer.byteLength(JSON.stringify(value)) > 160 * 1024) throw bad('保存内容无效。');
    const key = collection + '/' + id;
    if (seen.has(key)) throw bad('重复保存同一条记录。'); seen.add(key);
    const previous = next.entries[key];
    if (previous && JSON.stringify(previous.value) === JSON.stringify(value)) continue;
    if ((previous?.revision || 0) !== revision) throw creatorError('其他页面已修改此记录，正在保留两个版本。', 409, 'WORKSPACE_CONFLICT');
    if (value !== null) {
      if (['favorites', 'hidden-tasks', 'hidden-drafts', 'hidden-local-drafts'].includes(collection)) {
        if (value !== true) throw bad('收藏或记录状态无效。');
      } else if (!value || typeof value !== 'object' || Array.isArray(value) || value.id !== id) throw bad('记录标识无效。');
      if (collection === 'drafts' && (typeof value.input !== 'string' || value.input.length > 8000 || typeof value.prompt !== 'string' || value.prompt.length > 12000)) throw bad('草稿内容过长。');
      if (collection === 'prompts' && (typeof value.prompt !== 'string' || value.prompt.length > 12000 || typeof value.title !== 'string' || value.title.length > 100)) throw bad('提示词内容无效。');
      if (collection === 'folders' && (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 60 || value.parentId !== null && typeof value.parentId !== 'string')) throw bad('文件夹信息无效。');
      if (collection === 'asset-meta' && (typeof value.folderId !== 'string' && value.folderId !== null)) throw bad('素材目录无效。');
    }
    next.revision++; next.entries[key] = { collection, id, value, revision: next.revision, updatedAt: now };
  }
  const entries = Object.values(next.entries), folders = new Map(entries.filter(e => e.collection === 'folders' && e.value).map(e => [e.id, e.value]));
  for (const folder of folders.values()) {
    const visited = new Set([folder.id]); let parent = folder.parentId;
    while (parent) { if (!folders.has(parent) || visited.has(parent) || visited.size > 10) throw bad('目录不存在、层级过深或形成循环。'); visited.add(parent); parent = folders.get(parent).parentId; }
  }
  for (const e of entries) if (e.collection === 'asset-meta' && e.value?.folderId && !folders.has(e.value.folderId)) throw bad('素材所在目录不存在。');
  if (entries.length > 3000 || entries.filter(e => e.value && e.collection === 'drafts').length > 100 || folders.size > 100 || Buffer.byteLength(JSON.stringify(next)) > 3 * 1024 * 1024) throw bad('保存记录已达上限，请清理不再需要的草稿。');
  return next;
}
