// 手机端「任务详情四 Tab 卡片边距」+「实时对话布局」纯 CSS 布局验证截图。
// 用法：node shot.mjs <round 子目录名> <variant: orig|new> [chromePort]
//   - round 子目录名：截图与 probe 落到 ../<子目录>/（如 before / after）
//   - variant：orig = 改造前 DOM；new = 改造后 DOM（实时对话头部含 meta 折叠按钮 + data-open="0"）
//
// 思路：内联真实 globals.css（随本仓改动同步）+ 复刻 task-detail.tsx / chat-thread.tsx /
//       session-meta.tsx 的真实 DOM，用 headless Chrome 在多组手机视口下截全页。
//       不依赖 DB / 登录 / dev server——只验证改动本体：手机端 CSS 布局边距 / 折叠 / 溢出。
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

const roundDir = process.argv[2] || "before";
const variant = process.argv[3] || "orig";
const PORT = process.argv[4] ? Number(process.argv[4]) : 9341;
const outDir = path.join(featureDir, roundDir);
mkdirSync(outDir, { recursive: true });

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const css = readFileSync(cssPath, "utf8");
const WIDTHS = [360, 390, 414];

// ---- 小图标占位（线性 svg，尺寸贴近 lucide）----
const ic = (s = 13) =>
  `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/></svg>`;

function kv(k, v, mono) {
  return `<div class="kv-row"><span class="kv-k">${k}</span><span class="kv-v${mono ? " mono" : ""}">${v}</span></div>`;
}

// ============ 任务详情页（四 Tab，概览 Tab 激活）DOM 复刻 ============
function taskDetailHtml() {
  const tabs = [
    ["概览", true],
    ["时间线", false],
    ["Claude Code 执行", false],
    ["日志", false]
  ]
    .map(
      ([label, active]) =>
        `<button class="detail-tab-btn${active ? " is-active" : ""}"><span class="dt-ico">${ic(14)}</span>${label}</button>`
    )
    .join("");

  const summary = [
    ["ID", "7b3fa9c2-1d4e-4a8b-9f02-6c5e3d1a7b90", true],
    ["项目", "claude-center", false],
    ["分支", "feature/mobile-responsive-very-long-base → cc/task-1781951223423", true],
    ["Worker", "DESKTOP-9F3A", false],
    ["创建时间", "2026-06-20 14:32", false]
  ]
    .map(
      ([k, v, mono]) =>
        `<div class="ds-item">${ic(13)}<span class="ds-k">${k}</span><span class="ds-v${mono ? " mono" : ""}">${v}</span></div>`
    )
    .join("");

  const basicKv = [
    kv("任务 ID", "7b3fa9c2-1d4e-4a8b", true),
    kv("项目", "claude-center"),
    kv("签出分支", "main", true),
    kv("工作分支", "cc/task-1781951223423", true),
    kv("提交模式", "创建 PR"),
    kv("执行模型", "默认（跟随 Worker）")
  ].join("");

  const card = (title, bodyHtml, extraClass = "") =>
    `<section class="card ov-card${extraClass}"><div class="ov-head"><span class="ov-ico">${ic(15)}</span><h3 class="ov-title">${title}</h3></div><div class="ov-body ov-body--static">${bodyHtml}</div></section>`;

  const descBody = `<p class="detail-desc">实现手机端不同屏幕尺寸适配：任务详情四个 Tab 内卡片左右边距统一；实时对话页面 title 与 session-meta-bar 折叠、内容区域最大化。这是一段较长的任务描述，用于测试窄屏下卡片是否被横向撑破或边距错乱。</p>`;

  return `<div class="view">
  <div class="detail-page">
    <header class="detail-page-top">
      <button class="detail-back">${ic(16)} 返回任务流</button>
      <div class="detail-page-head">
        <div class="detail-head-title">
          <h1 class="detail-page-title">实现手机端不同屏幕尺寸适配并优化实时对话布局</h1>
          <span class="badge" data-tone="running"><span class="glyph">●</span>执行中</span>
        </div>
        <div class="detail-actions">
          <button class="btn btn-sm">${ic(14)} 编辑</button>
          <button class="btn btn-primary btn-sm">${ic(14)} 续接重试</button>
        </div>
      </div>
    </header>
    <div class="detail-summary-bar">${summary}</div>
    <nav class="detail-tabs">${tabs}</nav>
    <div class="detail-tab-content detail-tab-content--wide">
      <div class="overview-grid">
        <div class="ov-left">
          ${card("基本信息", `<div class="kv">${basicKv}</div>`)}
          ${card("进度", `<div class="kv">${kv("完成度", "65%")}${kv("当前阶段", "执行中")}</div>`)}
          ${card("相关信息", `<div class="kv">${kv("Worker", "DESKTOP-9F3A")}${kv("PR", "#131")}</div>`)}
          ${card("执行结果", `<div class="kv">${kv("状态", "运行中")}</div>`)}
        </div>
        ${card("任务描述", descBody, " ov-card--desc")}
      </div>
    </div>
  </div>
</div>`;
}

