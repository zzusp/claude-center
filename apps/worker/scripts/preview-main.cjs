// 仅供 UI 预览/截图验证：用 Electron 隐藏窗口加载重构后的 windowHtml()（注入样例 workerApi），
// 逐菜单 capturePage() 出 PNG，供肉眼核对布局 + 内部滚动。非生产路径。
// 跑法：cd apps/worker && npm run preview:ui  （= npm run build && electron scripts）
//   electron 把本目录当 app（同级 package.json 的 main 指向本文件）。
//   产物 + 调试日志落 $TEMP/worker-ui-preview/（*.png + run.log）。
//   Electron 是 GUI 子系统、stdout 不连终端，故所有诊断写 run.log 而非 console。
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow } = require("electron");

const outDir = path.join(os.tmpdir(), "worker-ui-preview");
fs.mkdirSync(outDir, { recursive: true });
const logFile = path.join(outDir, "run.log");
function log(msg) {
  fs.appendFileSync(logFile, new Date().toISOString() + " " + msg + "\n");
}
fs.writeFileSync(logFile, "");
log("script loaded");

app.disableHardwareAcceleration();

const PAGES = ["overview", "tasks", "conversations", "projects", "settings", "logs"];

async function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  log("app ready, run() start");
  const mod = await import(pathToFileURL(path.resolve(__dirname, "../dist/window-html.js")).href);
  log("imported window-html");
  const windowHtml = mod.windowHtml;

  const win = new BrowserWindow({
    width: 1320,
    height: 900,
    show: false,
    webPreferences: {
      preload: path.resolve(__dirname, "preview-preload.cjs"),
      contextIsolation: false,
      nodeIntegration: false,
      offscreen: true
    }
  });
  // 离屏渲染：强制一个帧率，确保有帧可截。
  win.webContents.setFrameRate(30);
  win.webContents.on("paint", () => {});
  log("window created");

  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(windowHtml()));
  log("loadURL done");
  await delay(2500);

  for (const page of PAGES) {
    try {
      await win.webContents.executeJavaScript('showPage("' + page + '");');
      if (page === "tasks") {
        await win.webContents.executeJavaScript('expandedTaskId="t1"; renderTasks(tasksCache); 1;');
      }
      if (page === "conversations") {
        await win.webContents.executeJavaScript('expandedConvId="c1"; renderConversations(convCache); 1;');
      }
      await delay(800);
      const img = await win.webContents.capturePage();
      const file = path.join(outDir, page + ".png");
      fs.writeFileSync(file, img.toPNG());
      log("captured " + page + " -> " + img.getSize().width + "x" + img.getSize().height);
    } catch (e) {
      log("ERROR on " + page + ": " + (e && e.stack ? e.stack : e));
    }
  }

  log("done, destroying window");
  win.destroy();
  app.quit();
}

app.whenReady().then(() =>
  run().catch((err) => {
    log("FATAL " + (err && err.stack ? err.stack : err));
    app.exit(1);
  })
);
