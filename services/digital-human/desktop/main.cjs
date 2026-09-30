const { app, BrowserWindow, Menu, ipcMain, dialog, shell, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { serverOrigin, isSameOrigin } = require("./policy.cjs");

let mainWindow;
let setupWindow;
let connecting = false;
const setupUrl = pathToFileURL(path.join(__dirname, "setup.html")).href;
const configPath = () => path.join(app.getPath("userData"), "server.json");
function readServer() {
  try { return serverOrigin(JSON.parse(fs.readFileSync(configPath(), "utf8")).server, app.isPackaged); }
  catch { return "https://digital-human-studio-qycm.zeabur.app"; }
}

async function verifyServer(origin) {
  const response = await fetch(`${origin}/api/auth/info`, { redirect: "error", signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error("这个地址尚未启用独立账号服务，请联系管理员确认。");
  const info = await response.json();
  if (info.app !== "digital-human-studio" || info.authMode !== "standalone" || info.version !== 1) {
    throw new Error("这个地址不是兼容的数字人工作室服务。");
  }
}

function openSetup() {
  if (setupWindow && !setupWindow.isDestroyed()) { setupWindow.show(); setupWindow.focus(); return; }
  setupWindow = new BrowserWindow({ width: 560, height: 660, minWidth: 480, minHeight: 610,
    title: "连接工作室", backgroundColor: "#0b1018", autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  setupWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  setupWindow.webContents.on("will-navigate", event => event.preventDefault());
  setupWindow.on("closed", () => { setupWindow = undefined; });
  setupWindow.loadFile(path.join(__dirname, "setup.html"));
}

async function openStudio(origin) {
  const previous = mainWindow;
  const window = new BrowserWindow({ width: 1440, height: 960, minWidth: 1000, minHeight: 700,
    show: false, title: "数字人工作室", backgroundColor: "#0a0b0e", autoHideMenuBar: true,
    webPreferences: { partition: "persist:studio", contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    // Media previews stay in the authenticated window; external links use the system browser.
    if (isSameOrigin(url, origin)) window.loadURL(url).catch(() => openSetup());
    else if (url.startsWith("https://")) {
      dialog.showMessageBox(window, { type: "question", message: "在浏览器中打开外部链接？", detail: new URL(url).origin,
        buttons: ["取消", "打开"], defaultId: 0, cancelId: 0 }).then(({ response }) => { if (response === 1) shell.openExternal(url); });
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => { if (!isSameOrigin(url, origin)) event.preventDefault(); });
  window.webContents.on("will-redirect", (event, url) => { if (!isSameOrigin(url, origin)) event.preventDefault(); });
  window.webContents.on("will-attach-webview", event => event.preventDefault());
  window.webContents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) openSetup();
  });
  window.on("closed", () => { if (mainWindow === window) mainWindow = undefined; });
  try {
    await window.loadURL(`${origin}/login`);
    mainWindow = window;
    window.show();
    if (previous && !previous.isDestroyed()) previous.close();
    if (setupWindow && !setupWindow.isDestroyed()) setupWindow.close();
  } catch (error) { window.destroy(); throw error; }
}

function fromSetup(event) {
  return setupWindow && event.sender === setupWindow.webContents && event.senderFrame === event.sender.mainFrame && event.senderFrame.url === setupUrl;
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    const window = setupWindow || mainWindow;
    if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
  });
  app.whenReady().then(async () => {
    const studioSession = session.fromPartition("persist:studio");
    studioSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    studioSession.setPermissionCheckHandler(() => false);
    studioSession.on("will-download", (_event, item) => {
      // Electron presents a native Save dialog; do not choose or overwrite a user's path silently.
      item.setSaveDialogOptions({ title: "保存作品" });
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
      { label: "工作室", submenu: [{ label: "连接 / 切换服务", click: openSetup }, { label: "返回制作台", click: () => {
        if (mainWindow) mainWindow.loadURL(`${readServer()}/`).catch(() => openSetup());
      } }, { type: "separator" }, { role: "quit", label: "退出" }] },
      { role: "editMenu", label: "编辑" },
      { label: "视图", submenu: [{ role: "reload", label: "刷新" }, { role: "resetZoom", label: "实际大小" }, { role: "zoomIn", label: "放大" }, { role: "zoomOut", label: "缩小" }, { role: "togglefullscreen", label: "全屏" },
        ...(!app.isPackaged ? [{ role: "toggleDevTools" }] : [])] },
    ]));
    ipcMain.handle("studio:config", event => {
      if (!fromSetup(event)) throw new Error("Invalid sender");
      return { server: readServer(), version: app.getVersion(), development: !app.isPackaged };
    });
    ipcMain.handle("studio:connect", async (event, input) => {
      if (!fromSetup(event)) throw new Error("Invalid sender");
      if (connecting) return { error: "正在连接，请稍候" };
      connecting = true;
      try {
        if (typeof input !== "string" || input.length > 2048) throw new Error("服务地址无效");
        const origin = serverOrigin(input.trim(), app.isPackaged);
        await verifyServer(origin);
        fs.mkdirSync(app.getPath("userData"), { recursive: true });
        fs.writeFileSync(configPath(), JSON.stringify({ server: origin }), { mode: 0o600 });
        await openStudio(origin);
        return { success: true };
      } catch (error) {
        return { error: error.message.includes("fetch") || error.name === "TimeoutError" ? "无法连接服务，请检查地址和网络后重试。" : error.message };
      } finally { connecting = false; }
    });
    const origin = readServer();
    if (origin) {
      try { await verifyServer(origin); await openStudio(origin); }
      catch { openSetup(); }
    } else openSetup();
    app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) openSetup(); });
  });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
}
