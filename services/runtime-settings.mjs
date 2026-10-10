import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ALLOWED = new Set(['WORKSPACE_DATA_DIR', 'RESTAURANT_DATABASE_URL', 'RESTAURANT_PACKAGE_DAILY_LIMIT',
  'RESTAURANT_PYTHON_BIN', 'RESTAURANT_SUBJECT_MODEL_PATH',
  'VIDEO_API_BASE_URL', 'VIDEO_PROJECT_CODE', 'VIDEO_ACCESS_KEY', 'VIDEO_SECRET_KEY', 'VIDEO_PUBLIC_BASE_URL',
  'MATERIAL_API_BASE_URL', 'MATERIAL_PROJECT_CODE', 'MATERIAL_ACCESS_KEY', 'MATERIAL_SECRET_KEY', 'TEMP_ASSET_SIGNING_SECRET',
  'COS_SECRET_ID', 'COS_SECRET_KEY', 'COS_BUCKET', 'COS_REGION',
  'MIX_PYTHON_BIN', 'RERANK_API_KEY', 'EMBEDDING_URL', 'LLM_URL', 'RERANK_URL',
  'INDEXTTS_302_API_KEY', 'INDEXTTS_BASE_URL', 'INDEXTTS_SPEAKER_AUDIO_URL',
  'INDEXTTS_EMOTION_AUDIO_PATH', 'INDEXTTS_EMOTION_AUDIO_URL', 'INDEXTTS_DOWNLOAD_HOSTS',
  'MIX_AUDIO_COS_SECRET_ID', 'MIX_AUDIO_COS_SECRET_KEY', 'MIX_AUDIO_COS_BUCKET', 'MIX_AUDIO_COS_REGION']);

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
