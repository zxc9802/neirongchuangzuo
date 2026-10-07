import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { NextRequest } from 'next/server.js';
import { normalizeInviteCode, hashInviteCode, generateInviteCode } from '../src/lib/server/registration-invites.mjs';
import { requireRegistrationInvite, registerAccount, AuthError } from '../src/lib/server/standalone-auth.ts';

const INVALID = '邀请码无效或已使用，请向管理员获取新邀请码';
test('invitation format is six case-normalized alphanumeric characters with a letter and a digit', () => {
  for (const value of [undefined, null, '', '   ']) assert.throws(() => requireRegistrationInvite(value), error => error instanceof AuthError && error.status === 400 && error.message === '请输入邀请码');
  for (const value of [false, 123456, {}, [], '123456', 'ABCDEF', 'A1B2C', 'A1B2C3D', 'A1-B2C', 'A1 B2C', '邀请码123', 'A1B2C\u0000', 'A'.repeat(10000)]) {
    assert.equal(normalizeInviteCode(value), null);
    assert.throws(() => requireRegistrationInvite(value), error => error instanceof AuthError && error.status === 403 && error.message === INVALID);
  }
  assert.equal(requireRegistrationInvite('  a1b2c3  '), 'A1B2C3');
  assert.equal(hashInviteCode('A1B2C3').length, 64);
  for (let index = 0; index < 100; index++) {
    const code = generateInviteCode(); assert.match(code, /^(?=.*[A-Z])(?=.*\d)[A-Z0-9]{6}$/); assert.equal(normalizeInviteCode(code), code);
  }
});

test('register function validates invitation before account hashing or database access', async () => {
  await assert.rejects(registerAccount('not-persisted', undefined, 'short'), error => error.status === 400 && error.message === '请输入邀请码');
  await assert.rejects(registerAccount('not-persisted', undefined, 'short', 'wrong-format'), error => error.status === 403 && error.message === INVALID);
  await assert.rejects(registerAccount('not-persisted', undefined, 'short', 'A1B2C3'), error => error.status === 400 && /密码/.test(error.message));
});

