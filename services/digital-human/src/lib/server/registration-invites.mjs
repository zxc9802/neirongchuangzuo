import { createHash, randomInt } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function normalizeInviteCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z0-9]{6}$/.test(code) && /[A-Z]/.test(code) && /[0-9]/.test(code) ? code : null;
}

export function hashInviteCode(value) {
  const code = normalizeInviteCode(value);
  if (!code) throw new TypeError('Invalid registration invite code');
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

export function generateInviteCode() {
  // Rejection sampling keeps every permitted six-character code equally likely.
  for (;;) {
    const code = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    if (/[A-Z]/.test(code) && /[0-9]/.test(code)) return code;
  }
}

export const REGISTRATION_INVITES_SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS digital_human_auth;
CREATE TABLE IF NOT EXISTS digital_human_auth.registration_invites (
  code_hash TEXT PRIMARY KEY,
  created_at BIGINT NOT NULL,
  expires_at BIGINT,
  redeemed_at BIGINT,
  redeemed_by TEXT,
  CHECK ((redeemed_at IS NULL) = (redeemed_by IS NULL))
);
`;
