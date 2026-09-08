const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "blade",
  Object.freeze({
    request: (options) => ipcRenderer.invoke("blade:request", options),
    download: (path) => ipcRenderer.invoke("blade:download", path),
    saveData: (options) => ipcRenderer.invoke("blade:save-data", options),
    settings: (url) => ipcRenderer.invoke("blade:settings", url),
    offline: (options) => ipcRenderer.invoke("blade:offline", options),
    sync: (options) => ipcRenderer.invoke("blade:sync", options),
    windowControl: (action) => ipcRenderer.send("blade:window", action),
    version: "1.0.0",
  }),
);
