import { app, BrowserWindow } from "electron";
import { ClaudeCenterWorker } from "./runner.js";

let worker: ClaudeCenterWorker | null = null;

function createWindow(): void {
  const window = new BrowserWindow({
    width: 460,
    height: 280,
    title: "ClaudeCenter Worker",
    resizable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const html = `
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
            width: 360px;
            border: 1px solid #202421;
            border-radius: 6px;
            background: #fffdf6;
            box-shadow: 4px 4px 0 #202421;
            padding: 22px;
          }
          h1 {
            margin: 0 0 12px;
            font-size: 22px;
          }
          p {
            margin: 0;
            color: #66736f;
            line-height: 1.5;
          }
        </style>
      </head>
      <body>
        <main>
          <h1>ClaudeCenter Worker</h1>
          <p>Worker 正在后台上报心跳、领取任务和执行定向指令。关闭窗口会停止当前桌面端。</p>
        </main>
      </body>
    </html>
  `;

  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

app.whenReady().then(async () => {
  worker = new ClaudeCenterWorker();
  await worker.start();
  createWindow();
});

app.on("window-all-closed", () => {
  void worker?.stop();
  app.quit();
});
