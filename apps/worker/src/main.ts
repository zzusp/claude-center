import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { ClaudeCenterWorker } from "./runner.js";

let worker: ClaudeCenterWorker | null = null;

// 窗口 HTML：状态 / 用量 / 能力自检 / 关联项目 / 在途任务 / 日志，经 preload 暴露的 workerApi 驱动。
// 视觉语言对齐 web 端 console 的 Claude Light 设计系统（apps/console/app/globals.css）：
// 暖灰背景 + 白卡片 + 语义状态色 + 轻阴影 + 圆角 + Inter/JetBrains Mono。
// 渲染层用字符串拼接（不嵌套反引号 / 不用 ${}）避免与外层模板字面量冲突。
function windowHtml(): string {
  return `
    <!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <style>
          :root {
            --bg:#fafaf9; --surface-1:#ffffff; --surface-2:#f5f5f4; --surface-3:#fafaf9;
            --border:#e7e5e4; --border-strong:#d6d3d1;
            --text-1:#1c1917; --text-2:#44403c; --text-3:#78716c; --text-4:#a8a29e;
            --success:#16a34a; --running:#2563eb; --pending:#f59e0b;
            --failed:#dc2626; --cancelled:#6b7280; --waiting:#0891b2; --merged:#7c3aed;
            --r-sm:8px; --r-md:10px; --r-lg:12px;
            --shadow-1:0 1px 2px rgba(28,25,23,.04);
            --shadow-2:0 4px 16px rgba(28,25,23,.08);
            --font-sans:Inter, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
            --font-mono:"JetBrains Mono", ui-monospace, "Cascadia Code", Consolas, monospace;
          }
          * { box-sizing: border-box; }
          body {
            margin: 0; padding: 20px; background: var(--bg); color: var(--text-1);
            font-family: var(--font-sans); font-size: 14px; line-height: 1.6;
            -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
          }

          /* Header / brand */
          .app-head { margin: 0 0 18px; }
          .layout { display: grid; grid-template-columns: minmax(300px, 360px) 1fr; gap: 16px; align-items: start; }
          .col { min-width: 0; }
          .col > .card:last-child { margin-bottom: 0; }
          .brand { display: flex; align-items: center; gap: 11px; }
          .brand-mark {
            display: grid; place-items: center; width: 32px; height: 32px; flex-shrink: 0;
            border-radius: 8px; background: var(--text-1); color: var(--surface-1);
            font-size: 13px; font-weight: 700; letter-spacing: -.02em;
          }
          .brand-title { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: -.01em; }
          .brand-sub { margin: 2px 0 0; font-size: 12px; color: var(--text-3); }

          /* Card */
          .card {
            background: var(--surface-1); border: 1px solid var(--border);
            border-radius: var(--r-lg); box-shadow: var(--shadow-1); margin-bottom: 16px;
          }
          .card-head {
            display: flex; align-items: center; justify-content: space-between; gap: 12px;
            padding: 13px 16px; border-bottom: 1px solid var(--border);
          }
          .card-title { margin: 0; font-size: 13.5px; font-weight: 600; color: var(--text-1); }
          .card-body { padding: 14px 16px; }

          /* Settings rows */
          .set-row {
            display: flex; align-items: center; justify-content: space-between; gap: 12px;
            padding: 10px 0; border-top: 1px solid var(--border);
          }
          .set-row:first-child { border-top: 0; padding-top: 0; }
          .set-row:last-child { padding-bottom: 0; }
          .set-label { font-size: 13px; color: var(--text-1); }
          .set-hint { display: block; font-size: 11.5px; font-weight: 400; color: var(--text-4); margin-top: 2px; }

          /* Toggle switch */
          .switch { position: relative; width: 40px; height: 22px; flex: none; }
          .switch input { opacity: 0; width: 0; height: 0; }
          .slider { position: absolute; inset: 0; cursor: pointer; background: var(--border-strong); border-radius: 999px; transition: .15s; }
          .slider::before {
            content: ""; position: absolute; height: 16px; width: 16px; left: 3px; top: 3px;
            background: var(--surface-1); border-radius: 50%; transition: .15s; box-shadow: var(--shadow-1);
          }
          input:checked + .slider { background: var(--success); }
          input:checked + .slider::before { transform: translateX(18px); }

          /* Badge */
          .badge {
            display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px 2px 7px;
            border-radius: 999px; font-size: 12px; font-weight: 600; line-height: 1.6; white-space: nowrap;
          }
          .badge .glyph { font-size: 11px; line-height: 1; }
          .badge[data-tone=success] { color: var(--success); background: rgba(22,163,74,.10); }
          .badge[data-tone=pending] { color: var(--pending); background: rgba(245,158,11,.12); }
          .badge[data-tone=running] { color: var(--running); background: rgba(37,99,235,.10); }
          .badge[data-tone=failed]  { color: var(--failed);  background: rgba(220,38,38,.10); }
          .badge[data-tone=cancelled] { color: var(--cancelled); background: rgba(107,114,128,.12); }
          .badge[data-tone=waiting] { color: var(--waiting); background: rgba(8,145,178,.10); }
          .badge[data-tone=merged] { color: var(--merged); background: rgba(124,58,237,.10); }

          /* Capability dots */
          .cap-row { display: flex; flex-wrap: wrap; gap: 8px 18px; }
          .cap-item { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; color: var(--text-2); }
          .dot { display: inline-block; width: 8px; height: 8px; border-radius: 999px; background: currentColor; color: var(--text-4); flex-shrink: 0; }
          .dot[data-tone=success] { color: var(--success); }
          .dot[data-tone=failed]  { color: var(--failed); }

          /* Usage bars */
          .usage-block { margin-bottom: 12px; }
          .usage-block:last-child { margin-bottom: 0; }
          .usage-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; font-size: 12px; color: var(--text-2); margin-bottom: 5px; }
          .usage-head .pct { color: var(--text-3); font-variant-numeric: tabular-nums; }
          .usage-track { height: 6px; border-radius: 4px; background: var(--surface-2); overflow: hidden; }
          .usage-fill { height: 100%; border-radius: 4px; background: var(--success); }
          .usage-fill[data-tone=pending] { background: var(--pending); }
          .usage-fill[data-tone=failed]  { background: var(--failed); }
          .usage-foot { display: flex; justify-content: space-between; gap: 8px; margin-top: 5px; font-size: 11px; color: var(--text-4); }
          .usage-at { font-variant-numeric: tabular-nums; }

          /* Terminal config */
          .term-form { display: flex; flex-direction: column; gap: 9px; }
          .term-label { font-size: 11.5px; color: var(--text-4); }
          .term-area {
            min-height: 46px; resize: vertical; padding: 7px 9px; border: 1px solid var(--border);
            border-radius: var(--r-sm); background: var(--surface-1); color: var(--text-1);
            font-family: var(--font-mono); font-size: 12px; outline: none;
          }
          .term-area:focus { border-color: var(--running); box-shadow: 0 0 0 3px rgba(37,99,235,.12); }
          .term-save { align-self: flex-start; }
          .term-hint { font-size: 11px; color: var(--text-4); }

          /* List items (projects / active tasks) */
          .list-item {
            display: flex; align-items: center; justify-content: space-between; gap: 10px;
            padding: 10px 0; border-top: 1px solid var(--border);
          }
          .list-item:first-child { border-top: 0; }
          .li-main { min-width: 0; }
          .li-title { font-size: 13px; font-weight: 600; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          .li-sub { display: block; font-size: 11.5px; color: var(--text-4); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 340px; }

          /* Buttons */
          .btn {
            display: inline-flex; align-items: center; justify-content: center; gap: 6px;
            min-height: 32px; padding: 0 13px; border: 1px solid var(--border); border-radius: var(--r-sm);
            background: var(--surface-1); color: var(--text-1); font-size: 13px; font-weight: 500;
            cursor: pointer; transition: background .12s ease, border-color .12s ease;
          }
          .btn:hover:not(:disabled) { background: var(--surface-2); }
          .btn:disabled { opacity: .5; cursor: not-allowed; }
          .btn-primary { background: var(--text-1); border-color: var(--text-1); color: var(--surface-1); }
          .btn-primary:hover:not(:disabled) { background: #000; }
          .btn-sm { min-height: 28px; padding: 0 10px; font-size: 12.5px; }
          .btn.danger { color: var(--failed); border-color: var(--border); }
          .btn.danger:hover:not(:disabled) { background: rgba(220,38,38,.06); border-color: var(--failed); }

          /* Inputs */
          .num-input {
            width: 64px; padding: 6px 9px; border: 1px solid var(--border); border-radius: var(--r-sm);
            background: var(--surface-1); color: var(--text-1); font-family: inherit; font-size: 13px;
            text-align: right; outline: none; transition: border-color .12s ease, box-shadow .12s ease;
          }
          .cloud-select, .path-input {
            width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--r-sm);
            background: var(--surface-1); color: var(--text-1); font-family: inherit; font-size: 13px;
            outline: none; transition: border-color .12s ease, box-shadow .12s ease;
          }
          .num-input:focus, .cloud-select:focus, .path-input:focus {
            border-color: var(--running); box-shadow: 0 0 0 3px rgba(37,99,235,.12);
          }
          .path-input[readonly] { color: var(--text-3); background: var(--surface-3); }

          /* Add-project form */
          .addform { display: grid; grid-template-columns: 1fr auto; gap: 8px; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border); }
          .addform .grow { display: flex; gap: 8px; }
          .addform .path-input { grid-column: 1 / -1; }

          /* Logs */
          .logs {
            font-family: var(--font-mono); font-size: 12px; line-height: 1.7;
            background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-sm);
            padding: 10px 12px; height: 150px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;
            color: var(--text-2);
          }
          .log-line.err { color: var(--failed); }
          .log-time { color: var(--text-4); }

          /* Empty state */
          .empty { color: var(--text-4); font-size: 12.5px; padding: 6px 0; }

          /* Task panel (Agent-View style) */
          .task-group { margin-bottom: 14px; }
          .task-group:last-child { margin-bottom: 0; }
          .task-group-head { display: flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 600; color: var(--text-3); margin-bottom: 4px; }
          .task-count { color: var(--text-4); font-weight: 500; }
          .task-item { border-top: 1px solid var(--border); }
          .task-item:first-child { border-top: 0; }
          .task-row { display: flex; align-items: center; gap: 10px; padding: 9px 0; cursor: pointer; }
          .task-row:hover { background: var(--surface-3); }
          .task-row .li-main { flex: 1; }
          .task-time { font-size: 11.5px; color: var(--text-4); font-variant-numeric: tabular-nums; white-space: nowrap; }
          .task-actions { display: flex; gap: 6px; }
          .badge.pr { text-decoration: none; cursor: pointer; }
          .task-detail { padding: 2px 0 12px; border-top: 1px dashed var(--border); }
          .qbox { background: rgba(8,145,178,.07); border: 1px solid rgba(8,145,178,.2); border-radius: var(--r-sm); padding: 8px 10px; margin: 10px 0; font-size: 12.5px; }
          .qbox b { display: block; margin-bottom: 3px; font-size: 11.5px; color: var(--waiting); }
          .qbox div { white-space: pre-wrap; overflow-wrap: anywhere; }
          .detail-section { margin-bottom: 10px; }
          .detail-label { font-size: 11px; font-weight: 600; color: var(--text-4); margin-bottom: 4px; }
          .cmt { padding: 6px 0; }
          .cmt-who { font-size: 11.5px; font-weight: 600; color: var(--text-2); }
          .cmt.user .cmt-who { color: var(--running); }
          .cmt-time { font-size: 11px; color: var(--text-4); margin-left: 6px; }
          .cmt-body { margin-top: 2px; font-size: 12.5px; color: var(--text-1); white-space: pre-wrap; overflow-wrap: anywhere; }
          .ev-list { font-family: var(--font-mono); font-size: 11.5px; color: var(--text-3); }
          .ev { padding: 1px 0; overflow-wrap: anywhere; }
          .detail-act { display: flex; gap: 8px; align-items: flex-start; margin-top: 8px; }
          .reply-input {
            flex: 1; min-height: 52px; resize: vertical; padding: 7px 9px; border: 1px solid var(--border);
            border-radius: var(--r-sm); background: var(--surface-1); color: var(--text-1);
            font-family: inherit; font-size: 12.5px; outline: none;
          }
          .reply-input:focus { border-color: var(--running); box-shadow: 0 0 0 3px rgba(37,99,235,.12); }
.card-title{display:flex;align-items:center;gap:7px;}
          .card-title .ico{display:inline-flex;color:var(--text-3);flex-shrink:0;}
          .live-dot{display:inline-block;width:7px;height:7px;border-radius:999px;background:var(--success);margin-right:7px;position:relative;}
          .live-dot.pulse{animation:cc-breathe 1.8s ease-in-out infinite;}
          .live-dot.pulse::after{content:"";position:absolute;inset:-3px;border-radius:999px;background:var(--success);opacity:.18;animation:cc-ring 1.8s ease-in-out infinite;}
          @keyframes cc-breathe{0%,100%{opacity:1}50%{opacity:.5}}
          @keyframes cc-ring{0%{transform:scale(.7);opacity:.25}70%{transform:scale(1.7);opacity:0}100%{opacity:0}}
          </style>
      </head>
      <body>
        <header class="app-head">
          <div class="brand">
            <span class="brand-mark">CC</span>
            <div>
              <h1 class="brand-title">ClaudeCenter Worker</h1>
              <p class="brand-sub"><span class="live-dot pulse"></span><span id="meta">连接中…</span></p>
            </div>
          </div>
        </header>

        <div class="layout">
        <div class="col">
        <section class="card">
          <div class="card-head">
            <h2 class="card-title"><span class="ico"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="8" x2="20" y2="8"/><line x1="4" y1="16" x2="20" y2="16"/><circle cx="9" cy="8" r="2.4"/><circle cx="15" cy="16" r="2.4"/></svg></span>状态与设置</h2>
            <span class="badge" id="state" data-tone="cancelled"><span class="glyph">·</span>—</span>
          </div>
          <div class="card-body">
            <div class="set-row">
              <span class="set-label">工作状态<span class="set-hint">开 = 接任务；关 = 在线但不接任务</span></span>
              <label class="switch"><input type="checkbox" id="workingToggle" /><span class="slider"></span></label>
            </div>
            <div class="set-row">
              <span class="set-label">允许 web 端远程开关<span class="set-hint">关闭后中控无法远程切换工作态</span></span>
              <label class="switch"><input type="checkbox" id="remoteToggle" /><span class="slider"></span></label>
            </div>
            <div class="set-row">
              <span class="set-label">并发上限<span class="set-hint">同时执行的在途任务数</span></span>
              <input type="number" id="maxParallel" class="num-input" min="1" max="16" />
            </div>
          </div>
        </section>

        <section class="card">
          <div class="card-head"><h2 class="card-title"><span class="ico"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 2.5v5.5c0 4-3 7-7 8-4-1-7-4-7-8V5.5z"/><path d="M9 12l2 2 4-4"/></svg></span>能力自检</h2></div>
          <div class="card-body"><div id="caps" class="cap-row">—</div></div>
        </section>

        <section class="card">
          <div class="card-head"><h2 class="card-title"><span class="ico"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3"/><line x1="13" y1="15" x2="17" y2="15"/></svg></span>运行终端</h2></div>
          <div class="card-body">
            <div class="term-form">
              <span class="term-label">运行 claude 的终端（本机检测，或选「手动输入」自填路径）</span>
              <select id="terminalSelect" class="cloud-select"></select>
              <input id="terminalPath" class="path-input" placeholder="终端可执行文件全路径" />
              <span class="term-label">前置命令（运行 claude 前在该终端先执行，如 VPN / 代理 / 账号登录；按所选终端语法书写）</span>
              <textarea id="preCommand" class="term-area" placeholder="留空 = 不执行；示例(PowerShell)：& 'C:\\path\\vpn.exe' connect"></textarea>
              <button id="saveTerminal" class="btn btn-sm btn-primary term-save" type="button">保存</button>
              <span class="term-hint" id="terminalHint"></span>
            </div>
          </div>
        </section>

        <section class="card" id="usageSection" style="display:none">
          <div class="card-head"><h2 class="card-title"><span class="ico"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 16a7 7 0 1 1 14 0"/><path d="M12 16l3.5-3.5"/></svg></span>套餐用量</h2></div>
          <div class="card-body" id="usage"></div>
        </section>

        <section class="card">
          <div class="card-head"><h2 class="card-title"><span class="ico"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7a1.5 1.5 0 0 1 1.5-1.5h3.2l1.8 1.8h8A1.5 1.5 0 0 1 20 8.8V17a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17z"/></svg></span>关联项目</h2></div>
          <div class="card-body">
            <div id="projects"><span class="empty">加载中…</span></div>
            <div class="addform">
              <select id="cloudProject" class="cloud-select"></select>
              <div class="grow">
                <button id="pickBtn" class="btn btn-sm" type="button">选择文件夹</button>
                <button id="addBtn" class="btn btn-sm btn-primary" type="button">添加</button>
              </div>
              <input class="path-input" id="localPath" placeholder="本地路径（点「选择文件夹」）" readonly />
            </div>
          </div>
        </section>
        </div>

        <div class="col">
        <section class="card">
          <div class="card-head">
            <h2 class="card-title"><span class="ico"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h3.5l2.5 7 4-14 2.5 7H21"/></svg></span>任务</h2>
            <button id="tasksRefresh" class="btn btn-sm" type="button">刷新</button>
          </div>
          <div class="card-body"><div id="tasks"><span class="empty">加载中…</span></div></div>
        </section>

        <section class="card">
          <div class="card-head"><h2 class="card-title"><span class="ico"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8l3.5 3L5 14"/><line x1="11" y1="15" x2="18" y2="15"/></svg></span>日志</h2></div>
          <div class="card-body"><div id="logs" class="logs"></div></div>
        </section>
        </div>
        </div>

        <script>
          const $ = (id) => document.getElementById(id);
          const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
            ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

          function elapsed(iso) {
            const ms = Date.now() - new Date(iso).getTime();
            if (!isFinite(ms) || ms < 0) return "";
            const s = Math.floor(ms / 1000);
            if (s < 60) return s + "s";
            const m = Math.floor(s / 60);
            if (m < 60) return m + "m" + (s % 60) + "s";
            return Math.floor(m / 60) + "h" + (m % 60) + "m";
          }

          function capDot(name, cap) {
            const ok = cap && cap.ok;
            return '<span class="cap-item"><span class="dot" data-tone="' + (ok ? "success" : "failed") + '"></span>' +
              name + (ok && cap.version ? " " + esc(cap.version) : ok ? "" : " 未检出") + "</span>";
          }

          // 距 resets_at 还剩多久（每次刷新重算，呈倒计时）。
          function resetRemain(iso) {
            const ms = new Date(iso).getTime() - Date.now();
            if (!isFinite(ms) || ms <= 0) return "即将重置";
            const totalMin = Math.floor(ms / 60000);
            const d = Math.floor(totalMin / 1440), h = Math.floor((totalMin % 1440) / 60), m = totalMin % 60;
            if (d > 0) return "重置剩余 " + d + "天" + h + "小时";
            if (h > 0) return "重置剩余 " + h + "小时" + m + "分";
            return "重置剩余 " + m + "分";
          }
          function resetClock(iso) {
            const dt = new Date(iso);
            if (isNaN(dt.getTime())) return "";
            const p = (n) => String(n).padStart(2, "0");
            return p(dt.getMonth() + 1) + "/" + p(dt.getDate()) + " " + p(dt.getHours()) + ":" + p(dt.getMinutes());
          }

          // API 只给 utilization 百分比（无绝对 token 数），「已用/总」以百分比表达；脚注补重置倒计时 + 时刻。
          function usageBar(label, win) {
            if (!win) return "";
            const pct = Math.max(0, Math.min(100, Math.round(win.utilization)));
            const tone = pct >= 90 ? "failed" : pct >= 70 ? "pending" : "success";
            const foot = win.resets_at
              ? '<div class="usage-foot"><span>' + esc(resetRemain(win.resets_at)) + '</span><span class="usage-at">' + esc(resetClock(win.resets_at)) + ' 重置</span></div>'
              : "";
            return '<div class="usage-block"><div class="usage-head"><span>' + label + '</span><span class="pct">已用 ' + pct + '% / 100%</span></div>' +
              '<div class="usage-track"><div class="usage-fill" data-tone="' + tone + '" style="width:' + pct + '%"></div></div>' + foot + '</div>';
          }

          // —— 任务面板（Agent-View 式：仅本 worker，分组 + peek + 回复/打回/验收）——
          var TASK_STATUS_META = {
            waiting:   { group: "needs",   label: "需输入",   tone: "waiting" },
            success:   { group: "review",  label: "待审",     tone: "success" },
            claimed:   { group: "working", label: "已认领",   tone: "running" },
            running:   { group: "working", label: "执行中",   tone: "running" },
            rejected:  { group: "working", label: "打回重跑", tone: "pending" },
            merged:    { group: "done",    label: "已合并",   tone: "merged" },
            accepted:  { group: "done",    label: "已验收",   tone: "success" },
            failed:    { group: "done",    label: "失败",     tone: "failed" },
            cancelled: { group: "done",    label: "已取消",   tone: "cancelled" }
          };
          var TASK_GROUPS = [
            { key: "needs",   title: "需输入" },
            { key: "review",  title: "待审" },
            { key: "working", title: "进行中" },
            { key: "done",    title: "已完成" }
          ];
          var expandedTaskId = null;
          var tasksCache = [];

          function statusMeta(status) {
            return TASK_STATUS_META[status] || { group: "done", label: status, tone: "cancelled" };
          }
          function prTag(t) {
            if (t.submit_mode === "push" || !t.pr_url) return "";
            const tone = (t.status === "merged" || t.merge_status === "merged") ? "merged"
              : t.status === "success" ? "success" : "pending";
            return '<a class="badge pr" data-tone="' + tone + '" data-task-action="pr" href="' + esc(t.pr_url) + '" target="_blank">PR</a>';
          }
          function taskSummary(t) {
            if (t.status === "waiting") return "⚠ 等待你的回复";
            if (t.status === "failed" && t.error_message) return esc(t.error_message);
            return esc(t.project_name || "") + (t.work_branch ? " · " + esc(t.work_branch) : "");
          }
          function taskRow(t) {
            const m = statusMeta(t.status);
            const actions = (t.status === "claimed" || t.status === "running")
              ? '<button class="btn btn-sm danger" data-task-action="cancel" data-task-id="' + esc(t.id) + '">取消</button>' : "";
            const head =
              '<div class="task-row" data-row="' + esc(t.id) + '">' +
                '<span class="badge" data-tone="' + m.tone + '"><span class="glyph">●</span>' + m.label + '</span>' +
                '<span class="li-main"><span class="li-title">' + esc(t.title) + '</span>' +
                '<span class="li-sub">' + taskSummary(t) + '</span></span>' +
                prTag(t) +
                '<span class="task-time">' + elapsed(t.updated_at) + '</span>' +
                '<span class="task-actions">' + actions + '</span>' +
              '</div>';
            const detail = expandedTaskId === t.id
              ? '<div class="task-detail" id="detail-' + esc(t.id) + '"><span class="empty">加载中…</span></div>' : "";
            return '<div class="task-item">' + head + detail + '</div>';
          }
          function renderTasks(tasks) {
            tasksCache = tasks || [];
            if (!tasksCache.length) { $("tasks").innerHTML = '<span class="empty">本机暂无任务</span>'; return; }
            const byGroup = {};
            tasksCache.forEach((t) => { const g = statusMeta(t.status).group; (byGroup[g] = byGroup[g] || []).push(t); });
            let html = "";
            TASK_GROUPS.forEach((g) => {
              const list = byGroup[g.key];
              if (!list || !list.length) return;
              html += '<div class="task-group"><div class="task-group-head">' + g.title +
                ' <span class="task-count">' + list.length + '</span></div>' + list.map(taskRow).join("") + "</div>";
            });
            $("tasks").innerHTML = html;
            if (expandedTaskId) loadDetail(expandedTaskId);
          }
          async function reloadTasks() {
            let tasks = [];
            try { tasks = await window.workerApi.listMyTasks(); } catch (e) { return; }
            renderTasks(tasks);
          }
          async function loadDetail(taskId) {
            const box = document.getElementById("detail-" + taskId);
            if (!box) return;
            let d;
            try { d = await window.workerApi.getTaskDetail(taskId); }
            catch (e) { box.innerHTML = '<span class="empty">加载失败</span>'; return; }
            const t = tasksCache.find((x) => x.id === taskId);
            const comments = d.comments || [], events = d.events || [];
            let html = "";
            if (t && t.status === "waiting") {
              const q = comments.slice().reverse().find((c) => c.author === "worker");
              if (q) html += '<div class="qbox"><b>待答问题</b><div>' + esc(q.body) + "</div></div>";
            }
            html += '<div class="detail-section"><div class="detail-label">评论</div>' +
              (comments.length ? comments.map((c) =>
                '<div class="cmt ' + (c.author === "user" ? "user" : "wk") + '"><span class="cmt-who">' +
                (c.author === "user" ? "我" : "worker") + '</span><span class="cmt-time">' +
                esc(String(c.created_at).slice(5, 16).replace("T", " ")) + '</span>' +
                '<div class="cmt-body">' + esc(c.body) + "</div></div>").join("")
                : '<span class="empty">无评论</span>') + "</div>";
            html += '<div class="detail-section"><div class="detail-label">事件</div>' +
              (events.length ? '<div class="ev-list">' + events.map((e) =>
                '<div class="ev"><span class="log-time">' + esc(String(e.created_at).slice(11, 19)) + "</span> " +
                esc(e.event_type) + " · " + esc(e.message) + "</div>").join("") + "</div>"
                : '<span class="empty">无事件</span>') + "</div>";
            if (t && t.status === "waiting") {
              html += '<div class="detail-act"><textarea class="reply-input" id="reply-' + esc(taskId) + '" placeholder="回复以续接会话…"></textarea>' +
                '<button class="btn btn-sm btn-primary" data-task-action="reply-send" data-task-id="' + esc(taskId) + '">发送</button></div>';
            }
            if (t && t.status === "success") {
              html += '<div class="detail-act"><textarea class="reply-input" id="reject-' + esc(taskId) + '" placeholder="打回意见（打回时必填）…"></textarea>' +
                '<button class="btn btn-sm" data-task-action="accept" data-task-id="' + esc(taskId) + '">验收通过</button>' +
                '<button class="btn btn-sm danger" data-task-action="reject-send" data-task-id="' + esc(taskId) + '">打回</button></div>';
            }
            box.innerHTML = html;
          }
          function isEditingTask() {
            const a = document.activeElement;
            return !!(a && a.classList && a.classList.contains("reply-input"));
          }
          async function handleTaskAction(action, id, el) {
            if (action === "pr") return;
            if (action === "cancel") { el.disabled = true; await window.workerApi.cancelTask(id); await reloadTasks(); return; }
            if (action === "reply-send") {
              const ta = document.getElementById("reply-" + id); const body = ta && ta.value.trim();
              if (!body) return;
              el.disabled = true; await window.workerApi.replyToTask(id, body); expandedTaskId = null; await reloadTasks(); return;
            }
            if (action === "accept") {
              el.disabled = true; const ok = await window.workerApi.acceptMyTask(id);
              if (!ok) alert("任务已不在待审状态"); expandedTaskId = null; await reloadTasks(); return;
            }
            if (action === "reject-send") {
              const ta = document.getElementById("reject-" + id); const fb = ta && ta.value.trim();
              if (!fb) { alert("打回必须填写意见"); return; }
              el.disabled = true; const ok = await window.workerApi.rejectMyTask(id, fb);
              if (!ok) alert("任务已不在待审状态"); expandedTaskId = null; await reloadTasks(); return;
            }
          }

          async function refresh() {
            let s;
            try { s = await window.workerApi.getState(); } catch (e) { return; }
            if (!s) return;
            const working = s.workingState === "working";
            $("meta").textContent =
              (s.workerName || "worker") + " · " + ((s.os && s.os.label) || "—") + " · claude " + (s.claudeVersion || "—") + " · " +
              s.subscriptionType + " · 在途 " + s.activeCount + "/" + s.maxParallel;
            const state = $("state");
            state.setAttribute("data-tone", working ? "success" : "pending");
            state.innerHTML = '<span class="glyph">' + (working ? "▶" : "⏸") + "</span>" + (working ? "工作中" : "空闲");
            if (document.activeElement !== $("workingToggle")) $("workingToggle").checked = working;
            if (document.activeElement !== $("remoteToggle")) $("remoteToggle").checked = !!s.allowRemoteControl;
            if (document.activeElement !== $("maxParallel")) $("maxParallel").value = s.maxParallel;

            const caps = s.capabilities || {};
            $("caps").innerHTML = [capDot("git", caps.git), capDot("gh", caps.gh), capDot("claude", caps.claude)].join("");

            const u = s.usage || {};
            const bars = usageBar("5 小时窗口", u.five_hour) + usageBar("7 天窗口", u.seven_day);
            $("usageSection").style.display = bars ? "block" : "none";
            $("usage").innerHTML = bars;

            const logs = s.logs || [];
            const box = $("logs");
            const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 8;
            box.innerHTML = logs.slice(-60).map((l) =>
              '<div class="log-line ' + (l.level === "error" ? "err" : "") + '">' +
              '<span class="log-time">' + esc(l.ts.slice(11, 19)) + "</span> " + esc(l.message) + "</div>").join("");
            if (atBottom) box.scrollTop = box.scrollHeight;
          }

          async function loadProjects() {
            let links = [], cloud = [];
            try { links = await window.workerApi.listProjectLinks(); } catch (e) {}
            try { cloud = await window.workerApi.listCloudProjects(); } catch (e) {}
            $("projects").innerHTML = (links && links.length) ? links.map((l) =>
              '<div class="list-item"><span class="li-main"><span class="li-title">' + esc(l.project_name) + '</span><span class="li-sub">' +
              esc(l.local_path) + "</span></span>" +
              '<button class="btn btn-sm danger" data-unlink="' + esc(l.project_name) + "|||" + esc(l.local_path) + '">删除</button>' +
              "</div>").join("") : '<span class="empty">未关联任何项目</span>';
            const sel = $("cloudProject");
            sel.innerHTML = (cloud && cloud.length)
              ? cloud.map((p) => '<option value="' + esc(p.name) + '">' + esc(p.name) + "</option>").join("")
              : '<option value="">（无云端项目）</option>';
          }

          var MANUAL_TERMINAL = "__manual__";
          // 检测本机终端填充下拉，并按当前配置回显（匹配则选中、否则切「手动输入」并填路径）。
          async function loadTerminals() {
            let list = [], s = null;
            try { list = await window.workerApi.listTerminals(); } catch (e) {}
            try { s = await window.workerApi.getState(); } catch (e) {}
            const cur = (s && s.terminalCommand) || "";
            const sel = $("terminalSelect");
            const opts = (list || []).map((t) =>
              '<option value="' + esc(t.command) + '">' + esc(t.name) + " — " + esc(t.command) + "</option>");
            opts.push('<option value="' + MANUAL_TERMINAL + '">手动输入路径…</option>');
            opts.unshift('<option value="">默认（' + (s && s.os && s.os.platform === "win32" ? "powershell" : "直接运行 claude") + "）</option>");
            sel.innerHTML = opts.join("");
            const path = $("terminalPath");
            const matched = (list || []).some((t) => t.command === cur);
            if (!cur) { sel.value = ""; path.value = ""; path.readOnly = true; }
            else if (matched) { sel.value = cur; path.value = cur; path.readOnly = true; }
            else { sel.value = MANUAL_TERMINAL; path.value = cur; path.readOnly = false; }
            if (s && document.activeElement !== $("preCommand")) $("preCommand").value = s.claudePreCommand || "";
          }

          $("terminalSelect").addEventListener("change", () => {
            const v = $("terminalSelect").value, path = $("terminalPath");
            if (v === MANUAL_TERMINAL) { path.readOnly = false; path.value = ""; path.focus(); }
            else { path.readOnly = true; path.value = v; }
          });

          $("saveTerminal").addEventListener("click", async () => {
            const btn = $("saveTerminal"), hint = $("terminalHint");
            btn.disabled = true; hint.textContent = "保存中…";
            try {
              await window.workerApi.setTerminal($("terminalPath").value.trim());
              await window.workerApi.setPreCommand($("preCommand").value);
              hint.textContent = "已保存，下一个任务生效";
              await loadTerminals();
            } catch (e) { hint.textContent = "保存失败：" + (e && e.message ? e.message : e); }
            finally { btn.disabled = false; }
          });

          $("workingToggle").addEventListener("change", async (e) => { await window.workerApi.setWorking(e.target.checked); refresh(); });
          $("remoteToggle").addEventListener("change", async (e) => { await window.workerApi.setAllowRemote(e.target.checked); refresh(); });
          $("maxParallel").addEventListener("change", async (e) => {
            const v = parseInt(e.target.value, 10); if (v >= 1) { await window.workerApi.setMaxParallel(v); refresh(); }
          });
          $("pickBtn").addEventListener("click", async () => {
            const p = await window.workerApi.pickFolder(); if (p) $("localPath").value = p;
          });
          $("addBtn").addEventListener("click", async () => {
            const projectName = $("cloudProject").value, localPath = $("localPath").value;
            if (!projectName || !localPath) return;
            $("addBtn").disabled = true;
            try { await window.workerApi.addProjectLink({ projectName, localPath }); $("localPath").value = ""; await loadProjects(); }
            finally { $("addBtn").disabled = false; }
          });
          $("tasksRefresh").addEventListener("click", reloadTasks);

          document.addEventListener("click", async (e) => {
            const actionEl = e.target.closest && e.target.closest("[data-task-action]");
            if (actionEl) {
              await handleTaskAction(actionEl.getAttribute("data-task-action"),
                actionEl.getAttribute("data-task-id"), actionEl);
              return;
            }
            const unlinkEl = e.target.closest && e.target.closest("[data-unlink]");
            if (unlinkEl) {
              const [projectName, localPath] = unlinkEl.getAttribute("data-unlink").split("|||");
              await window.workerApi.removeProjectLink({ projectName, localPath }); await loadProjects();
              return;
            }
            const row = e.target.closest && e.target.closest("[data-row]");
            if (row) {
              const id = row.getAttribute("data-row");
              expandedTaskId = expandedTaskId === id ? null : id;
              renderTasks(tasksCache);
            }
          });

          refresh(); loadProjects(); reloadTasks(); loadTerminals();
          setInterval(refresh, 3000);
          setInterval(loadProjects, 15000);
          setInterval(() => { if (!isEditingTask()) reloadTasks(); }, 4000);
        </script>
      </body>
    </html>
  `;
}

