export function accountStorageKey(key) {
  return globalThis.workspaceUser?.id ? `${key}:${globalThis.workspaceUser.id}` : key;
}
