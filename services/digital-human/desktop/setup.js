const form = document.querySelector("#connect-form");
const input = document.querySelector("#server");
const button = document.querySelector("#connect");
const error = document.querySelector("#error");
window.studio.config().then(config => {
  input.value = config.server;
  document.querySelector("#version").textContent = `v${config.version}`;
  if (config.development) document.querySelector(".hint").textContent += " 开发模式支持本机 HTTP。";
}).catch(() => { error.textContent = "无法读取设置，请重新打开客户端。"; error.hidden = false; });
form.addEventListener("submit", async event => {
  event.preventDefault();
  error.hidden = true; button.disabled = true; button.textContent = "正在连接…";
  try {
    const result = await window.studio.connect(input.value);
    if (result.error) { error.textContent = result.error; error.hidden = false; }
  } catch { error.textContent = "连接失败，请稍后重试。"; error.hidden = false; }
  finally { button.disabled = false; button.textContent = "连接工作室 ↗"; }
});
