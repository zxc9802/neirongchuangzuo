import { readFileSync } from 'node:fs';

export function workspaceAuthRequired() {
  if (process.env.NODE_ENV === 'production') return true;
  let local = '';
  try { local = readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').match(/^AUTH_MODE=(.*)$/m)?.[1].trim() || ''; }
  catch { /* Local preview may run without account configuration. */ }
  return (process.env.AUTH_MODE || local) === 'standalone';
}

export async function getWorkspaceUser(req, backend) {
  if (!req.headers.cookie) return null;
  const response = await fetch(new URL('/api/session', backend), {
    headers: { cookie: req.headers.cookie }, redirect: 'error', signal: AbortSignal.timeout(12_000),
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error('Account service unavailable');
  const data = await response.json();
  const user = data.data?.user;
  if (data.success !== true || data.data?.authMode !== 'standalone' || typeof user?.id !== 'string' || !user.id) throw new Error('Account service not configured');
  return { id: user.id, account: user.account, nickname: user.nickname, authSource: user.authSource || 'local' };
}
