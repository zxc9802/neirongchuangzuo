const GLOBAL_MEDIA_VIEWER_ACCOUNTS = new Set([
  "11111111", // 王星
  "13919840885", // 王欣
]);

export interface MediaAccessContext {
  isolated: boolean;
  userId: string | null;
  isAdmin: boolean;
  session: { user: { account: string } } | null;
}

/** 管理员、王星、王欣可查看全部形象与声音；本地单机模式保持原行为。 */
export function canViewAllMedia(ctx: MediaAccessContext): boolean {
  if (!ctx.isolated || ctx.isAdmin) return true;
  const account = ctx.session?.user.account.trim().toLowerCase();
  return account ? GLOBAL_MEDIA_VIEWER_ACCOUNTS.has(account) : false;
}

/** 只有管理员或资源本人可修改、删除资源；全库查看账号不自动获得管理权。 */
export function canManageMediaItem(
  ctx: MediaAccessContext,
  item: { userId?: string | null }
): boolean {
  if (!ctx.isolated || ctx.isAdmin) return true;
  return Boolean(ctx.userId) && item.userId === ctx.userId;
}
