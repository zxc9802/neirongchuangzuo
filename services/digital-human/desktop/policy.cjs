function serverOrigin(input, packaged = true) {
  const url = new URL(input);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && !packaged && url.protocol === "http:")) ||
    url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("请输入完整的 HTTPS 服务地址，例如 https://studio.example.com");
  }
  return url.origin;
}

function isSameOrigin(url, origin) {
  try { return new URL(url).origin === origin; } catch { return false; }
}

module.exports = { serverOrigin, isSameOrigin };
