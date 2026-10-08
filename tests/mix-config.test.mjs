import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadWorkspaceSettings } from '../services/runtime-settings.mjs';

test('mix audio COS configuration is separate and production only reads deployment variables', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mix-audio-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const audio = { MIX_AUDIO_COS_SECRET_ID: 'test-id', MIX_AUDIO_COS_SECRET_KEY: 'test-key',
    MIX_AUDIO_COS_BUCKET: 'audio-example-1234567890', MIX_AUDIO_COS_REGION: 'ap-singapore' };
  await writeFile(join(root, '.env.local'), Object.entries({ ...audio, AUTH_DATABASE_URL: 'not-loaded' })
    .map(([key, value]) => key + '=' + value).join('\n'));
  const config = loadWorkspaceSettings({ root, env: { COS_BUCKET: 'existing-image-bucket' } });
  for (const [key, value] of Object.entries(audio)) assert.equal(config[key], value);
  assert.equal(config.COS_BUCKET, 'existing-image-bucket');
  assert.equal(config.AUTH_DATABASE_URL, undefined);
  const production = { NODE_ENV: 'production', MIX_AUDIO_COS_BUCKET: 'production-audio-bucket' };
  assert.deepEqual(loadWorkspaceSettings({ root, env: production }), production);
});