// ============ 实时对话页（移动端 active=消息线）DOM 复刻 ============
// opened：仅 new variant 用——true 渲染「点 ⓘ 展开」后的会话信息条状态。
function chatHtml(opened = false) {
  const isNew = variant === "new";
  const chip = (cls, inner, tone) =>
    `<span class="${cls}"${tone ? ` data-tone="${tone}"` : ""}>${inner}</span>`;
  const metaChips = [
    chip("sm-chip", `${ic(12)}数据库轮询`, "cancelled"),
    chip("sm-chip", `${ic(12)}sonnet 4.6`),
    chip(
      "sm-chip",
      `<span class="sm-worker-name">DESKTOP-9F3A</span><span class="sm-sep">·</span><span class="sm-worker-ver">claude 2.0.1</span><span class="sm-sep">·</span><span class="sm-worker-sub">Max 20×</span>`
    ),
    chip(
      "sm-chip sm-chip-usage",
      `${ic(12)}<span class="sm-usage-label">5h</span><span class="sm-usage-bar"><span class="sm-usage-fill" style="width:42%"></span></span><span class="sm-usage-pct">42%</span>`,
      "success"
    ),
    chip(
      "sm-chip sm-chip-usage",
      `${ic(12)}<span class="sm-usage-label">7d</span><span class="sm-usage-bar"><span class="sm-usage-fill" style="width:71%"></span></span><span class="sm-usage-pct">71%</span>`,
      "pending"
    ),
    chip("sm-chip", `${ic(12)}上下文 84.2k`),
    chip("sm-chip", `<span class="sm-usage-pair">12 轮 · in 1.2M / out 48k</span>`)
  ].join("");

  const bubbles = [];
  for (let i = 0; i < 6; i++) {
    bubbles.push(
      `<div class="tx-row user"><div class="tx-msg user"><div class="tx-text">用户消息 ${i + 1}：请帮我适配手机端的对话布局，标题和元信息栏排列要清晰。</div></div></div>`,
      `<div class="tx-row asst"><div class="tx-msg asst"><div class="tx-text">好的，我会把 session-meta-bar 在手机端折叠为可展开，标题与子信息单行省略，消息区域占据剩余高度并隐藏滚动条以获得更接近原生 App 的体验。这是第 ${i + 1} 段较长回复，用于把消息区填满以验证滚动与各区块高度分配。</div></div></div>`
    );
  }

  const metaToggle = isNew
    ? `<button class="chat-meta-toggle${opened ? " is-open" : ""}" type="button" aria-label="会话信息" aria-expanded="${opened}">${ic(16)}</button>`
    : "";
  const dataOpen = isNew ? (opened ? "1" : "0") : null;
  const metaBar = `<div class="session-meta-bar"${dataOpen ? ` data-open="${dataOpen}"` : ""}>${metaChips}</div>`;

  return `<div class="chat-wrap" data-active="1">
  <aside class="chat-list"></aside>
  <section class="chat-main">
    <div class="chat-thread">
      <header class="chat-thread-head">
        <button class="chat-back">${ic(18)}</button>
        <div class="chat-thread-title">
          <div class="chat-title-show"><strong>调试实时对话手机端布局适配</strong><button class="icon-btn chat-title-pen">${ic(13)}</button></div>
          <span class="chat-thread-sub">${ic(12)} DESKTOP-9F3A ${ic(12)} feature/mobile-responsive-very-long · claude-center</span>
        </div>
        ${metaToggle}
        <button class="btn btn-sm">结束对话</button>
      </header>
      ${metaBar}
      <div class="chat-msgs">${bubbles.join("")}</div>
      <div class="chat-composer">
        <textarea class="chat-composer-input" rows="2" placeholder="输入消息…"></textarea>
        <div class="chat-composer-bar">
          <span class="chat-composer-hint">Enter 发送 · Shift+Enter 换行</span>
          <button class="chat-send">${ic(18)}</button>
        </div>
      </div>
    </div>
  </section>
</div>`;
}

