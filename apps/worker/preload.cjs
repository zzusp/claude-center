// Electron 预加载：在隔离上下文里把受控的 worker 控制面暴露给渲染层（窗口里的两个开关）。
// 用 CJS（.cjs）确保无论主包是否 ESM 都按 CommonJS 加载。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("workerApi", {
  getState: () => ipcRenderer.invoke("worker:getState"),
  setWorking: (working) => ipcRenderer.invoke("worker:setWorking", working),
  setAllowRemote: (allow) => ipcRenderer.invoke("worker:setAllowRemote", allow)
});
