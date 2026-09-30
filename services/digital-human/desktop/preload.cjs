const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("studio", {
  config: () => ipcRenderer.invoke("studio:config"),
  connect: address => ipcRenderer.invoke("studio:connect", address),
});
