const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("eqBridge", {
    setGains: (gains) => ipcRenderer.send("eq:set-gains", gains),
    getGains: () => ipcRenderer.invoke("eq:get-gains"),
});