function createWindow(): void {
  // preload 与资产同样按 ../ 解析到 apps/worker 下，dist(electron) 与 src(tsx) 两种运行方式路径一致。
  const appDir = path.dirname(fileURLToPath(import.meta.url));
  const window = new BrowserWindow({
    width: 1040,
    height: 860,
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
  ipcMain.handle("worker:listTerminals", () => worker?.listTerminals() ?? []);
  ipcMain.handle("worker:setTerminal", (_event, command: string) => worker?.setTerminalCommand(command));
  ipcMain.handle("worker:setPreCommand", (_event, command: string) => worker?.setPreCommand(command));
  ipcMain.handle("worker:listCloudProjects", () => worker?.listCloudProjects() ?? []);
  ipcMain.handle("worker:listProjectLinks", () => worker?.listProjectLinks() ?? []);
  ipcMain.handle("worker:addProjectLink", (_event, input: { projectName: string; localPath: string }) =>
    worker?.addProjectLink(input)
  );
  ipcMain.handle("worker:removeProjectLink", (_event, input: { projectName: string; localPath: string }) =>
    worker?.removeProjectLink(input)
  );
  ipcMain.handle("worker:cancelTask", (_event, taskId: string) => worker?.cancelTask(taskId) ?? false);

  // 桌面端任务面板（仅本 worker）：总览 / peek 详情 / 本机回复 / 打回 / 验收。
  ipcMain.handle("worker:listMyTasks", () => worker?.listMyTasks() ?? []);
  ipcMain.handle("worker:getTaskDetail", (_event, taskId: string) =>
    worker?.getTaskDetail(taskId) ?? { comments: [], events: [] }
  );
  ipcMain.handle("worker:replyToTask", (_event, taskId: string, body: string) => worker?.replyToTask(taskId, body));
  ipcMain.handle("worker:rejectMyTask", (_event, taskId: string, feedback: string) =>
    worker?.rejectMyTask(taskId, feedback) ?? false
  );
  ipcMain.handle("worker:acceptMyTask", (_event, taskId: string) => worker?.acceptMyTask(taskId) ?? false);

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
