import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCreditsLedger } from '../services/credits/store.mjs';
import { requireInviteDatabase } from '../services/digital-human/scripts/registration-invites.mjs';

export function parseAccountCreditsArguments(argv) {
  const [command, flag, value, ...extra] = argv;
  if (!['unlimited', 'limited', 'status'].includes(command) || flag !== '--account' || extra.length
    || typeof value !== 'string' || value.length > 254 || !/^[^\s\u0000-\u001f\u007f]+$/.test(value.trim())) {
    throw new Error('使用 unlimited、limited 或 status --account 账号。');
  }
  return { command, account: value.trim().toLowerCase() };
}

export async function manageAccountCredits({ command, account }, { client, ledger }) {
  if (!['unlimited', 'limited', 'status'].includes(command) || typeof account !== 'string') throw new Error('操作参数无效。');
  const result = await client.query('SELECT id,email FROM digital_human_auth.users WHERE email=$1', [account]);
  if (result.rows.length !== 1) throw new Error('没有找到唯一的注册账号，未修改积分。');
  const user = result.rows[0];
  const credits = command === 'status' ? await ledger.snapshot(user.id) : await ledger.setUnlimited(user.id, command === 'unlimited');
  return { account: user.email, userId: user.id, credits };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseAccountCreditsArguments(argv);
  const databaseUrl = requireInviteDatabase();
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 12000 });
  const ledger = createCreditsLedger({ databaseUrl });
  try {
    await client.connect(); await ledger.ready;
    const result = await manageAccountCredits(options, { client, ledger });
    console.log(JSON.stringify({ account: result.account, unlimited: result.credits.unlimited,
      available: result.credits.available, held: result.credits.held }));
  } catch (error) {
    if (['没有找到唯一的注册账号，未修改积分。', '操作参数无效。'].includes(error?.message)) throw error;
    throw new Error('账号积分操作未确认，请先查询 status 后再重试。');
  } finally { await ledger.close().catch(() => {}); await client.end().catch(() => {}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
