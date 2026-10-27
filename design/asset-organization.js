export function organizeAssets(items, organization = {}, deleted = false) {
  const removed = new Set(organization.deleted || []);
  const time = item => Number.isFinite(item.createdAt) ? item.createdAt : Number.isFinite(item.completed) ? item.completed : 0;
  return items.filter(item => removed.has(item.key) === deleted)
    .sort((a, b) => time(b) - time(a));
}

export function relativeAssetMove(items, key, direction) {
  const index = items.findIndex(item => item.key === key), target = items[index + direction];
  if (index < 0 || !target) return null;
  return { action: 'move', keys: [key], target: target.key, position: direction < 0 ? 'before' : 'after' };
}

export const ASSET_CATEGORIES = { image: '图片', audio: '音频', video: '视频' };
export const DEFAULT_ASSET_FOLDERS = [
  { id: 'people', name: '人物', type: 'image', parentId: null },
  { id: 'photos', name: '照片', type: 'image', parentId: null },
  { id: 'own-voice', name: '本人声音', type: 'audio', parentId: null },
  { id: 'imitated-voice', name: '模仿声音', type: 'audio', parentId: null },
  { id: 'own-video', name: '本人视频', type: 'video', parentId: null },
  { id: 'generated-video', name: '生成视频', type: 'video', parentId: null },
];
export const assetFolders = organization => organization.folders ?? DEFAULT_ASSET_FOLDERS;
export function materialFolder(item, organization = {}) {
  if (Object.hasOwn(organization.assignments || {}, item.id)) return organization.assignments[item.id];
  const fallback = item.kind === 'photo' ? 'photos' : item.kind === 'voice' ? 'own-voice' : item.origin === 'generated' ? 'generated-video' : 'own-video';
  return assetFolders(organization).some(folder => folder.id === fallback) ? fallback : null;
}
export function folderDescendants(id, folders) {
  const result = new Set([id]);
  for (let i = 0; i < folders.length; i++) for (const folder of folders) if (result.has(folder.parentId)) result.add(folder.id);
  return result;
}
