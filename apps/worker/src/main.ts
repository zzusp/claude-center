import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, screen, shell } from "electron";
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
  // 默认尺寸按「可用工作区」(已扣菜单栏/Dock)的 90% 取、再用设计上限 1320×900 封顶：小屏(13"/12"，
  // 工作区约 1280×705)留四周留白、不再贴边铺满；大屏(16"/外接屏)仍开到设计的 1320×900。center 让钳小后居中。
  // minHeight 由 720 降到 640：720>705 时窗口会被 minHeight 顶到 720、底部 15px 压在 Dock 后且用户无法缩小修复。
  const { width: workW, height: workH } = screen.getPrimaryDisplay().workAreaSize;
  const window = new BrowserWindow({
    width: Math.min(1320, Math.round(workW * 0.9)),
    height: Math.min(900, Math.round(workH * 0.9)),
    minWidth: 1080,
    minHeight: 640,
    center: true,
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

// 未捕获的 Promise 拒绝（如某轮 DB 查询失败、relay 抖动）不应静默拖垮主进程：记一行日志即可，
// 窗口与轮询照常。曾因 worker.start() 在窗口创建前抛错而出现「只有 Dock 图标、无窗口」的死状。
process.on("unhandledRejection", (reason) => {
  console.error("[worker] unhandledRejection:", reason instanceof Error ? reason.stack ?? reason.message : reason);
});

app.whenReady().then(() => {
  worker = new ClaudeCenterWorker();

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

  // 先建窗口，再启动 worker —— 窗口渲染不依赖 DB/网络。
  // 此前是 `await worker.start()` 在 createWindow 之前：DB 缺失/不可达时 start() 抛错，窗口永不创建，
  // 用户只看到 Dock 图标、无任何窗口或报错（与安装手册 §11「窗口显示 DB 健康度红点」矛盾）。
  // 现在窗口立即起，worker.start() 不阻塞窗口；失败落进 worker 日志面板（getStatusSnapshot 已对 DB 失败容错）。
  createWindow();
  worker.start().catch((error) => {
    console.error("[worker] start failed:", error instanceof Error ? error.stack ?? error.message : error);
  });
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
