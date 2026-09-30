function login() { location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search + location.hash)); }
try {
  const response = await fetch('/api/workspace/session');
  if (response.status === 401) login();
  else {
    if (!response.ok) throw new Error('账号服务暂时不可用，请刷新重试。');
    const { user } = await response.json();
    globalThis.workspaceUser = user;
    if (user) {
      const account = document.querySelector('#workspace-account');
      account.hidden = false;
      account.querySelector('span').textContent = user.nickname || user.account;
      account.title = user.account;
      account.addEventListener('click', () => {
        document.querySelector('#account-name').textContent = user.nickname || user.account;
        document.querySelector('#account-email').textContent = user.account;
        document.querySelector('#account-source').textContent = user.authSource === 'internal' ? '内部账号 · 密码请在原系统修改' : '本站注册账号';
        document.querySelector('#account-dialog').showModal();
      });
      document.querySelector('#account-close').onclick = () => document.querySelector('#account-dialog').close();
      document.querySelector('#account-logout').onclick = async event => {
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
          if (current.ok && (await current.json()).user?.id !== user.id) location.reload();
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
