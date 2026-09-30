const register = location.pathname === '/register';
const form = document.querySelector('#auth-form');
const error = document.querySelector('#auth-error');
const submit = document.querySelector('#auth-submit');
const destination = () => {
  const next = new URLSearchParams(location.search).get('next');
  return next && /^\/(?!\/)/.test(next) && !/[\\\u0000-\u0020]/.test(next) && !/^\/(login|register)(?:[/?#]|$)/.test(next) ? next : '/';
};
if (register) {
  document.title = '注册 · 店 AI';
  document.querySelector('#auth-title').textContent = '创建你的创作账号';
  document.querySelector('#auth-description').textContent = '注册后，开始整理素材和制作宣传内容。';
  form.elements.password.minLength = 10;
  form.elements.password.autocomplete = 'new-password';
  form.elements.password.placeholder = '设置密码，至少 10 个字符';
  submit.textContent = '注册并进入工作台 →';
  document.querySelector('#switch-description').textContent = '已经有账号？';
  document.querySelector('#switch-link').textContent = '前往登录';
  document.querySelector('#switch-link').href = '/login';
  document.querySelector('#auth-note').textContent = '已有内部账号可直接登录，无需再次注册。请妥善保存密码，当前暂不提供密码找回。';
}
document.querySelector('#switch-link').href += location.search;
document.querySelector('#toggle-password').addEventListener('click', event => {
  const visible = form.elements.password.type === 'password';
  form.elements.password.type = visible ? 'text' : 'password';
  event.currentTarget.textContent = visible ? '隐藏' : '显示';
  event.currentTarget.setAttribute('aria-label', visible ? '隐藏密码' : '显示密码');
  event.currentTarget.setAttribute('aria-pressed', String(visible));
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (submit.disabled) return;
  error.hidden = true;
  const body = { account: form.elements.account.value, password: form.elements.password.value };
  const label = submit.textContent;
  submit.disabled = true; submit.textContent = register ? '正在创建账号…' : '正在登录…';
  try {
    const response = await fetch(`/api/auth/${register ? 'register' : 'login'}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '账号服务暂时不可用，请稍后重试');
    location.replace(destination());
  } catch (failure) {
    error.textContent = failure.message || '连接失败，请稍后重试'; error.hidden = false;
    submit.disabled = false; submit.textContent = label;
  }
});
fetch('/api/workspace/session').then(async response => {
  if (response.ok && (await response.json()).user) location.replace(destination());
}).catch(() => {});
