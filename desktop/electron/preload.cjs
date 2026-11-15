const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('xscriptElectron', {
  send: json => ipcRenderer.send('xscript:rpc', json),
  onMessage: callback => {
    const listener = (_event, json) => callback(json);
    ipcRenderer.on('xscript:message', listener);
    return () => ipcRenderer.removeListener('xscript:message', listener);
  },
});