if (!process.env.TEST_DATABASE_URL) {
  test('one-use invitations PostgreSQL transactions', { skip: 'Set TEST_DATABASE_URL to a disposable PostgreSQL server' }, () => {});
} else {
  const admin = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await admin.connect();
  const name = `invite_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(process.env.TEST_DATABASE_URL); url.pathname = `/${name}`;
  process.env.AUTH_MODE = 'standalone'; process.env.AUTH_DATABASE_URL = url.toString(); delete process.env.INTERNAL_AUTH_DATABASE_URL;
  process.env.AUTH_PUBLIC_URL = 'https://invite.test'; process.env.NODE_ENV = 'production';
  const database = new Client({ connectionString: url.toString() }); await database.connect();
  const auth = await import('../src/lib/server/standalone-auth.ts');
  const { POST, GET } = await import('../src/app/api/auth/[action]/route.ts');
  await auth.consumeAuthAttempt('test-fixture-schema', 1);
  test.after(async () => { await database.end(); await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); await admin.end(); });
  function request(action, body) { return new NextRequest(`https://invite.test/api/auth/${action}`, { method: body === undefined ? 'GET' : 'POST', headers: { origin: 'https://invite.test', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
  const post = (action, body) => POST(request(action, body), { params: Promise.resolve({ action }) });
  const signup = (account, inviteCode, extra = {}) => post('register', { account, password: 'invitation-test-password', inviteCode, ...extra });
  async function issue({ expiresAt = null } = {}) {
    const code = generateInviteCode(); await database.query('INSERT INTO digital_human_auth.registration_invites(code_hash,created_at,expires_at) VALUES ($1,$2,$3)', [hashInviteCode(code), Date.now(), expiresAt]); return code;
  }
  const lookup = async code => (await database.query('SELECT * FROM digital_human_auth.registration_invites WHERE code_hash=$1', [hashInviteCode(code)])).rows[0];
  const counts = async () => (await database.query('SELECT (SELECT count(*)::int FROM digital_human_auth.users) AS users, (SELECT count(*)::int FROM digital_human_auth.sessions) AS sessions')).rows[0];

  test('invalid, missing, unknown and expired invites never create accounts or sessions or expose codes', async () => {
    const before = await counts();
    for (const [value, status] of [[undefined, 400], ['', 400], ['ABCDEF', 403], [123456, 403], ['Z9Y8X7', 403]]) {
      const response = await signup(`invalid_${randomUUID()}`, value); assert.equal(response.status, status);
      const data = await response.json(); assert.deepEqual(data, { error: status === 400 ? '请输入邀请码' : INVALID });
      assert.equal(response.cookies.get(auth.AUTH_COOKIE), undefined); assert.doesNotMatch(JSON.stringify(data), /code_hash|redeemed|postgresql|Z9Y8X7|ABCDEF/);
    }
    const expired = await issue({ expiresAt: Date.now() - 1 });
    const response = await signup('expired-invite-user', expired); assert.equal(response.status, 403); assert.deepEqual(await response.json(), { error: INVALID }); assert.equal((await lookup(expired)).redeemed_at, null);
    assert.deepEqual(await counts(), before);
  });

  test('successful registration redeems the hashed code once; login never needs an invitation', async () => {
    const code = await issue(), response = await signup('one-use-account', ` ${code.toLowerCase()} `);
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { success: true });
    const token = response.cookies.get(auth.AUTH_COOKIE)?.value, session = await auth.readStandaloneSession(token);
    const saved = await lookup(code); assert.match(saved.code_hash, /^[0-9a-f]{64}$/); assert.notEqual(saved.code_hash, code); assert.ok(saved.redeemed_at); assert.equal(saved.redeemed_by, session.user.id);
    assert.deepEqual(Object.keys(saved).sort(), ['code_hash', 'created_at', 'expires_at', 'redeemed_at', 'redeemed_by']);
    const before = await counts(), replay = await signup('replay-account', code); assert.equal(replay.status, 403); assert.deepEqual(await replay.json(), { error: INVALID }); assert.deepEqual(await counts(), before);
    const login = await post('login', { account: 'one-use-account', password: 'invitation-test-password' }); assert.equal(login.status, 200);
    const discovery = await GET(request('info'), { params: Promise.resolve({ action: 'info' }) }); assert.doesNotMatch(JSON.stringify(await discovery.json()), new RegExp(code));
  });

  test('concurrent registrations with the same invite commit one account and one redemption', async () => {
    const code = await issue(), before = await counts();
    const responses = await Promise.all([signup('parallel-first', code), signup('parallel-second', code)]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 403]);
    const saved = await lookup(code); assert.ok(saved.redeemed_at); assert.ok(saved.redeemed_by);
    const after = await counts(); assert.equal(after.users - before.users, 1); assert.equal(after.sessions - before.sessions, 1);
    const winner = (await database.query('SELECT email FROM digital_human_auth.users WHERE id=$1', [saved.redeemed_by])).rows[0]; assert.ok(['parallel-first', 'parallel-second'].includes(winner.email));
  });

  test('validation and duplicate account failures preserve the code for a later valid registration', async () => {
    const code = await issue();
    assert.equal((await signup('invalid-password', code, { password: 'short' })).status, 400); assert.equal((await lookup(code)).redeemed_at, null);
    assert.equal((await signup('one-use-account', code)).status, 409); assert.equal((await lookup(code)).redeemed_at, null);
    assert.equal((await signup('recovered-account', code)).status, 200); assert.ok((await lookup(code)).redeemed_at);
  });

  test('a session insertion failure rolls back the account and invite redemption transaction', async () => {
    const code = await issue(), before = await counts();
    await database.query(`CREATE FUNCTION digital_human_auth.reject_test_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test session storage failure'; END $$;
      CREATE TRIGGER reject_test_session BEFORE INSERT ON digital_human_auth.sessions FOR EACH ROW EXECUTE FUNCTION digital_human_auth.reject_test_session()`);
    try {
      const response = await signup('session-storage-failure', code); assert.equal(response.status, 503); assert.equal(response.cookies.get(auth.AUTH_COOKIE), undefined);
      assert.deepEqual(await response.json(), { error: '账号服务暂时不可用，请稍后重试' });
      assert.deepEqual(await counts(), before); assert.equal((await lookup(code)).redeemed_at, null); assert.equal((await lookup(code)).redeemed_by, null);
    } finally { await database.query('DROP TRIGGER reject_test_session ON digital_human_auth.sessions; DROP FUNCTION digital_human_auth.reject_test_session()'); }
    assert.equal((await signup('session-storage-recovered', code)).status, 200);
  });
}
