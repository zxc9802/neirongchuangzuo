import { refreshWorkspaceCredits, subscribeWorkspaceCredits } from './workspace-credits.js';
function login() { location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search + location.hash)); }
export function paintCredits(current) {
  const button = document.querySelector('#workspace-credits');
  if (!button) return;
  button.hidden = false;
  const unlimited = current.snapshot?.unlimited === true;
  button.querySelector('strong').textContent = unlimited ? '∞' : current.snapshot ? String(current.snapshot.available) : '—';
  button.querySelector('small').textContent = current.stale ? '积分待刷新' : unlimited ? '无限积分' : '可用积分';
  button.title = current.stale ? current.error || '正在读取积分' : unlimited ? '无限积分' : `可用 ${current.snapshot.available} 积分，冻结 ${current.snapshot.held} 积分`;
  const summary = document.querySelector('#account-credit-summary');
  summary.textContent = unlimited ? `无限积分${current.stale ? '（待刷新）' : ''}` : current.snapshot ? `可用 ${current.snapshot.available} 积分 · 冻结 ${current.snapshot.held} 积分${current.stale ? '（上次余额，待刷新）' : ''}` : current.error || '正在读取积分…';
  const pricing = current.snapshot?.pricing;
  document.querySelector('#account-credit-rules').textContent = unlimited ? '' : pricing ? `图片 ${pricing.imagePerUnit} 积分/张；视频 ${pricing.videoPoints} 积分/${pricing.videoSeconds} 秒，按实际时长。` : '积分规则暂时无法读取。';
  document.querySelector('#account-credit-error').textContent = current.error;
}
try {
  const response = await fetch('/api/workspace/session');
  if (response.status === 401) login();
  else {
    if (!response.ok) throw new Error('账号服务暂时不可用，请刷新重试。');
    const { user, localCredits = false } = await response.json();
    globalThis.workspaceUser = user;
    globalThis.workspaceCreditOwner = localCredits ? 'local-dev' : null;
    if (user || localCredits) {
      const name = user?.nickname || user?.account || '本地预览';
      const account = document.querySelector('#workspace-account');
      account.hidden = false;
      account.querySelector('span').textContent = name;
      account.title = user?.account || name;
      const showAccount = () => {
        document.querySelector('#account-name').textContent = name;
        document.querySelector('#account-email').textContent = user?.account || '';
        document.querySelector('#account-source').textContent = !user ? '本地预览' : user.authSource === 'internal' ? '内部账号 · 密码请在原系统修改' : '本站注册账号';
        document.querySelector('#account-dialog').showModal();
        void refreshWorkspaceCredits();
      };
      account.addEventListener('click', showAccount);
      document.querySelector('#workspace-credits').addEventListener('click', showAccount);
      document.querySelector('#account-credit-refresh').onclick = () => { void refreshWorkspaceCredits(); };
      subscribeWorkspaceCredits(paintCredits);
      void refreshWorkspaceCredits();
      document.querySelector('#account-close').onclick = () => document.querySelector('#account-dialog').close();
      const logout = document.querySelector('#account-logout');
      logout.hidden = !user;
      logout.style.display = user ? '' : 'none';
      logout.onclick = async event => {
        const button = event.currentTarget;
        button.disabled = true;
        const message = document.querySelector('#account-error');
        try {
          const result = await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          if (!result.ok) throw new Error();
          location.replace('/login');
        } catch { message.textContent = '退出失败，请重试。'; button.disabled = false; }
      };
      window.addEventListener('focus', async () => {
        try {
          const current = await fetch('/api/workspace/session');
          if (current.status === 401) { login(); return; }
          if (current.ok) {
            const session = await current.json();
            if (session.user?.id !== user?.id || Boolean(session.localCredits) !== localCredits) location.reload();
            else void refreshWorkspaceCredits();
          }
        } catch { /* A later authenticated request still checks the server-side session. */ }
      });
    }
    await import('./app.js');
  }
} catch {
  const main = document.querySelector('#main');
  main.textContent = '工作台暂时无法加载，请刷新页面重试。';
  main.style.cssText = 'padding:80px 110px;font-size:16px';
}
