const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("desktop", {
    snapshot: () => ipcRenderer.invoke("snapshot"),
    setTun: (enabled) => ipcRenderer.invoke("set-tun", enabled),
    setRoutingMode: (mode) => ipcRenderer.invoke("set-routing-mode", mode),
    measure: (id, full = false) => ipcRenderer.invoke("measure", id, full),
    cancelMeasure: () => ipcRenderer.invoke("cancel-measure"),
    importConfig: () => ipcRenderer.invoke("import-config"),
    importText: (text) => ipcRenderer.invoke("import-text", text),
    setSystemProxy: (enabled) =>
        ipcRenderer.invoke("set-system-proxy", enabled),
    chooseBinary: (kind) => ipcRenderer.invoke("choose-binary", kind),
    select: (id) => ipcRenderer.invoke("select", id),
    remove: (id) => ipcRenderer.invoke("remove", id),
    start: (id) => ipcRenderer.invoke("start", id),
    stop: () => ipcRenderer.invoke("stop"),
    onUpdate: (callback) => {
        const listener = (_event, data) => callback(data);
        ipcRenderer.on("update", listener);
        return () => ipcRenderer.removeListener("update", listener);
    },
});
