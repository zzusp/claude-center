import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { ClaudeCenterWorker } from "./runner.js";
import { fixMacGuiPath } from "./mac-path.js";
import { windowHtml } from "./window-html.js";

// macOS 从 Finder/Dock 启动时 PATH 是 launchd 最小集，git/gh/claude/node 解析不到 → 必须在任何 spawn
// （含 worker 启动时的能力自检）之前补回登录 shell 的 PATH。非 darwin 为 no-op。
fixMacGuiPath();

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

// macOS 惯例：关闭窗口不退出应用——Worker 是后台执行节点，关窗后应继续跑心跳/领任务，点 Dock 图标重开窗口。
// 其余平台保持原行为：关窗即退出 Worker。两条路径最终都经 before-quit 收口 worker（清定时器 / 断中转）。
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// macOS：Dock 图标被点且当前无窗口时重建主窗口。
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// 真正退出前收口 worker（Windows/Linux 由 window-all-closed→app.quit() 触发；macOS 由 Cmd+Q / 菜单退出触发）。
app.on("before-quit", () => {
  void worker?.stop();
});
