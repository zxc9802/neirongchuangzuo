import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as crypto from 'node:crypto';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';
import * as invites from '../src/lib/server/registration-invites.mjs';
import * as phones from '../src/lib/server/account-phones.mjs';

test('database call exemption defaults off and updates existing sessions immediately', async t => {
  const database = new PGlite(); await database.waitReady;
  t.after(() => database.close());
  const saved = process.env.AUTH_DATABASE_URL;
  process.env.AUTH_DATABASE_URL = 'postgresql://fixture.invalid/test';
  t.after(() => { if (saved === undefined) delete process.env.AUTH_DATABASE_URL; else process.env.AUTH_DATABASE_URL = saved; });
  const query = async (sql, params) => params ? database.query(sql, params) : (await database.exec(sql)).at(-1);
  class Pool {
    on() {}
    query(sql, params) { return query(sql, params); }
    async connect() { return { query, release() {} }; }
  }
  const dependencies = {
    'server-only': {}, 'node:crypto': crypto, pg: { Pool },
    './internal-auth': { validateInternalAccount: async () => null },
    './registration-invites.mjs': invites, './account-phones.mjs': phones,
  };
  const code = ts.transpileModule(fs.readFileSync(new URL('../src/lib/server/standalone-auth.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(name in dependencies, name); return dependencies[name];
  }, module, module.exports);
  const { readStandaloneSession } = module.exports;
  const token = crypto.randomBytes(32).toString('base64url');
  assert.equal(await readStandaloneSession(token), null);
  await database.query("INSERT INTO digital_human_auth.users(id,email,nickname,password,created_at) VALUES ('owner','owner','owner','unused',0),('other','other','other','unused',0)");
  await database.query('INSERT INTO digital_human_auth.sessions(hash,user_id,expires_at) VALUES ($1,$2,$3)',
    [crypto.createHash('sha256').update(token).digest('hex'), 'owner', Date.now() + 60000]);
  assert.equal((await readStandaloneSession(token)).user.callsUnlimited, false);
  await database.query("UPDATE digital_human_auth.users SET calls_unlimited=TRUE WHERE id='owner'");
  assert.equal((await readStandaloneSession(token)).user.callsUnlimited, true);
  assert.equal((await database.query("SELECT calls_unlimited FROM digital_human_auth.users WHERE id='other'")).rows[0].calls_unlimited, false);
  await database.query("UPDATE digital_human_auth.users SET calls_unlimited=FALSE WHERE id='owner'");
  assert.equal((await readStandaloneSession(token)).user.callsUnlimited, false);
  assert.equal(await readStandaloneSession('invalid'), null);
});
