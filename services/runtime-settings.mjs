import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ALLOWED = new Set(['WORKSPACE_DATA_DIR', 'RESTAURANT_DATABASE_URL', 'RESTAURANT_PACKAGE_DAILY_LIMIT',
  'COS_SECRET_ID', 'COS_SECRET_KEY', 'COS_BUCKET', 'COS_REGION']);

// Production configuration only comes from the deployment environment.
// Do not load authentication databases or mount-confirmation bypasses from a developer file.
export function loadWorkspaceSettings({ env = process.env, root = ROOT } = {}) {
  const local = {};
  if (env.NODE_ENV !== 'production') {
    let content = '';
    try { content = readFileSync(join(root, '.env.local'), 'utf8'); } catch { /* Optional. */ }
    for (const line of content.split(/\r?\n/)) {
      const match = /^([A-Z_]+)=(.*)$/.exec(line);
      if (match && ALLOWED.has(match[1])) local[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return { ...local, ...env };
}
