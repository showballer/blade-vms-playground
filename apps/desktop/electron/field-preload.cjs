const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('blade', Object.freeze({
  field: options => ipcRenderer.invoke('blade:field', options),
  windowControl: action => ipcRenderer.send('blade:field-window', action),
  version: '1.2.0',
}));
