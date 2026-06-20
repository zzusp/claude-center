// 手机端顶部 header / 通知下拉的纯 CSS 布局验证截图。
// 用法：node shot.mjs <globals.css 路径> <输出文件名.png>
//
// 思路：内联真实 globals.css + 复刻 shell.tsx / notifications.tsx 的 header + 通知面板 DOM，
//       用 headless Chrome 在 390×844(iPhone 级)视口下截图。下拉面板强制常开（等价真机 tap 打开）。
//       不依赖 DB / 登录 / dev server——只验证改动的本体：手机端 CSS 布局是否溢出 / 标题是否贴左。
//
// 关键坑：Windows 上 `--headless --window-size=390,844` 会被 OS 最小窗口宽钳到 ~478px，
//        innerWidth 并非 390，截图会按错误视口裁切（曾误判面板「右侧溢出」）。
//        故走 CDP `Emulation.setDeviceMetricsOverride` 强制 390 视口，再 captureScreenshot，
//        与真机一致。Node 22 自带全局 WebSocket，直接驱动 CDP，无需第三方依赖。
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const featureDir = path.dirname(__dirname);
const outDir = path.join(featureDir, "round-1");
mkdirSync(outDir, { recursive: true });

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const cssPath = process.argv[2];
const outName = process.argv[3];
const PORT = process.argv[4] ? Number(process.argv[4]) : 9333;
if (!cssPath || !outName) throw new Error("用法: node shot.mjs <css路径> <输出.png> [port]");
const css = readFileSync(cssPath, "utf8");

function row(tone, title, body, meta, unread) {
  return `<a class="notif-row${unread ? " unread" : ""}" data-tone="${tone}">
      <span class="notif-ico"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/></svg></span>
      <div class="notif-body">
        <div class="notif-row-title">${title}</div>
        <div class="notif-row-body">${body}</div>
        <div class="notif-row-meta">${meta}</div>
      </div>
      ${unread ? '<span class="notif-row-dot"></span>' : ""}
    </a>`;
}

const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style>
<style>
  /* 仅截图用：强制下拉面板常开，等价真机 tap/hover 打开后的状态 */
  .notif-panel{opacity:1!important;visibility:visible!important;transform:none!important;pointer-events:auto!important}
</style></head>
<body>
<div class="app">
  <main class="main">
    <header class="app-header">
      <button class="nav-toggle" aria-label="menu"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 6h18M3 12h18M3 18h18"/></svg></button>
      <div class="app-header-titles">
        <h1 class="app-header-title">任务调度</h1>
        <span class="app-header-sub">管理 AI 编码任务的发布、认领与执行进度</span>
      </div>
      <div class="app-header-actions">
        <div class="notif">
          <button class="notif-trigger" aria-label="通知">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
            <span class="notif-dot">3</span>
          </button>
          <div class="notif-panel" role="dialog" aria-label="消息通知">
            <header class="notif-head">
              <span class="notif-title">消息通知</span>
              <button class="notif-mark-all">全部已读</button>
            </header>
            <div class="notif-list">
              ${row("running", "任务被领取", "Worker DESKTOP-9F3A 领取了任务「手机端 UI 顶部 header 优化」", "任务被领取 · 2 分钟前", true)}
              ${row("merged", "PR 已建", "已为任务「手机端页面适配」创建 Pull Request #126，等待审核合并到 main 分支", "PR 已建 · 12 分钟前", true)}
              ${row("success", "任务完成", "任务「修复总览卡片统计」已执行完成并通过本地验证", "任务完成 · 1 小时前", false)}
              ${row("failed", "任务失败", "任务「迁移单元重命名」在执行阶段失败：DATABASE_URL 指向的共享库缺列", "任务失败 · 3 小时前", false)}
            </div>
            <button class="notif-more">查看更多</button>
          </div>
        </div>
        <div class="user-chip">
          <span class="user-avatar"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg></span>
          <div class="user-meta"><span class="user-name">管理员</span><span class="user-role">超级管理员</span></div>
        </div>
      </div>
    </header>
    <div class="view"></div>
  </main>
</div>
</body></html>`;

const htmlPath = path.join(outDir, outName.replace(/\.png$/, ".html"));
writeFileSync(htmlPath, html, "utf8");
const fileUrl = "file:///" + htmlPath.split(path.sep).join("/");

const profileDir = path.join(os.tmpdir(), `cc-shot-profile-${PORT}`);
rmSync(profileDir, { recursive: true, force: true });
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    "about:blank"
  ],
  { windowsHide: true }
);

async function getPageTarget() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* devtools 还没起，继续轮询 */
    }
    await sleep(100);
  }
  throw new Error("CDP devtools endpoint 未就绪");
}

const target = await getPageTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
const eventWaiters = [];
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  } else if (msg.method) {
    for (let i = eventWaiters.length - 1; i >= 0; i--) {
      if (eventWaiters[i].method === msg.method) {
        eventWaiters[i].resolve(msg.params);
        eventWaiters.splice(i, 1);
      }
    }
  }
});
function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
function waitEvent(method) {
  return new Promise((resolve) => eventWaiters.push({ method, resolve }));
}

await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve);
  ws.addEventListener("error", reject);
});

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true
});
const loaded = waitEvent("Page.loadEventFired");
await send("Page.navigate", { url: fileUrl });
await loaded;
await sleep(250);

// 地面真值：打印实际视口宽 + 面板 rect，证明视口确为 390、面板未越界。
const probe = await send("Runtime.evaluate", {
  returnByValue: true,
  expression: `(() => {
    const p = document.querySelector('.notif-panel').getBoundingClientRect();
    return { innerWidth: innerWidth, panelLeft: p.left, panelRight: p.right, panelWidth: Math.round(p.width) };
  })()`
});
console.log(outName, JSON.stringify(probe.result.value));

const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
writeFileSync(path.join(outDir, outName), Buffer.from(shot.data, "base64"));
console.log("wrote", path.join(outDir, outName));

ws.close();
chrome.kill();
await sleep(400);
// 临时 profile 清理 best-effort：Chrome 刚 kill 时文件可能仍被锁（EBUSY），清不掉不影响截图结果。
try {
  rmSync(profileDir, { recursive: true, force: true });
} catch {
  /* 下次运行启动前的 rmSync 会再清，或由系统 temp 回收 */
}
process.exit(0);
