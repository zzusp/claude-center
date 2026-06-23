// 「实时对话 — 新建对话弹窗」加宽 + 双列表单 纯 CSS 布局验证截图。
// 用法：node shot.mjs [桌面端口]
//
// 思路（沿用 mobile-screen-adapt/scripts/shot.mjs 的成熟做法）：内联真实 globals.css
//   （随本仓改动同步）+ 复刻 chat-thread.tsx 里 NewConversationPanel 的真实 DOM（含本次新增的
//   chat-modal-wide / chat-field-half 类），用 headless Chrome 在「桌面 + 多组手机视口」下截图。
//   不依赖 DB / 登录 / dev server——只验证改动本体：弹窗宽度 + 双列排版 + 窄屏回落单列 + 无横向溢出。
//
// 关键坑（见 memory windows-headless-chrome-mobile-screenshot）：Windows 上
//   `--headless --window-size=390,844` 会被 OS 最小窗口宽钳到 ~478px，innerWidth 并非 390。
//   故走 CDP `Emulation.setDeviceMetricsOverride` 强制真实视口，再 captureScreenshot。
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const featureDir = path.dirname(__dirname);
const repoRoot = path.resolve(featureDir, "..", "..", "..");
const cssPath = path.join(repoRoot, "apps", "console", "app", "globals.css");

const PORT = process.argv[2] ? Number(process.argv[2]) : 9351;
const outDir = path.join(featureDir, "after");
mkdirSync(outDir, { recursive: true });

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const css = readFileSync(cssPath, "utf8");

// ---- 小图标占位（线性 svg，尺寸贴近 lucide）----
const ic = (s = 16) =>
  `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/></svg>`;
const caret = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="cc-select-caret" aria-hidden><path d="m6 9 6 6 6-6"/></svg>`;

// 原生 select 复刻：与 chat-field input/select 同样式。
function nativeSelect(options) {
  return `<select>${options.map((o) => `<option>${o}</option>`).join("")}</select>`;
}

// 自定义 Select（cc-select，闭合态）复刻——autoReply 字段用。
function ccSelect(label) {
  return `<div class="cc-select"><button type="button" class="cc-select-trigger" aria-haspopup="listbox" aria-expanded="false"><span class="cc-select-label">${label}</span>${caret}</button></div>`;
}

// 自定义 DateTimePicker（dt-picker，闭合 + disabled）复刻——定时发送字段用。
function dtPicker(placeholder, disabled) {
  return `<div class="dt-picker${disabled ? " disabled" : ""}"><button type="button" class="dt-trigger" aria-haspopup="dialog" aria-expanded="false"${disabled ? " disabled" : ""}>${ic(15)}<span class="dt-trigger-label placeholder">${placeholder}</span></button></div>`;
}

// ============ 新建对话弹窗 DOM 复刻（与 NewConversationPanel JSX 一一对应）============
function modalHtml() {
  const fields = [
    `<label class="chat-field"><span>标题（可选）</span><input value="" placeholder="不填则留空"></label>`,
    `<label class="chat-field chat-field-half"><span>项目</span>${nativeSelect(["claude-center", "demo-app", "internal-tools"])}</label>`,
    `<label class="chat-field chat-field-half"><span>分支</span><input value="main" placeholder="输入或选择分支"></label>`,
    `<label class="chat-field chat-field-half"><span>Worker（在线）</span>${nativeSelect(["DESKTOP-9F3A"])}</label>`,
    `<label class="chat-field chat-field-half"><span>模型</span>${nativeSelect(["默认", "Opus", "Sonnet", "Haiku"])}</label>`,
    `<label class="chat-field"><span>自动回复（兜底）</span>${ccSelect("否 · 等人回复（默认）")}</label>`,
    `<label class="chat-field"><span>首条消息（可选）</span><textarea rows="2" placeholder="填写则建对话后即开始；可配合下方定时发送"></textarea></label>`,
    `<label class="chat-field"><span>定时发送（可选，需先填首条消息）</span>${dtPicker("立即发送；选择时间则定时发送", true)}</label>`
  ].join("");

  return `<div class="chat-modal-backdrop">
  <div class="chat-modal chat-modal-wide">
    <header class="chat-modal-head">
      <strong>新建对话</strong>
      <button class="icon-btn" type="button" title="关闭">${ic(16)}</button>
    </header>
    <div class="chat-modal-body">${fields}</div>
    <footer class="chat-modal-foot">
      <button class="btn btn-sm" type="button">取消</button>
      <button class="btn btn-sm btn-primary" type="button">创建并开始</button>
    </footer>
  </div>
</div>`;
}

function pageHtml(bodyInner) {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style>
<style>html,body{margin:0}</style></head>
<body><div class="app"><main class="main">${bodyInner}</main></div></body></html>`;
}

// 桌面 + 手机三档。桌面验证 560 加宽 + 双列；手机验证回落单列 + 无横向溢出。
const VIEWS = [
  { name: "desktop", width: 1024, height: 820, mobile: false },
  { name: "mobile-360", width: 360, height: 844, mobile: true },
  { name: "mobile-390", width: 390, height: 844, mobile: true },
  { name: "mobile-414", width: 414, height: 844, mobile: true }
];

const probe = `(() => {
  const modal = document.querySelector('.chat-modal');
  const mr = modal.getBoundingClientRect();
  const body = document.querySelector('.chat-modal-body');
  const halves = [...document.querySelectorAll('.chat-field-half')];
  const proj = halves[0].getBoundingClientRect();
  const branch = halves[1].getBoundingClientRect();
  const projBranchSideBySide = Math.abs(proj.top - branch.top) < 2 && branch.left > proj.right - 2;
  const docW = document.documentElement.scrollWidth;
  return {
    innerWidth,
    modalWidth: Math.round(mr.width),
    bodyGridColumns: getComputedStyle(body).gridTemplateColumns,
    halfTops: halves.map(h => Math.round(h.getBoundingClientRect().top)),
    projBranchSideBySide,
    hOverflow: docW - innerWidth
  };
})()`;

// ---------- CDP 驱动 ----------
const profileDir = path.join(os.tmpdir(), `cc-shot-newconv-${PORT}`);
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
      /* devtools 未就绪 */
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

const htmlDoc = pageHtml(modalHtml());
const htmlPath = path.join(outDir, "new-conversation.html");
writeFileSync(htmlPath, htmlDoc, "utf8");
const fileUrl = "file:///" + htmlPath.split(path.sep).join("/");

const summaryAll = {};
for (const v of VIEWS) {
  await send("Emulation.setDeviceMetricsOverride", {
    width: v.width,
    height: v.height,
    deviceScaleFactor: 2,
    mobile: v.mobile
  });
  const loaded = waitEvent("Page.loadEventFired");
  await send("Page.navigate", { url: fileUrl });
  await loaded;
  await sleep(300);
  const result = await send("Runtime.evaluate", { returnByValue: true, expression: probe });
  summaryAll[v.name] = result.result.value;
  console.log(v.name, JSON.stringify(result.result.value));
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(path.join(outDir, `new-conversation-${v.name}.png`), Buffer.from(shot.data, "base64"));
}
writeFileSync(path.join(outDir, "probe.json"), JSON.stringify(summaryAll, null, 2), "utf8");
console.log("wrote screenshots + probe.json ->", outDir);

ws.close();
chrome.kill();
await sleep(400);
try {
  rmSync(profileDir, { recursive: true, force: true });
} catch {
  /* best-effort */
}
process.exit(0);
