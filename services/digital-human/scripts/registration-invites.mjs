import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateInviteCode, hashInviteCode, normalizeInviteCode, REGISTRATION_INVITES_SCHEMA_SQL } from '../src/lib/server/registration-invites.mjs';

const execute = promisify(execFile);
const APP_ROOT = fileURLToPath(new URL('../', import.meta.url));
const PROJECT_ROOT = resolve(APP_ROOT, '../..');
const DAY_MS = 24 * 60 * 60 * 1000;
export class InviteCLIError extends Error {
  constructor(message, code = 'INVALID_ARGUMENT') { super(message); this.code = code; }
}

function integer(value, name, minimum, maximum) {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum) {
    throw new InviteCLIError(`${name}必须是${minimum}—${maximum}之间的整数。`);
  }
  return Number(value);
}

export function parseInviteArguments(argv) {
  const [command, ...rest] = argv;
  if (!['generate', 'list', 'revoke'].includes(command)) throw new InviteCLIError('使用 generate --out 绝对路径、list 或 revoke --code 邀请码。');
  const flags = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index], value = rest[index + 1];
    if (!['--count', '--out', '--days', '--code'].includes(key) || value === undefined || value.startsWith('--') || flags.has(key)) throw new InviteCLIError('参数不支持、缺少值或重复。');
    flags.set(key, value);
  }
  const allowed = command === 'generate' ? ['--count', '--out', '--days'] : command === 'revoke' ? ['--code'] : [];
  if ([...flags.keys()].some(key => !allowed.includes(key))) throw new InviteCLIError('当前操作不支持这些参数。');
  if (command === 'generate') {
    const out = flags.get('--out');
    if (!out || !isAbsolute(out) || /[\x00-\x1f]/.test(out)) throw new InviteCLIError('必须通过 --out 指定私有输出文件的绝对路径。');
    return { command, out: resolve(out), count: integer(flags.get('--count') ?? '20', '数量', 1, 1000),
      days: flags.has('--days') ? integer(flags.get('--days'), '有效天数', 1, 3650) : null };
  }
  if (command === 'revoke') {
    const code = normalizeInviteCode(flags.get('--code'));
    if (!code) throw new InviteCLIError('邀请码应为6位大写字母与数字的组合。');
    return { command, code };
  }
  return { command };
}

function databaseIdentity(value) {
  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname || url.pathname === '/') throw new Error();
    const host = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase()) ? 'loopback' : url.hostname.toLowerCase();
    return `${host}:${url.port || '5432'}/${decodeURIComponent(url.pathname.slice(1))}`;
  } catch { throw new InviteCLIError('数据库连接地址格式无效。', 'INVALID_DATABASE'); }
}

export function requireInviteDatabase(env = process.env) {
  const target = env.AUTH_DATABASE_URL;
  if (!target) throw new InviteCLIError('请先配置独立账号库 AUTH_DATABASE_URL。', 'DATABASE_NOT_CONFIGURED');
  const current = databaseIdentity(target);
  if (env.INTERNAL_AUTH_DATABASE_URL && current === databaseIdentity(env.INTERNAL_AUTH_DATABASE_URL)) {
    throw new InviteCLIError('独立账号库与旧账号库相同，已拒绝写入。', 'LEGACY_DATABASE_REJECTED');
  }
  return target;
}