function pageHtml(bodyInner) {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style>
<style>html,body{margin:0}</style></head>
<body><div class="app"><main class="main">${bodyInner}</main></div></body></html>`;
}

const PAGES = [
  { name: "task-detail", html: taskDetailHtml(), probe: "task" },
  { name: "chat", html: chatHtml(false), probe: "chat" }
];
// new variant 额外出一张「展开会话信息」态，证明 ⓘ 折叠可逆。
if (variant === "new") {
  PAGES.push({ name: "chat-open", html: chatHtml(true), probe: "chat" });
}

// ---------- CDP 驱动 ----------
const profileDir = path.join(os.tmpdir(), `cc-shot-msa-${PORT}`);
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

const probeTask = `(() => {
  const docW = document.documentElement.scrollWidth;
  const cards = [...document.querySelectorAll('.ov-card')];
  const rects = cards.map(c => { const r = c.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right) }; });
  const lefts = [...new Set(rects.map(r => r.left))];
  const rights = [...new Set(rects.map(r => r.right))];
  const tabs = document.querySelector('.detail-tabs');
  return {
    innerWidth, docScrollWidth: docW, hOverflow: docW - innerWidth,
    cardLefts: lefts, cardRights: rights,
    cardLeftMargin: Math.min(...rects.map(r=>r.left)),
    cardRightMargin: innerWidth - Math.max(...rects.map(r=>r.right)),
    tabsScrollW: tabs.scrollWidth, tabsClientW: tabs.clientWidth, tabsOverflow: tabs.scrollWidth - tabs.clientWidth
  };
})()`;

const probeChat = `(() => {
  const docW = document.documentElement.scrollWidth;
  const meta = document.querySelector('.session-meta-bar');
  const metaVisible = meta ? getComputedStyle(meta).display !== 'none' : false;
  const metaH = meta && metaVisible ? Math.round(meta.getBoundingClientRect().height) : 0;
  const msgs = document.querySelector('.chat-msgs').getBoundingClientRect();
  const comp = document.querySelector('.chat-composer').getBoundingClientRect();
  const toggle = document.querySelector('.chat-meta-toggle');
  const toggleVisible = toggle ? getComputedStyle(toggle).display !== 'none' : false;
  const sb = getComputedStyle(document.querySelector('.chat-msgs')).scrollbarWidth;
  return {
    innerWidth, innerHeight, docScrollWidth: docW, hOverflow: docW - innerWidth,
    metaVisible, metaBarHeight: metaH, metaToggleVisible: toggleVisible,
    msgsHeight: Math.round(msgs.height), msgsScrollbar: sb,
    composerBottom: Math.round(comp.bottom), gapBelowComposer: Math.round(innerHeight - comp.bottom)
  };
})()`;

const summaryAll = {};
for (const page of PAGES) {
  const htmlDoc = pageHtml(page.html);
  const htmlPath = path.join(outDir, `${page.name}.html`);
  writeFileSync(htmlPath, htmlDoc, "utf8");
  const fileUrl = "file:///" + htmlPath.split(path.sep).join("/");
  for (const w of WIDTHS) {
    await send("Emulation.setDeviceMetricsOverride", {
      width: w,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true
    });
    const loaded = waitEvent("Page.loadEventFired");
    await send("Page.navigate", { url: fileUrl });
    await loaded;
    await sleep(300);
    const probe = await send("Runtime.evaluate", {
      returnByValue: true,
      expression: page.probe === "task" ? probeTask : probeChat
    });
    const key = `${page.name}@${w}`;
    summaryAll[key] = probe.result.value;
    console.log(key, JSON.stringify(probe.result.value));
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    const file = path.join(outDir, `${page.name}-${w}.png`);
    writeFileSync(file, Buffer.from(shot.data, "base64"));
  }
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
