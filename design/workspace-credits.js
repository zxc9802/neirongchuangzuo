// Prices and balances are supplied by the account service; browser storage is never a ledger.
const state = { owner: null, snapshot: null, error: '', stale: true, loading: false };
const listeners = new Set();
const observedTasks = new Map();
let pending = null;
let refreshAgain = false;
const owner = () => globalThis.workspaceUser?.id || null;
const whole = value => Number.isSafeInteger(value) && value >= 0;

export function normalizeCredits(value) {
  const data = value?.credits || value;
  const available = data?.available ?? data?.balance;
  const pricing = data?.pricing;
  if (!whole(available) || !whole(data?.held) || !whole(data?.total)
    || !whole(pricing?.imagePerUnit) || pricing.imagePerUnit < 1
    || !whole(pricing?.videoPoints) || pricing.videoPoints < 1
    || !Number.isFinite(pricing?.videoSeconds) || pricing.videoSeconds <= 0) return null;
  return { available, balance: available, held: data.held, total: data.total,
    initialPoints: whole(data.initialPoints) ? data.initialPoints : pricing.initialPoints,
    pricing: { ...pricing } };
}
function ensureOwner() {
  const id = owner();
  if (state.owner !== id) {
    state.owner = id; state.snapshot = null; state.error = ''; state.stale = true;
    state.loading = false; pending = null; refreshAgain = false; observedTasks.clear();
  }
  return id;
}
export function workspaceCreditsState() { ensureOwner(); return { ...state, snapshot: state.snapshot && { ...state.snapshot, pricing: { ...state.snapshot.pricing } } }; }
export function imagePoints(count, snapshot = workspaceCreditsState().snapshot) {
  return Number.isSafeInteger(count) && count > 0 && snapshot?.pricing?.imagePerUnit > 0 ? count * snapshot.pricing.imagePerUnit : null;
}
export function videoPoints(seconds, snapshot = workspaceCreditsState().snapshot) {
  return Number.isFinite(seconds) && seconds > 0 && snapshot?.pricing?.videoPoints > 0 && snapshot?.pricing?.videoSeconds > 0
    ? Math.ceil(seconds * snapshot.pricing.videoPoints / snapshot.pricing.videoSeconds) : null;
}
export function estimatedSpeechSeconds(text, speed = 1) {
  const length = String(text || '').replace(/\s/g, '').length;
  return length ? Math.max(1, Math.round(length / 4 / (Number.isFinite(speed) && speed > 0 ? speed : 1))) : null;
}
export function creditInsufficiency(points, current = workspaceCreditsState()) {
  if (current.stale || !current.snapshot || !Number.isFinite(points)) return '';
  return points > current.snapshot.available ? `积分不足，本次预计需要 ${points} 积分，可用 ${current.snapshot.available} 积分。` : '';
}
export function creditEstimateText(points) {
  const current = workspaceCreditsState();
  if (!Number.isFinite(points)) return current.error ? '积分价格暂时无法读取' : '正在读取积分价格…';
  return `预计 ${points} 积分${current.stale ? ' · 余额待刷新' : ''}`;
}
export function videoCreditEstimateText(seconds) {
  const points = videoPoints(seconds), current = workspaceCreditsState();
  if (!Number.isFinite(points)) {
    const p = current.snapshot?.pricing;
    return p ? `${p.videoSeconds} 秒 ${p.videoPoints} 积分 · 按实际时长` : creditEstimateText(null);
  }
  return `约 ${seconds} 秒 · ${creditEstimateText(points)} · 按实际时长`;
}
function notify() { for (const listener of listeners) { try { listener(workspaceCreditsState()); } catch { /* One disconnected view cannot prevent account updates. */ } } }
export function subscribeWorkspaceCredits(listener) { listeners.add(listener); return () => listeners.delete(listener); }
export async function refreshWorkspaceCredits({ afterCurrent = false } = {}) {
  const id = ensureOwner();
  if (!id) return null;
  if (pending) { if (afterCurrent) refreshAgain = true; return pending; }
  state.loading = true;
  const request = Promise.resolve().then(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('/api/workspace/credits', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 401 ? '登录已失效，请重新登录。' : '积分暂时无法读取，请刷新重试。');
      const snapshot = normalizeCredits(await response.json());
      if (!snapshot) throw new Error('积分服务返回的数据不完整，请刷新重试。');
      if (owner() !== id || state.owner !== id) return null;
      state.snapshot = snapshot; state.error = ''; state.stale = false;
      return snapshot;
    } catch (error) {
      if (owner() === id && state.owner === id) { state.error = error.name === 'AbortError' ? '积分查询超时，请刷新重试。' : error.message; state.stale = true; }
      return null;
    } finally {
      clearTimeout(timer);
      if (owner() === id && state.owner === id) {
        state.loading = false; pending = null; notify();
        if (refreshAgain) { refreshAgain = false; queueMicrotask(() => { void refreshWorkspaceCredits(); }); }
      }
    }
  });
  pending = request;
  return request;
}
export function observeCreditTask(task) {
  if (!task?.id || !owner()) return;
  const signature = JSON.stringify([task.status || task.state, task.billing?.reservedPoints, task.billing?.chargedPoints, task.billing?.status]);
  const key = `${task.id}:${task.kind || ''}`;
  if (observedTasks.get(key) === signature) return;
  observedTasks.set(key, signature);
  if (observedTasks.size > 300) observedTasks.delete(observedTasks.keys().next().value);
  void refreshWorkspaceCredits({ afterCurrent: true });
}
export function billingPointsText(task) {
  const billing = task?.billing;
  if (whole(billing?.chargedPoints) && billing.chargedPoints > 0) return `已使用 ${billing.chargedPoints} 积分`;
  if (billing?.status === 'released') return '未扣积分';
  if (['failed', 'cancelled', 'error', 'interrupted'].includes(task?.status || task?.state) && whole(billing?.chargedPoints) && billing.chargedPoints === 0) return '未扣积分';
  if (whole(billing?.reservedPoints) && billing.reservedPoints > 0 && !['settled', 'released'].includes(billing?.status)) return `已冻结 ${billing.reservedPoints} 积分`;
  return '';
}