/** Refuse export to a tracked or trackable file, including files in another Git repository. */
export async function assertPrivateOutput(out, { runGit = execute } = {}) {
  if (!isAbsolute(out) || /[\x00-\x1f]/.test(out)) throw new InviteCLIError('输出路径必须为绝对路径。');
  const requestedParent = dirname(resolve(out));
  for (let cursor = requestedParent; ; cursor = dirname(cursor)) {
    const stat = await lstat(cursor).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new InviteCLIError('请先创建真实的私有输出目录，不能经过符号链接。', 'UNSAFE_OUTPUT');
    if (cursor === dirname(cursor)) break;
  }
  // Canonicalize benign Windows short-name aliases as well; they are not symlinks.
  const parent = await realpath(requestedParent);
  async function allowOutsideRepositories() {
    const within = relative(PROJECT_ROOT, parent);
    if (within === '' || !within.startsWith('..') && !isAbsolute(within)) throw new InviteCLIError('项目内输出无法确认已忽略，请选择项目外的私有目录。', 'GIT_OUTPUT_REJECTED');
    for (let cursor = parent; ; cursor = dirname(cursor)) {
      try { await lstat(join(cursor, '.git')); throw new InviteCLIError('代码库内输出无法确认已忽略，请选择代码库外的私有目录。', 'GIT_OUTPUT_REJECTED'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (cursor === dirname(cursor)) break;
    }
  }
  let gitRoot;
  try { gitRoot = (await runGit('git', ['-C', parent, 'rev-parse', '--show-toplevel'], { windowsHide: true, encoding: 'utf8' })).stdout.trim(); }
  catch (error) {
    // A non-repository folder is private by location. Other failures cannot prove export safety.
    if (error.code === 'ENOENT' || error.code === 128 && /not a git repository/i.test(error.stderr || '')) return allowOutsideRepositories();
    throw new InviteCLIError('无法确认输出目录是否安全，请检查 Git 或选择不在代码库内的私有目录。', 'UNSAFE_OUTPUT');
  }
  if (!gitRoot) throw new InviteCLIError('无法确认输出目录是否安全。', 'UNSAFE_OUTPUT');
  const { stdout: tracked } = await runGit('git', ['-C', gitRoot, 'ls-files', '--', out], { windowsHide: true, encoding: 'utf8' });
  if (tracked.trim()) throw new InviteCLIError('输出位置是 Git 已跟踪文件，请选择私有目录。', 'GIT_OUTPUT_REJECTED');
  try { await runGit('git', ['-C', gitRoot, 'check-ignore', '--quiet', '--', out], { windowsHide: true, encoding: 'utf8' }); }
  catch { throw new InviteCLIError('输出位置会被 Git 跟踪，请使用仓库外目录或明确忽略的私有目录。', 'GIT_OUTPUT_REJECTED'); }
}

/** Inject a dedicated database client in tests; no legacy database is opened by this module. */
export async function runInviteOperation(options, { client, now = Date.now, codeGenerator = generateInviteCode, checkOutput = assertPrivateOutput } = {}) {
  if (!client?.query) throw new InviteCLIError('账号数据库连接不可用。', 'DATABASE_UNAVAILABLE');
  let output, outputOwned = false, transaction = false, committed = false, commitAttempted = false;
  try {
    if (options.command === 'generate') {
      await checkOutput(options.out);
      try { output = await open(options.out, 'wx', 0o600); outputOwned = true; }
      catch (cause) { throw new InviteCLIError(cause.code === 'EEXIST' ? '输出文件已存在，已拒绝覆盖。' : '无法创建私有输出文件。', 'OUTPUT_UNAVAILABLE'); }
    }
    await client.query('BEGIN'); transaction = true;
    await client.query(REGISTRATION_INVITES_SCHEMA_SQL);
    const timestamp = now();
    let result;
    if (options.command === 'generate') {
      const count = options.count, expiresAt = options.days == null ? null : timestamp + options.days * DAY_MS;
      if (!Number.isSafeInteger(count) || count < 1 || count > 1000 || options.days != null && (!Number.isSafeInteger(options.days) || options.days < 1 || options.days > 3650)
        || !Number.isSafeInteger(timestamp) || timestamp < 0 || !Number.isSafeInteger(expiresAt ?? timestamp)) throw new InviteCLIError('生成参数或时间无效。');
      const codes = [], seen = new Set();
      for (let attempt = 0; codes.length < count; attempt++) {
        if (attempt >= count * 100) throw new InviteCLIError('生成碰撞过多，请重新运行。', 'CODE_GENERATION_FAILED');
        const code = normalizeInviteCode(codeGenerator());
        if (!code) throw new InviteCLIError('邀请码生成器返回了无效格式。', 'CODE_GENERATION_FAILED');
        if (seen.has(code)) continue;
        seen.add(code);
        const inserted = await client.query(`INSERT INTO digital_human_auth.registration_invites
          (code_hash,created_at,expires_at) VALUES ($1,$2,$3) ON CONFLICT (code_hash) DO NOTHING RETURNING code_hash`, [hashInviteCode(code), timestamp, expiresAt]);
        if (inserted.rows.length) codes.push(code);
      }
      // Complete and sync the private export before COMMIT. Any earlier error rolls back hashes and removes this file.
      await output.writeFile(codes.join('\n') + '\n', 'utf8'); await output.sync(); await output.close(); output = undefined;
      result = { generated: count, expiresAt, out: options.out };
    } else if (options.command === 'list') {
      const { rows } = await client.query(`SELECT
        COUNT(*) FILTER (WHERE redeemed_at IS NULL AND (expires_at IS NULL OR expires_at > $1)) AS unused,
        COUNT(*) FILTER (WHERE redeemed_at IS NOT NULL) AS redeemed,
        COUNT(*) FILTER (WHERE redeemed_at IS NULL AND expires_at IS NOT NULL AND expires_at <= $1) AS expired
        FROM digital_human_auth.registration_invites`, [timestamp]);
      result = { unused: Number(rows[0].unused), redeemed: Number(rows[0].redeemed), expired: Number(rows[0].expired) };
    } else if (options.command === 'revoke') {
      const code = normalizeInviteCode(options.code);
      if (!code) throw new InviteCLIError('邀请码格式无效。');
      // Keep a tombstone so this exact code can never be generated again by a future collision.
      const revoked = await client.query('UPDATE digital_human_auth.registration_invites SET expires_at=0 WHERE code_hash=$1 AND redeemed_at IS NULL AND (expires_at IS NULL OR expires_at > 0) RETURNING code_hash', [hashInviteCode(code)]);
      result = { revoked: revoked.rows.length === 1 };
    } else throw new InviteCLIError('操作不支持。');
    commitAttempted = true;
    await client.query('COMMIT'); committed = true; transaction = false;
    return result;
  } catch (cause) {
    if (transaction) await client.query('ROLLBACK').catch(() => {});
    await output?.close().catch(() => {}); output = undefined;
    if (outputOwned && !committed && !commitAttempted) await unlink(options.out).catch(() => {});
    if (outputOwned && commitAttempted && !committed) {
      // The server may have committed before its acknowledgement was lost. Preserve the only plaintext copy.
      throw new InviteCLIError('数据库提交结果待核对，私有输出文件已保留；请由管理员核对数据库后再分发或重试。', 'COMMIT_RESULT_UNKNOWN');
    }
    if (cause instanceof InviteCLIError) throw cause;
    // PostgreSQL errors can include parameters; never expose them or exported codes in logs.
    throw new InviteCLIError('邀请码操作失败，数据库事务已尝试回滚；请检查连接与权限后重试。', 'DATABASE_OPERATION_FAILED');
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseInviteArguments(argv);
  const { default: nextEnv } = await import('@next/env');
  nextEnv.loadEnvConfig(APP_ROOT, false, { info() {}, error() {} });
  const databaseUrl = requireInviteDatabase();
  if (options.command === 'generate') await assertPrivateOutput(options.out);
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 12_000 });
  try {
    await client.connect();
    const result = await runInviteOperation(options, { client });
    if (options.command === 'generate') console.log(`已生成 ${result.generated} 个邀请码，仅写入指定私有文件。`);
    else if (options.command === 'list') console.log(`未使用：${result.unused}；已使用：${result.redeemed}；已过期：${result.expired}。`);
    else console.log(result.revoked ? '已撤销未使用的邀请码。' : '未找到可撤销的未使用邀请码。');
  } catch (cause) {
    if (cause instanceof InviteCLIError) throw cause;
    throw new InviteCLIError('无法操作独立账号库，请检查数据库连接和权限。', 'DATABASE_UNAVAILABLE');
  } finally { await client.end().catch(() => {}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(cause => { console.error(cause instanceof InviteCLIError ? cause.message : '邀请码管理操作失败。'); process.exitCode = 1; });
}
