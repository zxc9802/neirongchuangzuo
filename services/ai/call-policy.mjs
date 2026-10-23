import { AsyncLocalStorage } from 'node:async_hooks';

const policy = new AsyncLocalStorage();

export function isDailyCallExempt(userId) {
  const current = policy.getStore();
  return current?.dailyExempt === true && (!userId || !current.userId || current.userId === userId);
}

export function isCallRateExempt(userId) {
  const current = policy.getStore();
  return current?.callsUnlimited === true && (!userId || !current.userId || current.userId === userId);
}

export function withDailyCallPolicy(dailyExempt, operation, userId, callsUnlimited = false) {
  return policy.run({ dailyExempt: dailyExempt === true || callsUnlimited === true, callsUnlimited: callsUnlimited === true, userId }, operation);
}

export function dailyCallExemptAccount(account, accounts = 'zxc9911') {
  if (typeof account !== 'string' || !account.trim()) return false;
  return new Set(String(accounts).split(',').map(value => value.trim().toLowerCase()).filter(Boolean)).has(account.trim().toLowerCase());
}
