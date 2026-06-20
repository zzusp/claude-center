// 总览页「Worker 概览」卡片的手机端布局验证截图（before/after 对比 + 地面真值）。
// 用法：node shot.mjs <globals.css 路径> [port]
//
// 思路：内联真实 globals.css + 复刻 overview.tsx 的 Worker 概览卡片 DOM（.grid-2 > .col > .card），
//       用 headless Chrome 在 390×844(iPhone 级)视口下截图。不依赖 DB / 登录 / dev server。
//       一次跑出 before（用 !important 还原修复前的 5 栏等分 grid）与 after（真实 css）两张图，
//       并用 getBoundingClientRect 打地面真值：worker-usage 右缘是否越过卡片内容区右缘。
//
// 关键坑：Windows 上 `--headless --window-size=390,844` 会被 OS 最小窗口宽钳到 ~478px，
//        innerWidth 并非 390。故走 CDP Emulation.setDeviceMetricsOverride 强制 390 视口。
//        见 memory: windows-headless-chrome-mobile-screenshot。
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
const PORT = process.argv[3] ? Number(process.argv[3]) : 9341;
if (!cssPath) throw new Error("用法: node shot.mjs <globals.css路径> [port]");
const css = readFileSync(cssPath, "utf8");

// 修复前的行为：还原 worker-row 在窄屏下的 5 栏等分 grid（即基础规则原状），用 !important 压过本次新增的两行布局。
const REVERT_CSS = `
@media (max-width: 560px){
  .worker-row[data-layout="split"]{
    grid-template-columns: auto minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) !important;
    grid-template-areas: none !important;
  }
  .worker-row[data-layout="split"] > *{ grid-area: auto !important; }
}`;

const SERVER_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="3" width="20" height="6" rx="1"/><rect x="2" y="15" width="20" height="6" rx="1"/><path d="M6 6h.01M6 18h.01"/></svg>`;

function workerRow(name, version, working, active, max) {
  const tone = active >= max ? "failed" : active >= Math.max(1, Math.round(max * 0.7)) ? "pending" : "success";
  const pct = Math.round((active / max) * 100);
  return `<div class="worker-row" data-layout="split">
      <span class="dot${working ? " pulse" : ""}" data-tone="online"></span>
      <span class="v" style="color: var(--text-1); font-weight: 600;">${name}</span>
      <span class="v mono">claude ${version}</span>
      <span class="badge" data-tone="${working ? "success" : "pending"}"><span class="glyph">${working ? "▶" : "⏸"}</span>${working ? "工作中" : "空闲"}</span>
      <span class="worker-usage" data-tone="${tone}" title="并发 ${active} / ${max}">
        <span class="worker-usage-bar"><span class="worker-usage-fill" style="width:${pct}%"></span></span>
        <span class="worker-usage-text">${active}/${max}</span>
      </span>
    </div>`;
}

const cardInner = `
  <section class="card">
    <div class="card-head">
      <h2 class="card-title"><span class="ico">${SERVER_SVG}</span>Worker 概览</h2>
      <span class="card-tools">2/3 在线</span>
    </div>
    <div class="card-body">
      <div class="worker-rows">
        ${workerRow("DESKTOP-9F3A2B7", "1.0.128", true, 2, 3)}
        ${workerRow("MacBook-Pro-工作机", "1.0.131", false, 0, 4)}
        ${workerRow("win-build-runner-01", "1.0.128", true, 5, 5)}
      </div>
    </div>
  </section>`;

function pageHtml(extraCss) {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style>
${extraCss ? `<style>${extraCss}</style>` : ""}
</head>
<body>
<div class="app"><main class="main"><div class="view">
  <div class="grid-2"><div class="col">${cardInner}</div><div class="col"></div></div>
</div></main></div>
</body></html>`;
}

const beforePath = path.join(outDir, "before.html");
const afterPath = path.join(outDir, "after.html");
writeFileSync(beforePath, pageHtml(REVERT_CSS), "utf8");
writeFileSync(afterPath, pageHtml(""), "utf8");
const toUrl = (p) => "file:///" + p.split(path.sep).join("/");

const profileDir = path.join(os.tmpdir(), `cc-overview-shot-${PORT}`);
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
      /* devtools 未就绪，继续轮询 */
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
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

// 地面真值探针：对每个 worker-row 比较 worker-usage 右缘 vs 卡片内容区右缘；
// 并比较 document 横向滚动（scrollWidth > clientWidth 即整页溢出屏幕）。
const PROBE = `(() => {
  const card = document.querySelector('.card-body');
  const cardRight = Math.round(card.getBoundingClientRect().right);
  const rows = [...document.querySelectorAll('.worker-row[data-layout="split"]')].map((r) => {
    const u = r.querySelector('.worker-usage').getBoundingClientRect();
    return { usageRight: Math.round(u.right), overflowPx: Math.round(u.right - cardRight) };
  });
  const de = document.documentElement;
  return {
    innerWidth: innerWidth,
    cardRight,
    docScrollWidth: de.scrollWidth,
    docClientWidth: de.clientWidth,
    pageOverflow: de.scrollWidth - de.clientWidth,
    rows
  };
})()`;

async function shoot(url, name) {
  const loaded = waitEvent("Page.loadEventFired");
  await send("Page.navigate", { url });
  await loaded;
  await sleep(250);
  const probe = await send("Runtime.evaluate", { returnByValue: true, expression: PROBE });
  console.log(`\n[${name}]`, JSON.stringify(probe.result.value, null, 2));
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(shot.data, "base64"));
  console.log(`wrote ${name}.png`);
}

await shoot(toUrl(beforePath), "before");
await shoot(toUrl(afterPath), "after");

ws.close();
chrome.kill();
await sleep(400);
try {
  rmSync(profileDir, { recursive: true, force: true });
} catch {
  /* 临时 profile 偶发 EBUSY，下次启动前会再清 */
}
process.exit(0);
