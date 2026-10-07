import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { normalizeInviteCode, hashInviteCode, generateInviteCode, REGISTRATION_INVITES_SCHEMA_SQL } from '../src/lib/server/registration-invites.mjs';
import { assertPrivateOutput, parseInviteArguments, requireInviteDatabase, runInviteOperation } from '../scripts/registration-invites.mjs';

const PRIVATE_DIR = await mkdtemp(join(tmpdir(), 'registration-invites-'));
test.after(() => rm(PRIVATE_DIR, { recursive: true, force: true }));
function fakeDatabase() {
  let records = new Map(), snapshot;
  const queries = [];
  const client = { async query(sql, params = []) {
    queries.push({ sql, params });
    if (client.failInsert && sql.includes('INSERT INTO')) throw new Error('driver detail must not be logged');
    if (sql === 'BEGIN') snapshot = structuredClone(records);
    else if (sql === 'COMMIT') {
      if (client.commitThenFail) { snapshot = undefined; throw new Error('commit acknowledgement lost'); }
      if (client.failCommit) throw new Error('commit failed'); snapshot = undefined;
    }
    else if (sql === 'ROLLBACK') { records = snapshot ?? records; snapshot = undefined; }
    else if (sql.includes('INSERT INTO')) {
      if (records.has(params[0])) return { rows: [] };
      records.set(params[0], { code_hash: params[0], created_at: params[1], expires_at: params[2], redeemed_at: null, redeemed_by: null });
      return { rows: [{ code_hash: params[0] }] };
    } else if (sql.startsWith('UPDATE')) {
      const record = records.get(params[0]);
      if (!record || record.redeemed_at !== null || record.expires_at === 0) return { rows: [] };
      record.expires_at = 0; return { rows: [{ code_hash: record.code_hash }] };
    } else if (sql.includes('COUNT(*)')) {
      const all = [...records.values()];
      return { rows: [{ unused: String(all.filter(record => record.redeemed_at == null && (record.expires_at == null || record.expires_at > params[0])).length),
        redeemed: String(all.filter(record => record.redeemed_at != null).length),
        expired: String(all.filter(record => record.redeemed_at == null && record.expires_at != null && record.expires_at <= params[0]).length) }] };
    }
    return { rows: [] };
  } };
  return { client, queries, records: () => records };
}

test('invite helper accepts only six mixed uppercase letters and digits, never ambiguous Unicode or pure categories', () => {
  assert.equal(normalizeInviteCode(' a1b2c3 '), 'A1B2C3');
  assert.equal(hashInviteCode(' a1b2c3 '), hashInviteCode('A1B2C3'));
  assert.match(hashInviteCode('A1B2C3'), /^[a-f0-9]{64}$/);
  for (const invalid of [null, undefined, 123456, 'ABCDEF', '123456', 'AB12', 'ABC1234', 'AB-123', 'Ａ1B2C3', 'А1B2C3', 'A1 B2C3']) {
    assert.equal(normalizeInviteCode(invalid), null);
    assert.throws(() => hashInviteCode(invalid));
  }
  for (let index = 0; index < 1000; index++) {
    const code = generateInviteCode(); assert.equal(normalizeInviteCode(code), code);
  }
  assert.match(REGISTRATION_INVITES_SCHEMA_SQL, /digital_human_auth\.registration_invites/);
  assert.match(REGISTRATION_INVITES_SCHEMA_SQL, /CHECK \(\(redeemed_at IS NULL\) = \(redeemed_by IS NULL\)\)/);
  assert.doesNotMatch(REGISTRATION_INVITES_SCHEMA_SQL, /REFERENCES|FOREIGN KEY/i);
});

