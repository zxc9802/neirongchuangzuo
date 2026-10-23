export function organizeAssets(items, organization = {}, deleted = false) {
  const removed = new Set(organization.deleted || []);
  const positions = new Map((organization.order || []).map((key, i) => [key, i]));
  return items.filter(item => removed.has(item.key) === deleted)
    .sort((a, b) => (positions.get(a.key) ?? Infinity) - (positions.get(b.key) ?? Infinity) || 0);
}

export function relativeAssetMove(items, key, direction) {
  const index = items.findIndex(item => item.key === key), target = items[index + direction];
  if (index < 0 || !target) return null;
  return { action: 'move', keys: [key], target: target.key, position: direction < 0 ? 'before' : 'after' };
}
