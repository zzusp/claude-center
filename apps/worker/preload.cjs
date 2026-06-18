// Electron 预加载：在隔离上下文里把受控的 worker 控制面暴露给渲染层。
// 用 CJS（.cjs）确保无论主包是否 ESM 都按 CommonJS 加载。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("workerApi", {
  getState: () => ipcRenderer.invoke("worker:getState"),
  setWorking: (working) => ipcRenderer.invoke("worker:setWorking", working),
  setAllowRemote: (allow) => ipcRenderer.invoke("worker:setAllowRemote", allow),
  setMaxParallel: (value) => ipcRenderer.invoke("worker:setMaxParallel", value),
  clearLogs: () => ipcRenderer.invoke("worker:clearLogs"),
  listTerminals: () => ipcRenderer.invoke("worker:listTerminals"),
  setTerminal: (command) => ipcRenderer.invoke("worker:setTerminal", command),
  setPreCommand: (command) => ipcRenderer.invoke("worker:setPreCommand", command),
  listCloudProjects: () => ipcRenderer.invoke("worker:listCloudProjects"),
  listProjectLinks: () => ipcRenderer.invoke("worker:listProjectLinks"),
  pickFolder: () => ipcRenderer.invoke("worker:pickFolder"),
  addProjectLink: (input) => ipcRenderer.invoke("worker:addProjectLink", input),
  removeProjectLink: (input) => ipcRenderer.invoke("worker:removeProjectLink", input),
  cancelTask: (taskId) => ipcRenderer.invoke("worker:cancelTask", taskId),
  listMyTasks: (opts) => ipcRenderer.invoke("worker:listMyTasks", opts),
  getTaskDetail: (taskId) => ipcRenderer.invoke("worker:getTaskDetail", taskId),
  replyToTask: (taskId, body) => ipcRenderer.invoke("worker:replyToTask", taskId, body),
  retryMyTask: (taskId) => ipcRenderer.invoke("worker:retryMyTask", taskId),
  listMyConversations: () => ipcRenderer.invoke("worker:listMyConversations"),
  getConversationDetail: (conversationId) => ipcRenderer.invoke("worker:getConversationDetail", conversationId),
  openPath: (filePath) => ipcRenderer.invoke("worker:openPath", filePath)
});
