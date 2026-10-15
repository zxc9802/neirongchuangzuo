import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { requireInviteDatabase } from '../services/digital-human/scripts/registration-invites.mjs';
import { bindAccountPhone, normalizePhone } from '../services/digital-human/src/lib/server/account-phones.mjs';

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 4 || argv[0] !== '--account' || argv[2] !== '--phone') throw new Error('用法：node scripts/account-phone.mjs --account 用户名 --phone 手机号');
  const phone = normalizePhone(argv[3]);
  const { default: pg } = await import('pg');
  const databaseUrl = requireInviteDatabase();
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 12000 });
  const internal = process.env.INTERNAL_AUTH_DATABASE_URL ? new pg.Client({ connectionString: process.env.INTERNAL_AUTH_DATABASE_URL, connectionTimeoutMillis: 12000 }) : null;
  try {
    await client.connect();
    if (internal) {
      await internal.connect();
      const result = await internal.query("SELECT id FROM public.users WHERE lower(email)=$1 AND billing_audience='internal' LIMIT 1", [phone]);
      if (result.rowCount) throw new Error('这个手机号已有内部账号记录，未修改绑定。');
    }
    console.log(JSON.stringify(await bindAccountPhone(client, { account: argv[1], phone })));
  } finally { await client.end().catch(() => {}); await internal?.end().catch(() => {}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
