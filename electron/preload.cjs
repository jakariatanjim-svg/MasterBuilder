const { contextBridge, ipcRenderer } = require("electron");

const api = {
  selectFolder: () => ipcRenderer.invoke("dialog:select-folder"),
  analyzeProject: (folderPath) => ipcRenderer.invoke("project:analyze", folderPath),
  cleanupProject: (payload) => ipcRenderer.invoke("project:cleanup", payload),
  installDependencies: (payload) => ipcRenderer.invoke("project:install", payload),
  buildProject: (payload) => ipcRenderer.invoke("project:build", payload),
  openPath: (targetPath) => ipcRenderer.invoke("shell:open-path", targetPath),
  cancelTask: (taskId) => ipcRenderer.invoke("task:cancel", taskId),
  getRuntimeInfo: () => ipcRenderer.invoke("app:runtime-info"),
  onTaskLog: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on("task:log", listener);
    return () => ipcRenderer.removeListener("task:log", listener);
  },
  onTaskStatus: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on("task:status", listener);
    return () => ipcRenderer.removeListener("task:status", listener);
  },
};

contextBridge.exposeInMainWorld("masterBuilder", api);