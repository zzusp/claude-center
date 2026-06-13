import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";
import { ClaudeCenterWorker } from "./runner.js";

let worker: ClaudeCenterWorker | null = null;

// 窗口 HTML：状态展示 + 两个开关（工作态 / 是否允许 web 远程控制），经 preload 暴露的 workerApi 驱动。
function windowHtml(): string {
  return `
    <!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <style>
          body {
            margin: 0;
            min-height: 100vh;
            display: grid;
            place-items: center;
            background: #f3f1ea;
            color: #151716;
            font-family: Segoe UI, sans-serif;
          }
          main {
            width: 380px;
            border: 1px solid #202421;
            border-radius: 6px;
            background: #fffdf6;
            box-shadow: 4px 4px 0 #202421;
            padding: 20px 22px;
          }
          h1 { margin: 0 0 6px; font-size: 20px; }
          .meta { margin: 0 0 16px; color: #66736f; font-size: 12px; }
          .state { font-weight: 600; }
          .state.on { color: #1f7a4d; }
          .state.off { color: #9a6a00; }
          .row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 0;
            border-top: 1px solid #e7e3d6;
          }
          .row .label { font-size: 13px; }
          .row .hint { display: block; color: #97a09c; font-size: 11px; margin-top: 2px; }
          .switch { position: relative; width: 42px; height: 24px; }
          .switch input { opacity: 0; width: 0; height: 0; }
          .slider {
            position: absolute; inset: 0; cursor: pointer;
            background: #cfcabb; border-radius: 24px; transition: .15s;
          }
          .slider::before {
            content: ""; position: absolute; height: 18px; width: 18px; left: 3px; top: 3px;
            background: #fffdf6; border-radius: 50%; transition: .15s;
          }
          input:checked + .slider { background: #1f7a4d; }
          input:checked + .slider::before { transform: translateX(18px); }
        </style>
      </head>
      <body>
        <main>
          <h1>ClaudeCenter Worker</h1>
          <p class="meta" id="meta">连接中…</p>
          <p style="margin:0 0 12px;font-size:13px;">当前状态：<span class="state off" id="state">—</span></p>

          <div class="row">
            <span class="label">工作状态<span class="hint">开 = 接任务；关 = 在线但不接任务</span></span>
            <label class="switch"><input type="checkbox" id="workingToggle" /><span class="slider"></span></label>
          </div>
          <div class="row">
            <span class="label">允许 web 端远程开关<span class="hint">关闭后中控无法远程切换工作态</span></span>
            <label class="switch"><input type="checkbox" id="remoteToggle" /><span class="slider"></span></label>
          </div>
        </main>
        <script>
          const $ = (id) => document.getElementById(id);
          async function refresh() {
            const s = await window.workerApi.getState();
            const working = s.workingState === "working";
            $("meta").textContent =
              "claude " + (s.claudeVersion || "—") + " · " + s.subscriptionType + " · 在途 " + s.activeCount + "/" + s.maxParallel;
            const state = $("state");
            state.textContent = working ? "工作中（接任务）" : "空闲（不接任务）";
            state.className = "state " + (working ? "on" : "off");
            $("workingToggle").checked = working;
            $("remoteToggle").checked = !!s.allowRemoteControl;
          }
          $("workingToggle").addEventListener("change", async (e) => {
            await window.workerApi.setWorking(e.target.checked);
            refresh();
          });
          $("remoteToggle").addEventListener("change", async (e) => {
            await window.workerApi.setAllowRemote(e.target.checked);
            refresh();
          });
          refresh();
          setInterval(refresh, 3000);
        </script>
      </body>
    </html>
  `;
}

function createWindow(): void {
  // preload 与资产同样按 ../ 解析到 apps/worker 下，dist(electron) 与 src(tsx) 两种运行方式路径一致。
  const appDir = path.dirname(fileURLToPath(import.meta.url));
  const window = new BrowserWindow({
    width: 460,
    height: 420,
    title: "ClaudeCenter Worker",
    resizable: false,
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

  // 桌面端开关 → worker 控制面。
  ipcMain.handle("worker:getState", () => worker?.getStatusSnapshot() ?? null);
  ipcMain.handle("worker:setWorking", (_event, working: boolean) =>
    worker?.setWorkingState(working ? "working" : "idle")
  );
  ipcMain.handle("worker:setAllowRemote", (_event, allow: boolean) => worker?.setAllowRemoteControl(allow));

  createWindow();
});

app.on("window-all-closed", () => {
  void worker?.stop();
  app.quit();
});