test('CLI argument validation requires absolute private output and caps counts and days', () => {
  assert.deepEqual(parseInviteArguments(['generate', '--out', join(PRIVATE_DIR, 'codes.txt')]), { command: 'generate', count: 20, out: join(PRIVATE_DIR, 'codes.txt'), days: null });
  assert.equal(parseInviteArguments(['generate', '--count', '1000', '--days', '7', '--out', join(PRIVATE_DIR, 'codes.txt')]).days, 7);
  assert.deepEqual(parseInviteArguments(['revoke', '--code', ' a1b2c3 ']), { command: 'revoke', code: 'A1B2C3' });
  assert.deepEqual(parseInviteArguments(['list']), { command: 'list' });
  for (const args of [[], ['generate'], ['generate', '--out', 'relative.txt'], ['generate', '--count', '1001', '--out', join(PRIVATE_DIR, 'codes.txt')],
    ['generate', '--count', '0', '--out', join(PRIVATE_DIR, 'codes.txt')], ['generate', '--days', '-1', '--out', join(PRIVATE_DIR, 'codes.txt')],
    ['generate', '--out', join(PRIVATE_DIR, 'codes.txt'), '--out', join(PRIVATE_DIR, 'other.txt')], ['list', '--code', 'A1B2C3'], ['revoke', '--code', 'ABCDEF']]) assert.throws(() => parseInviteArguments(args));
});

test('CLI refuses the legacy database even when credentials, protocol or default port spelling differ', () => {
  assert.throws(() => requireInviteDatabase({}), { code: 'DATABASE_NOT_CONFIGURED' });
  assert.throws(() => requireInviteDatabase({ AUTH_DATABASE_URL: 'postgres://new:secret@localhost/auth', INTERNAL_AUTH_DATABASE_URL: 'postgresql://readonly:different@127.0.0.1:5432/auth?sslmode=require' }), { code: 'LEGACY_DATABASE_REJECTED' });
  assert.equal(requireInviteDatabase({ AUTH_DATABASE_URL: 'postgres://new:secret@db/new_auth', INTERNAL_AUTH_DATABASE_URL: 'postgres://readonly:secret@db/legacy_auth' }), 'postgres://new:secret@db/new_auth');
  assert.throws(() => requireInviteDatabase({ AUTH_DATABASE_URL: 'https://db/auth' }), { code: 'INVALID_DATABASE' });
});

test('private exports work outside repositories without Git and cannot be created under any Git ancestor', async () => {
  const noGit = async () => { throw Object.assign(new Error('missing git'), { code: 'ENOENT' }); };
  await assertPrivateOutput(join(PRIVATE_DIR, 'external.txt'), { runGit: noGit });
  const nested = join(PRIVATE_DIR, 'repo', 'private'); await mkdir(nested, { recursive: true }); await mkdir(join(PRIVATE_DIR, 'repo', '.git'));
  await assert.rejects(assertPrivateOutput(join(nested, 'codes.txt'), { runGit: noGit }), { code: 'GIT_OUTPUT_REJECTED' });
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  await assert.rejects(assertPrivateOutput(join(projectRoot, 'invites.txt'), { runGit: noGit }), { code: 'GIT_OUTPUT_REJECTED' });
});

test('Git tracked or trackable exports are rejected while explicitly ignored untracked exports are permitted', async () => {
  const fakeGit = ({ tracked = false, ignored = false } = {}) => async (_git, args) => {
    if (args.includes('rev-parse')) return { stdout: PRIVATE_DIR };
    if (args.includes('ls-files')) return { stdout: tracked ? 'tracked.txt\n' : '' };
    if (args.includes('check-ignore') && ignored) return { stdout: '' };
    throw Object.assign(new Error('not ignored'), { code: 1 });
  };
  await assert.rejects(assertPrivateOutput(join(PRIVATE_DIR, 'codes.txt'), { runGit: fakeGit({ tracked: true, ignored: true }) }), { code: 'GIT_OUTPUT_REJECTED' });
  await assert.rejects(assertPrivateOutput(join(PRIVATE_DIR, 'codes.txt'), { runGit: fakeGit() }), { code: 'GIT_OUTPUT_REJECTED' });
  await assertPrivateOutput(join(PRIVATE_DIR, 'codes.txt'), { runGit: fakeGit({ ignored: true }) });
});

test('generation writes plaintext only to an exclusive private file and inserts only hashes transactionally', async () => {
  const db = fakeDatabase(), out = join(PRIVATE_DIR, 'generation.txt');
  const sequence = ['A1B2C3', 'A1B2C3', 'Z9Y8X7'];
  const result = await runInviteOperation({ command: 'generate', count: 2, days: 7, out }, { client: db.client, now: () => 1000, codeGenerator: () => sequence.shift() });
  assert.deepEqual((await readFile(out, 'utf8')).trim().split('\n'), ['A1B2C3', 'Z9Y8X7']);
  assert.equal(db.records().size, 2); assert.equal(result.generated, 2);
  assert.equal(result.expiresAt, 1000 + 7 * 86400000);
  assert.equal(JSON.stringify(db.queries).includes('A1B2C3'), false);
  assert.equal(JSON.stringify(result).includes('A1B2C3'), false);
  assert.ok([...db.records().keys()].every(key => /^[a-f0-9]{64}$/.test(key)));
  await assert.rejects(runInviteOperation({ command: 'generate', count: 1, days: null, out }, { client: db.client }), { code: 'OUTPUT_UNAVAILABLE' });
  assert.equal((await readFile(out, 'utf8')).trim().split('\n').length, 2);
});

