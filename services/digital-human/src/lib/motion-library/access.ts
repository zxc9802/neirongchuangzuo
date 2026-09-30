import type {AccessContext} from '@/lib/access-control';

/** 动效库属于个人；管理员不跨账号访问，本地样例仅限未登录的单机模式。 */
export function canAccessEffect(access: AccessContext, effect: {userId?: string | null}): boolean {
  if (access.userId) return effect.userId === access.userId;
  return !access.isolated && !effect.userId;
}
