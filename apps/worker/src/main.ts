import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { ClaudeCenterWorker } from "./runner.js";
import { windowHtml } from "./window-html.js";

let worker: ClaudeCenterWorker | null = null;

function createWindow(): void {
  // preload 与资产同样按 ../ 解析到 apps/worker 下，dist(electron) 与 src(tsx) 两种运行方式路径一致。
  const appDir = path.dirname(fileURLToPath(import.meta.url));
  const window = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: "#f8f8f6",
    title: "ClaudeCenter Worker",
    webPreferences: {
      preload: path.resolve(appDir, "../preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(windowHtml())}`);
}

app.whenReady().then(async () => {
  worker = new ClaudeCenterWorker();
  await worker.start();

  // 桌面端控制面 → worker。
  ipcMain.handle("worker:getState", () => worker?.getStatusSnapshot() ?? null);
  ipcMain.handle("worker:setWorking", (_event, working: boolean) =>
    worker?.setWorkingState(working ? "working" : "idle")
  );
  ipcMain.handle("worker:setAllowRemote", (_event, allow: boolean) => worker?.setAllowRemoteControl(allow));
  ipcMain.handle("worker:setMaxParallel", (_event, value: number) => worker?.setMaxParallel(value));
  ipcMain.handle("worker:clearLogs", () => worker?.clearLogs());
  ipcMain.handle("worker:listTerminals", () => worker?.listTerminals() ?? []);
  ipcMain.handle("worker:setTerminal", (_event, command: string) => worker?.setTerminalCommand(command));
  ipcMain.handle("worker:setPreCommand", (_event, command: string) => worker?.setPreCommand(command));
  ipcMain.handle("worker:setRelayConfig", (_event, input: { url: string; publishToken: string; workerToken: string }) =>
    worker?.setRelayConfig(input)
  );
  ipcMain.handle("worker:listCloudProjects", () => worker?.listCloudProjects() ?? []);
  ipcMain.handle("worker:listProjectLinks", () => worker?.listProjectLinks() ?? []);
  ipcMain.handle("worker:addProjectLink", (_event, input: { projectName: string; localPath: string }) =>
    worker?.addProjectLink(input)
  );
  ipcMain.handle("worker:removeProjectLink", (_event, input: { projectName: string; localPath: string }) =>
    worker?.removeProjectLink(input)
  );
  ipcMain.handle("worker:cancelTask", (_event, taskId: string) => worker?.cancelTask(taskId) ?? false);

  // 桌面端任务面板（仅本 worker）：总览 / peek 详情 / 本机回复 / 续接重试。
  // 人工验收(accept) / 打回(reject) 已随状态机简化移除——success 由 Console 检测 PR 合并自动翻 merged。
  ipcMain.handle("worker:listMyTasks", (_event, opts: { page: number; pageSize: number; statusGroup?: string | null }) =>
    worker?.listMyTasks(opts) ?? { rows: [], total: 0, waitingCount: 0 }
  );
  ipcMain.handle("worker:getTaskDetail", (_event, taskId: string) =>
    worker?.getTaskDetail(taskId) ?? { comments: [], events: [] }
  );
  ipcMain.handle("worker:replyToTask", (_event, taskId: string, body: string) => worker?.replyToTask(taskId, body));
  ipcMain.handle("worker:retryMyTask", (_event, taskId: string) => worker?.retryMyTask(taskId) ?? false);

  // 桌面端对话面板（只读）：本 worker 承接的远程实时对话总览 + 消息线（含流式实时增量）。
  ipcMain.handle("worker:listMyConversations", () => worker?.listMyConversations() ?? []);
  ipcMain.handle("worker:getConversationDetail", (_event, conversationId: string, knownJsonlVersion: string | null) =>
    worker?.getConversationDetail(conversationId, knownJsonlVersion) ?? { messages: [], jsonl: "", jsonlVersion: "" }
  );

  // 在文件管理器中定位并选中文件（能力自检路径点击用）。
  ipcMain.handle("worker:openPath", (_event, filePath: string) => {
    shell.showItemInFolder(filePath);
  });

  // 选择本地项目文件夹（关联项目用）。返回所选目录路径，取消返回 null。
  ipcMain.handle("worker:pickFolder", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
  });

  createWindow();
});

app.on("window-all-closed", () => {
  void worker?.stop();
  app.quit();
});
