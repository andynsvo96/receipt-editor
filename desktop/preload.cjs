const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('receiptDesktop', {
  platform: process.platform,
  openFile: () => ipcRenderer.invoke('receipt:open'),
  saveFile: (request) => ipcRenderer.invoke('receipt:save', request),
  onOpenFile: (listener) => {
    const handler = (_event, file) => listener(file);
    ipcRenderer.on('receipt:file-opened', handler);
    return () => ipcRenderer.removeListener('receipt:file-opened', handler);
  },
});