test('failed inserts roll back all rows and remove only this operation owned export', async () => {
  const failed = fakeDatabase(); failed.client.failInsert = true;
  const out = join(PRIVATE_DIR, 'failInsert.txt');
  await assert.rejects(runInviteOperation({ command: 'generate', count: 1, days: null, out }, { client: failed.client, now: () => 1000, codeGenerator: () => 'A1B2C3' }), { code: 'DATABASE_OPERATION_FAILED' });
  assert.equal(failed.records().size, 0); assert.equal(failed.queries.at(-1).sql, 'ROLLBACK');
  await assert.rejects(access(out), { code: 'ENOENT' });
  const existing = join(PRIVATE_DIR, 'never-overwrite.txt'); await writeFile(existing, 'keep-private');
  const db = fakeDatabase();
  await assert.rejects(runInviteOperation({ command: 'generate', count: 1, days: null, out: existing }, { client: db.client }), { code: 'OUTPUT_UNAVAILABLE' });
  assert.equal(await readFile(existing, 'utf8'), 'keep-private'); assert.equal(db.queries.length, 0);
});

test('unknown commit outcome preserves the only plaintext export whether the database committed or rolled back', async () => {
  for (const point of ['failCommit', 'commitThenFail']) {
    const db = fakeDatabase(); db.client[point] = true;
    const out = join(PRIVATE_DIR, `${point}.txt`);
    await assert.rejects(runInviteOperation({ command: 'generate', count: 1, days: null, out }, { client: db.client, now: () => 1000, codeGenerator: () => 'A1B2C3' }), { code: 'COMMIT_RESULT_UNKNOWN' });
    assert.equal(db.records().size, point === 'commitThenFail' ? 1 : 0);
    assert.equal(db.queries.at(-1).sql, 'ROLLBACK');
    assert.equal(await readFile(out, 'utf8'), 'A1B2C3\n');
  }
});

test('summary exposes only aggregate counts and revocation preserves a tombstone without touching redeemed codes', async () => {
  const db = fakeDatabase(), out = join(PRIVATE_DIR, 'summary.txt');
  const sequence = ['A1B2C3', 'Z9Y8X7', 'N1M2L3'];
  await runInviteOperation({ command: 'generate', count: 3, days: null, out }, { client: db.client, now: () => 1000, codeGenerator: () => sequence.shift() });
  const used = db.records().get(hashInviteCode('Z9Y8X7')); used.redeemed_at = 1500; used.redeemed_by = 'user-1';
  const expired = db.records().get(hashInviteCode('N1M2L3')); expired.expires_at = 1000;
  assert.deepEqual(await runInviteOperation({ command: 'list' }, { client: db.client, now: () => 2000 }), { unused: 1, redeemed: 1, expired: 1 });
  assert.deepEqual(await runInviteOperation({ command: 'revoke', code: 'Z9Y8X7' }, { client: db.client }), { revoked: false });
  assert.equal(used.redeemed_by, 'user-1');
  assert.deepEqual(await runInviteOperation({ command: 'revoke', code: 'A1B2C3' }, { client: db.client }), { revoked: true });
  assert.equal(db.records().has(hashInviteCode('A1B2C3')), true); assert.equal(db.records().get(hashInviteCode('A1B2C3')).expires_at, 0);
  const regen = ['A1B2C3', 'Q1W2E3'];
  await runInviteOperation({ command: 'generate', count: 1, days: null, out: join(PRIVATE_DIR, 'regenerated.txt') }, { client: db.client, codeGenerator: () => regen.shift() });
  assert.equal((await readFile(join(PRIVATE_DIR, 'regenerated.txt'), 'utf8')).trim(), 'Q1W2E3');
});
