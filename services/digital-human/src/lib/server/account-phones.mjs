export const ACCOUNT_PHONES_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS digital_human_auth.account_phones (
    user_id TEXT PRIMARY KEY REFERENCES digital_human_auth.users(id) ON DELETE CASCADE,
    phone TEXT NOT NULL UNIQUE CHECK (phone ~ '^1[3-9][0-9]{9}$'),
    bound_at BIGINT NOT NULL
  );
`;

export const ACCOUNT_IDENTITY_LOCK_SQL = 'SELECT pg_advisory_xact_lock(914281736)';
export const ACCOUNT_LOOKUP_SQL = `
  SELECT u.* FROM digital_human_auth.users u
  WHERE u.email=$1 OR EXISTS (
    SELECT 1 FROM digital_human_auth.account_phones p WHERE p.user_id=u.id AND p.phone=$1
  ) LIMIT 2
`;

export function normalizePhone(value) {
  if (typeof value !== 'string' || !/^1[3-9][0-9]{9}$/.test(value.trim())) {
    throw new Error('请输入有效的11位手机号。');
  }
  return value.trim();
}

export async function bindAccountPhone(client, { account, phone, expectedUserId, now = Date.now() }) {
  phone = normalizePhone(phone);
  if (typeof account !== 'string' || !/^[^\s\u0000-\u001f\u007f]{1,254}$/.test(account.trim())) throw new Error('账号格式无效。');
  account = account.trim().toLowerCase();
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(914281735)');
    await client.query(ACCOUNT_PHONES_SCHEMA_SQL);
    await client.query(ACCOUNT_IDENTITY_LOCK_SQL);
    const { rows: [user] } = await client.query('SELECT id,email FROM digital_human_auth.users WHERE email=$1 FOR UPDATE', [account]);
    if (!user || (expectedUserId && user.id !== expectedUserId)) throw new Error('没有找到指定账号，未绑定手机号。');
    const occupied = await client.query(ACCOUNT_LOOKUP_SQL, [phone]);
    if (occupied.rows.some(other => other.id !== user.id)) throw new Error('这个手机号已被其他账号使用，未修改绑定。');
    await client.query(`INSERT INTO digital_human_auth.account_phones(user_id,phone,bound_at) VALUES($1,$2,$3)
      ON CONFLICT(user_id) DO UPDATE SET phone=EXCLUDED.phone,bound_at=EXCLUDED.bound_at
      WHERE account_phones.phone<>EXCLUDED.phone`, [user.id, phone, now]);
    await client.query('COMMIT');
    return { userId: user.id, account: user.email, phone };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
