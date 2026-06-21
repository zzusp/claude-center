// Electron Worker 桌面窗的整页 HTML（经 data URL 加载）。
// 信息架构对齐 web 端 Console（apps/console）：侧边栏菜单 + 固定 app shell + 主区可滚动 view。
// 视觉沿用 Claude Light 设计系统（apps/console/app/globals.css）：暖灰背景 + 白卡片 + 语义状态色。
//
// 关键约束（务必保持）：
//  1. 渲染层 <script> 内不嵌套反引号、不用 ${}（与本函数外层模板字面量冲突），一律字符串拼接。
//  2. 窗口高度恒定：body{overflow:hidden} + .main{height:100vh}；唯一页级滚动容器是 .view，
//     列表 / 日志卡片用 .scroll-body / 内部 max-height 自带滚动，内容变多不改变窗口/整页高度。
export function windowHtml(): string {
  return `
    <!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <style>
          :root {
            --bg:#f8f8f6; --surface-1:#ffffff; --surface-2:#f5f5f4; --surface-3:#fafaf9;
            --border:#e7e5e4; --border-strong:#d6d3d1;
            --text-1:#1c1917; --text-2:#44403c; --text-3:#78716c; --text-4:#a8a29e;
            --success:#16a34a; --running:#2563eb; --pending:#f59e0b;
            --failed:#dc2626; --cancelled:#6b7280; --waiting:#0891b2; --merged:#7c3aed;
            --r-sm:8px; --r-md:10px; --r-lg:12px;
            --shadow-1:0 1px 2px rgba(28,25,23,.04);
            --shadow-2:0 4px 16px rgba(28,25,23,.08);
            --font-sans:Inter, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
            --font-mono:"JetBrains Mono", ui-monospace, "Cascadia Code", Consolas, monospace;
            --sidebar-w:204px;
          }
          * { box-sizing: border-box; }
          html, body { height: 100%; }
          body {
            margin: 0; background: var(--bg); color: var(--text-1);
            font-family: var(--font-sans); font-size: 14px; line-height: 1.6;
            -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
            overflow: hidden; /* 整页不滚，滚动收敛到 .view / 卡片内部 */
          }
          button, input, textarea, select { font: inherit; color: inherit; }

          /* —— 全局滚动条（Electron/Chromium webkit）—— */
          ::-webkit-scrollbar { width: 6px; height: 6px; }
          ::-webkit-scrollbar-track { background: transparent; }
          ::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 999px; }
          ::-webkit-scrollbar-thumb:hover { background: var(--text-4); }
          ::-webkit-scrollbar-corner { background: transparent; }

          /* —— App shell —— */
          .app { display: flex; height: 100vh; }
          .sidebar {
            width: var(--sidebar-w); flex-shrink: 0; height: 100vh;
            display: flex; flex-direction: column; padding: 16px 12px;
            background: var(--bg); border-right: 1px solid var(--border);
          }
          .brand { display: flex; align-items: center; gap: 10px; padding: 6px 8px 14px; }
          .brand-mark {
            display: grid; place-items: center; width: 30px; height: 30px; flex-shrink: 0;
            border-radius: 8px; background: var(--text-1); color: var(--surface-1);
            font-size: 12px; font-weight: 700; letter-spacing: -.02em;
          }
          .brand-tt { display: flex; flex-direction: column; line-height: 1.2; min-width: 0; }
          .brand-title { font-size: 14px; font-weight: 600; letter-spacing: -.01em; }
          .brand-sub { font-size: 11px; color: var(--text-3); }

          .nav { display: flex; flex-direction: column; gap: 2px; margin-top: 6px; }
          .nav-item {
            display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 10px;
            border: none; border-radius: var(--r-sm); background: transparent; color: var(--text-2);
            font-size: 13.5px; font-weight: 400; text-align: left; cursor: pointer;
            transition: background .12s ease, color .12s ease;
          }
          .nav-item:hover { background: #efeeeb; color: var(--text-1); }
          .nav-item.active { background: #efeeeb; color: var(--text-1); font-weight: 600; }
          .nav-ico { display: grid; place-items: center; color: inherit; flex-shrink: 0; }
          .nav-label { flex: 1; }
          .nav-count {
            display: none; align-items: center; justify-content: center; min-width: 18px; height: 18px;
            padding: 0 5px; border-radius: 999px; background: var(--waiting); color: #fff;
            font-size: 11px; font-weight: 600; line-height: 1;
          }

          .side-foot { margin-top: auto; padding: 10px 8px 2px; border-top: 1px solid var(--border); }
          .side-id { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
          .side-name { font-size: 12.5px; font-weight: 600; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          .side-host { font-size: 11px; color: var(--text-4); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

          /* —— Main —— */
          .main { flex: 1; min-width: 0; height: 100vh; display: flex; flex-direction: column; }
          .app-header {
            display: flex; align-items: center; justify-content: space-between; gap: 16px;
            padding: 14px 24px; border-bottom: 1px solid var(--border); background: var(--bg); flex-shrink: 0;
          }
          .app-header-titles { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
          .app-header-title { margin: 0; font-size: 19px; font-weight: 700; letter-spacing: -.02em; line-height: 1.2; }
          .app-header-sub { font-size: 12.5px; color: var(--text-3); }
          .app-header-actions { display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
          .relay-pill {
            display: inline-flex; align-items: center; gap: 7px; padding: 5px 11px;
            border: 1px solid var(--border); border-radius: 999px; background: var(--surface-1);
            font-size: 12.5px; color: var(--text-2); white-space: nowrap;
          }

          .view { flex: 1; min-height: 0; overflow-y: auto; padding: 20px 24px; }
          .page { display: none; }
          .page.active { display: flex; flex-direction: column; gap: 16px; }
          .page.fill { height: 100%; }
          .page.fill > .card { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
          .scroll-body { flex: 1; min-height: 0; overflow: auto; }
          .fill-body { flex: 1; min-height: 0; display: flex; padding: 14px 16px; }

          /* —— Card —— */
          .card {
            background: var(--surface-1); border: 1px solid var(--border);
            border-radius: var(--r-lg); box-shadow: var(--shadow-1);
          }
          .card-head {
            display: flex; align-items: center; justify-content: space-between; gap: 12px;
            padding: 13px 16px; border-bottom: 1px solid var(--border); flex-shrink: 0;
          }
          .card-title { display: flex; align-items: center; gap: 7px; margin: 0; font-size: 13.5px; font-weight: 600; color: var(--text-1); }
          .card-title .ico { display: inline-flex; color: var(--text-3); flex-shrink: 0; }
          .card-body { padding: 14px 16px; }

          /* —— Overview —— */
          .stat-row { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
          .stat-card {
            padding: 14px 16px 12px; background: var(--surface-1); border: 1px solid var(--border);
            border-radius: var(--r-lg); box-shadow: var(--shadow-1);
          }
          .stat-head { display: flex; align-items: center; gap: 7px; color: var(--text-3); font-size: 12.5px; font-weight: 500; }
          .stat-head .ico { display: inline-flex; color: var(--text-4); }
          .stat-value { margin-top: 8px; font-size: 26px; font-weight: 600; line-height: 1.1; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
          .stat-value.ok { color: var(--success); }
          .stat-value.muted { color: var(--text-3); }
          .stat-value .unit { font-size: 14px; font-weight: 500; color: var(--text-4); margin-left: 4px; }
          .stat-foot { margin-top: 6px; font-size: 11.5px; color: var(--text-4); min-height: 16px; }
          .ov-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: stretch; }
          .span2 { grid-column: 1 / -1; }

          .kv { display: grid; gap: 11px; }
          .kv-row { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 12px; align-items: start; font-size: 13px; }
          .kv-k { color: var(--text-4); }
          .kv-v { color: var(--text-2); overflow-wrap: anywhere; }
          .kv-v.mono { font-family: var(--font-mono); font-size: 12px; }

          /* —— Settings rows —— */
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
          .cap-row { display: flex; flex-direction: column; gap: 10px; }
          .cap-item { display: grid; grid-template-columns: 80px 130px 1fr; align-items: center; gap: 0 10px; font-size: 13px; color: var(--text-2); min-width: 0; }
          .cap-name { display: inline-flex; align-items: center; gap: 8px; }
          .cap-version { font-family: var(--font-mono); font-size: 11.5px; color: var(--text-3); }
          .cap-path { font-family: var(--font-mono); font-size: 11px; color: var(--text-4); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; min-width: 0; }
          .cap-path:hover { color: var(--running); text-decoration: underline; }
          .live-dot.fail { background: var(--failed); }

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
          .usage-empty { font-size: 12.5px; color: var(--text-4); }

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

          /* List items (projects) */
          .proj-list { max-height: 320px; overflow: auto; }
          .list-item {
            display: flex; align-items: center; justify-content: space-between; gap: 10px;
            padding: 10px 0; border-top: 1px solid var(--border);
          }
          .list-item:first-child { border-top: 0; }
          .li-main { min-width: 0; }
          .li-title { display: block; font-size: 13px; font-weight: 600; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          .li-sub { display: block; font-size: 11.5px; color: var(--text-4); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

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
            padding: 10px 12px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;
            color: var(--text-2); flex: 1; min-height: 0;
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

          #page-tasks .card-body { padding-top: 6px; padding-bottom: 6px; }

          /* Tasks filter + pager */
          .tasks-toolbar { display: flex; align-items: center; gap: 8px; }
          .tasks-filter-bar { display: flex; gap: 3px; }
          .filter-btn { display: inline-flex; align-items: center; height: 26px; padding: 0 10px; border: 1px solid var(--border); border-radius: var(--r-sm); background: transparent; color: var(--text-3); font-size: 12px; cursor: pointer; transition: background .12s, color .12s, border-color .12s; }
          .filter-btn:hover { background: var(--surface-2); color: var(--text-1); }
          .filter-btn.active { background: var(--text-1); border-color: var(--text-1); color: var(--surface-1); }
          .tasks-pager { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 10px 16px; border-top: 1px solid var(--border); flex-shrink: 0; }
          .tasks-pager-info { font-size: 12px; color: var(--text-4); font-variant-numeric: tabular-nums; }

          /* Conversations panel (read-only) */
          .conv-item { border-top: 1px solid var(--border); }
          .conv-item:first-child { border-top: 0; }
          .conv-row { display: flex; align-items: center; gap: 10px; padding: 9px 0; cursor: pointer; }
          .conv-row:hover { background: var(--surface-3); }
          .conv-row .li-main { flex: 1; }
          .conv-live { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 600; color: var(--success); white-space: nowrap; }
          .conv-live::before { content: ""; width: 6px; height: 6px; border-radius: 999px; background: currentColor; animation: cc-breathe 1.4s ease-in-out infinite; }
          .conv-layout { display: flex; gap: 16px; flex: 1 1 auto; min-height: 0; }
          .conv-layout > .card { min-height: 0; display: flex; flex-direction: column; }
          .conv-list-card { flex: 0 0 240px; min-width: 0; }
          .conv-list-card .scroll-body { overflow-x: hidden; }
          .conv-detail-card { flex: 1; min-width: 0; }
          .conv-row.conv-active { background: var(--surface-3); }
          /* —— transcript 富展示（对齐 Console apps/console/app/ui/transcript.tsx）—— */
          .tx { display: flex; flex-direction: column; gap: 10px; padding: 4px 2px; }
          .tx-truncated { align-self: center; font-size: 11px; color: var(--text-3); background: var(--surface-3); border: 1px solid var(--border); border-radius: 999px; padding: 2px 10px; margin-bottom: 2px; }
          .tx-row { display: flex; max-width: 100%; }
          .tx-row.user { justify-content: flex-end; }
          .tx-row.asst { justify-content: flex-start; }
          .tx-msg { font-size: 12.5px; line-height: 1.6; min-width: 0; }
          .tx-msg.user { max-width: 80%; background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; border-bottom-right-radius: 3px; padding: 7px 11px; }
          .tx-msg.asst { width: 100%; max-width: 100%; }
          .tx-text { word-break: break-word; white-space: pre-wrap; }
          .tx-text pre, .tx-text ul, .tx-text ol, .tx-text li, .tx-text h1, .tx-text h2, .tx-text h3, .tx-text blockquote, .tx-text table, .tx-text th, .tx-text td { white-space: normal; }
          .tx-text > :first-child { margin-top: 0; }
          .tx-text > :last-child { margin-bottom: 0; }
          .tx-text p { margin: 0.4em 0; }
          .tx-text h1,.tx-text h2,.tx-text h3 { margin: 0.6em 0 0.3em; font-size: 1.05em; font-weight: 600; }
          .tx-text ul,.tx-text ol { margin: 0.4em 0; padding-left: 1.3em; }
          .tx-text li { margin: 0.15em 0; }
          .tx-text code { font-family: monospace; font-size: 11px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 3px; padding: 1px 4px; }
          .tx-text pre { background: var(--surface-2); border: 1px solid var(--border); border-radius: 4px; padding: 7px 9px; margin: 0.35em 0; overflow-x: auto; }
          .tx-text pre code { background: none; border: none; padding: 0; }
          .tx-text blockquote { margin: 0.4em 0; padding-left: 9px; border-left: 2px solid var(--border-strong); color: var(--text-2); }
          .tx-text table { border-collapse: collapse; margin: 0.4em 0; font-size: 12px; }
          .tx-text th, .tx-text td { border: 1px solid var(--border); padding: 3px 8px; }
          .tx-text th { background: var(--surface-2); font-weight: 600; }
          .tx-fold-head { display: flex; align-items: center; gap: 5px; width: 100%; padding: 3px 1px; background: none; border: none; cursor: pointer; color: var(--text-2); font-size: 12px; text-align: left; }
          .tx-fold-head:hover { color: var(--text-1); }
          .tx-caret { flex-shrink: 0; font-style: normal; display: inline-block; transition: transform 0.12s; color: var(--text-3); font-size: 10px; }
          .tx-caret.open { transform: rotate(90deg); }
          .tx-fold-body { margin: 1px 0 4px 14px; font-family: monospace; font-size: 11.5px; white-space: pre-wrap; word-break: break-word; color: var(--text-2); }
          .tx-tool { margin: 1px 0; }
          .tx-tool-ico { flex-shrink: 0; color: var(--text-3); font-size: 11px; }
          .tx-tool-name { font-weight: 600; color: var(--text-1); }
          .tx-tool-sum { color: var(--text-3); font-family: monospace; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; }
          .tx-tool-badge { margin-left: auto; flex-shrink: 0; color: var(--failed); font-size: 11px; }
          .tx-tool[data-error="1"] .tx-tool-name { color: var(--failed); }
          .tx-cmd,.tx-json { margin: 0 0 4px; padding: 6px 9px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 4px; font-family: monospace; font-size: 11.5px; white-space: pre-wrap; word-break: break-word; overflow-x: auto; }
          .tx-diff { margin: 0 0 4px; padding: 4px 0; background: var(--surface-2); border: 1px solid var(--border); border-radius: 4px; font-family: monospace; font-size: 11.5px; overflow-x: auto; }
          .tx-diff-del,.tx-diff-add { padding: 0 9px; white-space: pre-wrap; word-break: break-word; }
          .tx-diff-del { background: rgba(220,38,38,.08); color: #b91c1c; }
          .tx-diff-add { background: rgba(22,163,74,.1); color: #15803d; }
          .tx-result { margin-left: 14px; margin-bottom: 3px; border-left: 2px solid var(--border-strong); padding-left: 8px; }
          .tx-result.err { border-left-color: var(--failed); }
          .tx-result-head { font-size: 11px; color: var(--text-3); margin-bottom: 2px; }
          .tx-result.err .tx-result-head { color: var(--failed); }
          .tx-result-body { margin: 0; font-family: monospace; font-size: 11.5px; white-space: pre-wrap; word-break: break-word; color: var(--text-2); max-height: 240px; overflow: auto; }
          .tx-think-label { color: var(--text-3); }
          /* 「思考中」指示：✦ 中性灰脉冲 + 「思考中…」shimmer 文字（与 Web 控制台 .tx-thinking 同款）。 */
          .tx-thinking { padding: 4px 2px; display: inline-flex; align-items: center; gap: 6px; }
          .tx-thinking-ico { flex-shrink: 0; color: var(--text-3); animation: cc-spark 2.2s ease-in-out infinite; }
          .tx-thinking-label { font-size: 12.5px; font-weight: 500; background: linear-gradient(90deg, var(--text-4) 0%, var(--text-4) 40%, var(--text-1) 50%, var(--text-4) 60%, var(--text-4) 100%); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; color: transparent; animation: cc-shimmer 1.9s linear infinite; }
          @keyframes cc-shimmer { 0% { background-position: 150% 0; } 100% { background-position: -50% 0; } }
          @keyframes cc-spark { 0%,100% { opacity: .55; transform: scale(.9) rotate(0deg); } 50% { opacity: 1; transform: scale(1.12) rotate(18deg); } }

          .live-dot { display: inline-block; width: 7px; height: 7px; border-radius: 999px; background: var(--success); position: relative; }
          .live-dot.pulse { animation: cc-breathe 1.8s ease-in-out infinite; }
          .live-dot.pulse::after { content: ""; position: absolute; inset: -3px; border-radius: 999px; background: var(--success); opacity: .18; animation: cc-ring 1.8s ease-in-out infinite; }
          @keyframes cc-breathe { 0%,100% { opacity: 1; } 50% { opacity: .5; } }
          @keyframes cc-spin { to { transform: rotate(360deg); } }
          .tasks-loading { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 40px 16px; color: var(--text-4); font-size: 13px; }
          .tasks-loading-spin { width: 18px; height: 18px; border: 2px solid var(--border); border-top-color: var(--running); border-radius: 50%; animation: cc-spin 0.7s linear infinite; flex-shrink: 0; }
          .tasks-empty { display: flex; align-items: center; justify-content: center; padding: 40px 16px; color: var(--text-4); font-size: 13px; }
          @keyframes cc-ring { 0% { transform: scale(.7); opacity: .25; } 70% { transform: scale(1.7); opacity: 0; } 100% { opacity: 0; } }
        </style>
      </head>
      <body>
        <div class="app">
          <aside class="sidebar">
            <div class="brand">
              <span class="brand-mark">CC</span>
              <div class="brand-tt">
                <span class="brand-title">ClaudeCenter</span>
                <span class="brand-sub">Worker 桌面端</span>
              </div>
            </div>
            <nav class="nav">
              <button class="nav-item active" data-nav="overview" type="button">
                <span class="nav-ico"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg></span>
                <span class="nav-label">总览</span>
              </button>
              <button class="nav-item" data-nav="tasks" type="button">
                <span class="nav-ico"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="6" r="1.3"/><circle cx="4" cy="12" r="1.3"/><circle cx="4" cy="18" r="1.3"/><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/></svg></span>
                <span class="nav-label">任务</span>
                <span class="nav-count" id="navTasksCount"></span>
              </button>
              <button class="nav-item" data-nav="conversations" type="button">
                <span class="nav-ico"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-4.2A8 8 0 1 1 21 12z"/></svg></span>
                <span class="nav-label">对话</span>
                <span class="nav-count" id="navConvCount" style="background:var(--success)"></span>
              </button>
              <button class="nav-item" data-nav="projects" type="button">
                <span class="nav-ico"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7a1.5 1.5 0 0 1 1.5-1.5h3.2l1.8 1.8h8A1.5 1.5 0 0 1 20 8.8V17a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17z"/></svg></span>
                <span class="nav-label">项目</span>
              </button>
              <button class="nav-item" data-nav="settings" type="button">
                <span class="nav-ico"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="8" x2="20" y2="8"/><line x1="4" y1="16" x2="20" y2="16"/><circle cx="9" cy="8" r="2.4"/><circle cx="15" cy="16" r="2.4"/></svg></span>
                <span class="nav-label">设置</span>
              </button>
              <button class="nav-item" data-nav="logs" type="button">
                <span class="nav-ico"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3"/><line x1="13" y1="15" x2="17" y2="15"/></svg></span>
                <span class="nav-label">日志</span>
              </button>
            </nav>
            <div class="side-foot">
              <div class="side-id">
                <span class="side-name" id="sideName">worker</span>
                <span class="side-host" id="sideHost">—</span>
              </div>
            </div>
          </aside>

          <main class="main">
            <header class="app-header">
              <div class="app-header-titles">
                <h1 class="app-header-title" id="pageTitle">总览</h1>
                <span class="app-header-sub" id="pageSub">本机运行状态、能力与套餐用量</span>
              </div>
              <div class="app-header-actions">
                <span class="relay-pill"><span class="live-dot" id="dbDot" title="数据库连接状态"></span><span id="dbStat">数据库…</span></span>
                <span class="relay-pill"><span class="live-dot" id="relayDot" title="SSE 连接状态"></span><span id="relay">连接中…</span></span>
                <span class="badge" id="state" data-tone="cancelled"><span class="glyph">·</span>—</span>
              </div>
            </header>

            <div class="view">
              <!-- 总览 -->
              <section class="page active" id="page-overview">
                <div class="stat-row">
                  <div class="stat-card">
                    <div class="stat-head"><span class="ico"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v9"/><path d="M6.6 7a8 8 0 1 0 10.8 0"/></svg></span>工作状态</div>
                    <div class="stat-value muted" id="statWorking">—</div>
                    <div class="stat-foot" id="statWorkingFoot"></div>
                  </div>
                  <div class="stat-card">
                    <div class="stat-head"><span class="ico"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h3.5l2.5 7 4-14 2.5 7H21"/></svg></span>在途任务</div>
                    <div class="stat-value" id="statActive">—</div>
                    <div class="stat-foot" id="statActiveFoot"></div>
                  </div>
                  <div class="stat-card">
                    <div class="stat-head"><span class="ico"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 2.5v5.5c0 4-3 7-7 8-4-1-7-4-7-8V5.5z"/><path d="M9 12l2 2 4-4"/></svg></span>能力就绪</div>
                    <div class="stat-value" id="statCaps">—</div>
                    <div class="stat-foot" id="statCapsFoot"></div>
                  </div>
                  <div class="stat-card">
                    <div class="stat-head"><span class="ico"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13a10 10 0 0 1 14 0"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><circle cx="12" cy="20" r="1"/></svg></span>实时通道</div>
                    <div class="stat-value" id="statRelay">—</div>
                    <div class="stat-foot" id="statRelayFoot"></div>
                  </div>
                </div>

                <div class="ov-grid">
                  <section class="card">
                    <div class="card-head"><h2 class="card-title"><span class="ico"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="2"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="13" y2="16"/></svg></span>本机信息</h2></div>
                    <div class="card-body">
                      <div class="kv">
                        <div class="kv-row"><span class="kv-k">名称</span><span class="kv-v"><span id="ovName">—</span><span id="ovHost" class="kv-v mono" style="margin-left:6px;color:var(--text-4)">—</span></span></div>
                        <div class="kv-row"><span class="kv-k">系统</span><span class="kv-v" id="ovOs">—</span></div>
                        <div class="kv-row"><span class="kv-k">claude</span><span class="kv-v mono" id="ovClaude">—</span></div>
                        <div class="kv-row"><span class="kv-k">套餐</span><span class="kv-v" id="ovSub">—</span></div>
                        <div class="kv-row"><span class="kv-k">终端</span><span class="kv-v mono" id="ovTerminal">—</span></div>
                      </div>
                    </div>
                  </section>

                  <section class="card">
                    <div class="card-head"><h2 class="card-title"><span class="ico"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 2.5v5.5c0 4-3 7-7 8-4-1-7-4-7-8V5.5z"/><path d="M9 12l2 2 4-4"/></svg></span>能力自检</h2></div>
                    <div class="card-body"><div id="caps" class="cap-row">—</div></div>
                  </section>

                  <section class="card span2" id="usageSection" style="display:none">
                    <div class="card-head"><h2 class="card-title"><span class="ico"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 16a7 7 0 1 1 14 0"/><path d="M12 16l3.5-3.5"/></svg></span>套餐用量</h2></div>
                    <div class="card-body" id="usage"></div>
                  </section>
                </div>
              </section>

              <!-- 任务 -->
              <section class="page fill" id="page-tasks">
                <section class="card">
                  <div class="card-head">
                    <h2 class="card-title"><span class="ico"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h3.5l2.5 7 4-14 2.5 7H21"/></svg></span>本机任务</h2>
                    <div class="tasks-toolbar">
                      <span class="tasks-filter-bar">
                        <button class="filter-btn active" data-tasks-filter="all" type="button">全部</button>
                        <button class="filter-btn" data-tasks-filter="needs" type="button">待回复</button>
                        <button class="filter-btn" data-tasks-filter="working" type="button">进行中</button>
                        <button class="filter-btn" data-tasks-filter="done" type="button">已完成</button>
                      </span>
                      <button id="tasksRefresh" class="btn btn-sm" type="button">刷新</button>
                    </div>
                  </div>
                  <div class="card-body scroll-body"><div id="tasks"><span class="empty">加载中…</span></div></div>
                  <div class="tasks-pager" id="tasksPager" style="display:none">
                    <button id="tasksPrev" class="btn btn-sm" type="button">‹ 上一页</button>
                    <span id="tasksPagerInfo" class="tasks-pager-info"></span>
                    <button id="tasksNext" class="btn btn-sm" type="button">下一页 ›</button>
                  </div>
                </section>
              </section>

              <!-- 对话 -->
              <section class="page fill" id="page-conversations">
                <div class="conv-layout">
                  <section class="card conv-list-card">
                    <div class="card-head">
                      <h2 class="card-title"><span class="ico"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-4.2A8 8 0 1 1 21 12z"/></svg></span>实时对话</h2>
                      <button id="convRefresh" class="btn btn-sm" type="button">刷新</button>
                    </div>
                    <div class="card-body scroll-body"><div id="conversations"><span class="empty">加载中…</span></div></div>
                  </section>
                  <section class="card conv-detail-card" id="conv-detail-card">
                    <div class="card-head">
                      <h2 class="card-title" id="conv-detail-title">对话详情</h2>
                    </div>
                    <div class="card-body scroll-body" id="conv-detail-body"><div id="conv-detail-panel"><span class="empty">选择左侧对话查看内容</span></div></div>
                  </section>
                </div>
              </section>

              <!-- 项目 -->
              <section class="page" id="page-projects">
                <section class="card">
                  <div class="card-head"><h2 class="card-title"><span class="ico"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7a1.5 1.5 0 0 1 1.5-1.5h3.2l1.8 1.8h8A1.5 1.5 0 0 1 20 8.8V17a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17z"/></svg></span>关联项目</h2></div>
                  <div class="card-body">
                    <div id="projects" class="proj-list"><span class="empty">加载中…</span></div>
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
              </section>

              <!-- 设置 -->
              <section class="page" id="page-settings">
                <section class="card">
                  <div class="card-head">
                    <h2 class="card-title"><span class="ico"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="8" x2="20" y2="8"/><line x1="4" y1="16" x2="20" y2="16"/><circle cx="9" cy="8" r="2.4"/><circle cx="15" cy="16" r="2.4"/></svg></span>状态与设置</h2>
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
                  <div class="card-head"><h2 class="card-title"><span class="ico"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.66 3.13 3 7 3s7-1.34 7-3V6"/><path d="M5 12v6c0 1.66 3.13 3 7 3s7-1.34 7-3v-6"/></svg></span>数据库连接</h2></div>
                  <div class="card-body">
                    <div class="term-form">
                      <span class="term-label">PostgreSQL 连接串（与 Console 共享同一库，向管理员索取）</span>
                      <input id="databaseUrl" class="path-input" placeholder="postgresql://user:password@host:5432/claude_center" />
                      <button id="saveDatabase" class="btn btn-sm btn-primary term-save" type="button">保存并连接</button>
                      <span class="term-hint" id="databaseHint">保存后即时连接并重新注册，无需重启；连通状态见顶栏。覆盖环境变量 DATABASE_URL，持久化到 ~/.claude-center/worker.json。</span>
                    </div>
                  </div>
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

                <section class="card">
                  <div class="card-head"><h2 class="card-title"><span class="ico"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13a10 10 0 0 1 14 0"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><circle cx="12" cy="20" r="1"/></svg></span>SSE 中转服务</h2></div>
                  <div class="card-body">
                    <div class="term-form">
                      <span class="term-label">中转服务地址（留空 = 禁用中转、纯数据库轮询，功能不降级）</span>
                      <input id="relayUrl" class="path-input" placeholder="如 https://relay.your-org.com（留空则禁用）" />
                      <span class="term-label">发布 token（CLAUDE_CENTER_RELAY_PUBLISH_TOKEN，向 Console 管理员索取）</span>
                      <input id="relayPublishToken" class="path-input" placeholder="留空 = 不向中转发布事件" />
                      <span class="term-label">订阅 token（CLAUDE_CENTER_RELAY_WORKER_TOKEN，向 Console 管理员索取）</span>
                      <input id="relayWorkerToken" class="path-input" placeholder="留空 = 不订阅中转推送" />
                      <button id="saveRelay" class="btn btn-sm btn-primary term-save" type="button">保存</button>
                      <span class="term-hint" id="relayHint">保存后即时生效，无需重启；连通状态见顶栏。</span>
                    </div>
                  </div>
                </section>
              </section>

              <!-- 日志 -->
              <section class="page fill" id="page-logs">
                <section class="card">
                  <div class="card-head">
                    <h2 class="card-title"><span class="ico"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8l3.5 3L5 14"/><line x1="11" y1="15" x2="18" y2="15"/></svg></span>运行日志</h2>
                    <button id="logsClear" class="btn btn-sm" type="button">清理</button>
                  </div>
                  <div class="card-body fill-body"><div id="logs" class="logs"></div></div>
                </section>
              </section>
            </div>
          </main>
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
            const dotClass = "live-dot" + (ok ? " pulse" : " fail");
            const version = ok && cap.version ? cap.version : (ok ? "—" : "未检出");
            const capPath = cap && cap.path ? cap.path : "";
            const pathEl = capPath
              ? '<span class="cap-path" title="' + esc(capPath) + '" data-cap-path="' + esc(capPath) + '">' + esc(capPath) + '</span>'
              : '<span></span>';
            return '<div class="cap-item">' +
              '<span class="cap-name"><span class="' + dotClass + '"></span>' + esc(name) + '</span>' +
              '<span class="cap-version">' + esc(version) + '</span>' +
              pathEl +
              '</div>';
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

          // —— 菜单切换 ——
          var currentPage = "overview";
          var PAGE_META = {
            overview:      { t: "总览", s: "本机运行状态、能力与套餐用量 · 每 15s 刷新" },
            tasks:         { t: "任务", s: "本机认领的任务与执行进度" },
            conversations: { t: "对话", s: "本机承接的实时对话" },
            projects:      { t: "项目", s: "本地路径与云端项目的关联" },
            settings:      { t: "设置", s: "工作状态、并发与运行终端" },
            logs:          { t: "日志", s: "本机运行日志（仅内存，重启清空）" }
          };
          var PAGE_LIST = ["overview", "tasks", "conversations", "projects", "settings", "logs"];
          function showPage(name) {
            currentPage = name;
            PAGE_LIST.forEach(function (p) {
              var pg = $("page-" + p); if (pg) pg.classList.toggle("active", p === name);
              var nv = document.querySelector('[data-nav="' + p + '"]'); if (nv) nv.classList.toggle("active", p === name);
            });
            var m = PAGE_META[name] || { t: "", s: "" };
            $("pageTitle").textContent = m.t;
            $("pageSub").textContent = m.s;
          }
          function setNavCount(id, n) {
            var el = $(id); if (!el) return;
            el.textContent = n > 0 ? n : "";
            el.style.display = n > 0 ? "inline-flex" : "none";
          }

          // —— 任务面板（Agent-View 式：仅本 worker，分组 + peek + 回复/续接重试）——
          // 状态机简化:accepted/rejected 已移除；Worker 终态只有 success/failed/waiting,
          // merged 由 Console 30s 轮询检测 PR 合并自动翻;桌面端不再提供「验收 / 打回」入口。
          var TASK_STATUS_META = {
            waiting:   { group: "needs",   label: "待回复",   tone: "waiting" },
            success:   { group: "done",    label: "已完成",   tone: "success" },
            claimed:   { group: "working", label: "已认领",   tone: "running" },
            running:   { group: "working", label: "执行中",   tone: "running" },
            merged:    { group: "done",    label: "已合并",   tone: "merged" },
            failed:    { group: "done",    label: "失败",     tone: "failed" },
            cancelled: { group: "done",    label: "已取消",   tone: "cancelled" }
          };
          var TASK_GROUPS = [
            { key: "needs",   title: "需输入" },
            { key: "working", title: "进行中" },
            { key: "done",    title: "已完成" }
          ];
          var expandedTaskId = null;
          var tasksCache = [];
          var tasksTotal = 0;
          var tasksFilter = "all";
          var tasksPage = 1;
          var tasksPageSize = 10;

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
          // renderTasks: 渲染当前 tasksCache（已由服务端分好页），平铺不分组。
          // force=true 时无视指纹强制重建（手动刷新/翻页/筛选先填了 loading 占位，必须重建覆盖）。
          var tasksFp = '';
          function renderTasks(force) {
            document.querySelectorAll("[data-tasks-filter]").forEach(function(btn) {
              btn.classList.toggle("active", btn.getAttribute("data-tasks-filter") === tasksFilter);
            });

            if (!tasksCache.length) {
              $("tasks").innerHTML = '<div class="tasks-empty">' + (tasksTotal === 0 ? "本机暂无任务" : "当前筛选无任务") + '</div>';
              $("tasksPager").style.display = "none";
              tasksFp = '';
              return;
            }

            // M2：指纹跳过——数据/页/筛选/展开项都没变就不重建整页 DOM，避免每 4s 自动刷新的无谓 churn。
            var fp = tasksFilter + '|' + tasksPage + '|' + tasksTotal + '|' + (expandedTaskId || '') + '|' +
              tasksCache.map(function(t){ return t.id + t.status + t.updated_at + (t.merge_status||'') + (t.pr_url||''); }).join(',');
            if (!force && fp === tasksFp) return;
            tasksFp = fp;

            // 平铺渲染，先存已展开详情防闪烁
            const keep = expandedTaskId ? (document.getElementById("detail-" + expandedTaskId) || {}).innerHTML : null;
            $("tasks").innerHTML = tasksCache.map(taskRow).join("");
            if (expandedTaskId) {
              const box = document.getElementById("detail-" + expandedTaskId);
              if (box && keep != null) box.innerHTML = keep;
              loadDetail(expandedTaskId);
            }

            var totalPages = Math.ceil(tasksTotal / tasksPageSize) || 1;
            var showPager = totalPages > 1;
            $("tasksPager").style.display = showPager ? "flex" : "none";
            if (showPager) {
              $("tasksPagerInfo").textContent = "第 " + tasksPage + " / " + totalPages + " 页（共 " + tasksTotal + " 条）";
              $("tasksPrev").disabled = tasksPage <= 1;
              $("tasksNext").disabled = tasksPage >= totalPages;
            }
          }
          // showLoading=true 时出翻页/筛选动画；自动刷新不传（false），避免频繁闪烁。
          async function reloadTasks(showLoading) {
            if (showLoading) {
              $("tasks").innerHTML = '<div class="tasks-loading"><span class="tasks-loading-spin"></span>加载中…</div>';
              $("tasksPager").style.display = "none";
            }
            let result = { rows: [], total: 0, waitingCount: 0 };
            try {
              result = await window.workerApi.listMyTasks({
                page: tasksPage,
                pageSize: tasksPageSize,
                statusGroup: tasksFilter === "all" ? null : tasksFilter
              });
            } catch (e) {
              if (showLoading) $("tasks").innerHTML = '<div class="tasks-empty">加载失败，请刷新</div>';
              return;
            }
            tasksCache = result.rows || [];
            tasksTotal = result.total || 0;
            setNavCount("navTasksCount", result.waitingCount || 0);
            renderTasks(showLoading);
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
            if (t && (t.status === "failed" || t.status === "cancelled")) {
              html += '<div class="detail-act"><button class="btn btn-sm btn-primary" data-task-action="retry" data-task-id="' + esc(taskId) + '">续接重试</button></div>';
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
            if (action === "retry") {
              el.disabled = true; const ok = await window.workerApi.retryMyTask(id);
              if (!ok) alert("任务已不在失败/取消状态"); expandedTaskId = null; await reloadTasks(); return;
            }
          }

          // —— transcript 渲染（逻辑对齐 Console apps/console/app/ui/transcript.tsx）——
          var txUid = 0;
          function txId() { return 'tx' + (++txUid); }
          function txToggle(uid) {
            var body = document.getElementById(uid);
            var caret = document.getElementById(uid + '-c');
            if (!body) return;
            var open = body.style.display !== 'none';
            body.style.display = open ? 'none' : 'block';
            if (caret) caret.classList.toggle('open', !open);
          }
          var TX_TRUNC = 4000;
          function txClip(t) { return t.length > TX_TRUNC ? t.slice(0, TX_TRUNC) + '\\n… (已截断 ' + (t.length - TX_TRUNC) + ' 字)' : t; }
          function txStr(v) { return typeof v === 'string' ? v : ''; }
          function txStringify(input) {
            if (input == null) return '';
            if (typeof input === 'string') return input;
            try { return JSON.stringify(input, null, 2); } catch (e) { return String(input); }
          }
          function txToolResultText(content) {
            if (typeof content === 'string') return content;
            if (Array.isArray(content)) return content.map(function(b) { return b && typeof b.text === 'string' ? b.text : ''; }).filter(Boolean).join('\\n');
            return content == null ? '' : txStringify(content);
          }
          function txToolSummary(name, input) {
            var o = (input && typeof input === 'object') ? input : {};
            if (name === 'Bash' || name === 'PowerShell') return (txStr(o.command).split('\\n')[0] || '').slice(0, 140);
            if (name === 'Read' || name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') {
              var p = txStr(o.file_path) || txStr(o.notebook_path);
              if (!p) return '';
              var parts = p.split(/[/\\\\]/).filter(Boolean);
              return parts.length <= 2 ? p : ('…/' + parts.slice(-2).join('/'));
            }
            if (name === 'Grep' || name === 'Glob') return txStr(o.pattern);
            if (name === 'Task') return txStr(o.description);
            return '';
          }
          function txHasMd(text) { return /[\x60#*_~]|\\[[^\\]]+\\]\\(|^\\s*[->]|^\\s*\\d+\\.\\s|\\n\\n|^\\s*\\|/m.test(text); }
          function txMdToHtml(text) {
            var result = '', rx = /\x60\x60\x60([^\\n]*)\\n([\\s\\S]*?)\x60\x60\x60/g, last = 0, m;
            while ((m = rx.exec(text)) !== null) {
              result += txInlineMd(text.slice(last, m.index));
              result += '<pre class="tx-cmd"><code>' + esc(m[2].replace(/\\n$/, '')) + '</code></pre>';
              last = m.index + m[0].length;
            }
            return result + txInlineMd(text.slice(last));
          }
          function txInlineMd(text) {
            if (!text) return '';
            var codes = [], h = esc(text);
            h = h.replace(/\x60([^\x60\\n]+)\x60/g, function(_, c) { var id = '\\x00c' + codes.length + '\\x00'; codes.push('<code>' + c + '</code>'); return id; });
            h = h.replace(/\\*\\*\\*([^\\n*]+?)\\*\\*\\*/g, '<strong><em>$1</em></strong>');
            h = h.replace(/\\*\\*([^\\n*]+?)\\*\\*/g, '<strong>$1</strong>');
            h = h.replace(/^### ([^\\n]+)$/gm, '<h3>$1</h3>');
            h = h.replace(/^## ([^\\n]+)$/gm, '<h2>$1</h2>');
            h = h.replace(/^# ([^\\n]+)$/gm, '<h1>$1</h1>');
            h = h.replace(/((?:^[ ]*\\|[^\\n]+\\|[ ]*\\n)(?:^[ ]*\\|[ :|-]+\\|[ ]*\\n)(?:^[ ]*\\|[^\\n]+\\|[ ]*\\n?)*)/gm, function(tbl) {
              var rows = tbl.trim().split('\\n').filter(function(r) { return r.trim(); });
              if (rows.length < 2) return tbl;
              var parseRow = function(row) { return row.split('|').slice(1, -1).map(function(c) { return c.trim(); }); };
              var headers = parseRow(rows[0]);
              var aligns = parseRow(rows[1]).map(function(c) {
                if (/^:-+:$/.test(c)) return 'center';
                if (/^-+:$/.test(c)) return 'right';
                if (/^:-+$/.test(c)) return 'left';
                return '';
              });
              var alignAttr = function(i) { return aligns[i] ? ' style="text-align:' + aligns[i] + '"' : ''; };
              var thead = '<thead><tr>' + headers.map(function(hd, i) { return '<th' + alignAttr(i) + '>' + hd + '</th>'; }).join('') + '</tr></thead>';
              var tbody = rows.slice(2).map(function(row) { return '<tr>' + parseRow(row).map(function(c, i) { return '<td' + alignAttr(i) + '>' + c + '</td>'; }).join('') + '</tr>'; }).join('');
              return '<table class="tx-table">' + thead + (tbody ? '<tbody>' + tbody + '</tbody>' : '') + '</table>';
            });
            h = h.replace(/((?:^[ ]*[-*+] [^\\n]+\\n?)+)/gm, function(m2) { return '<ul>' + m2.replace(/^[ ]*[-*+] ([^\\n]+)\\n?/gm, '<li>$1</li>') + '</ul>'; });
            h = h.replace(/((?:^[ ]*\\d+\\. [^\\n]+\\n?)+)/gm, function(m2) { return '<ol>' + m2.replace(/^[ ]*\\d+\\. ([^\\n]+)\\n?/gm, '<li>$1</li>') + '</ol>'; });
            return h.replace(/\\x00c(\\d+)\\x00/g, function(_, i) { return codes[parseInt(i)] || ''; });
          }
          function txRenderDiff(oldText, newText) {
            var rows = (oldText ? oldText.split('\\n').map(function(l) { return '<div class="tx-diff-del">- ' + esc(l) + '</div>'; }).join('') : '') +
                       (newText ? newText.split('\\n').map(function(l) { return '<div class="tx-diff-add">+ ' + esc(l) + '</div>'; }).join('') : '');
            return '<pre class="tx-diff">' + rows + '</pre>';
          }
          function txRenderToolInput(name, input) {
            var o = (input && typeof input === 'object') ? input : {};
            if (name === 'Edit' && typeof o.old_string === 'string' && typeof o.new_string === 'string') return txRenderDiff(o.old_string, o.new_string);
            if (name === 'Write' && typeof o.content === 'string') return txRenderDiff('', o.content);
            if (name === 'MultiEdit' && Array.isArray(o.edits)) return o.edits.map(function(e) { return txRenderDiff(txStr(e.old_string), txStr(e.new_string)); }).join('');
            if ((name === 'Bash' || name === 'PowerShell') && typeof o.command === 'string') return '<pre class="tx-cmd">' + esc(txClip(o.command)) + '</pre>';
            var s = txStringify(input);
            return s ? '<pre class="tx-json">' + esc(txClip(s)) + '</pre>' : '';
          }
          function txRenderBlock(block, results) {
            if (block.kind === 'text') {
              var content = txHasMd(block.text) ? txMdToHtml(block.text) : '<span style="white-space:pre-wrap">' + esc(block.text) + '</span>';
              return '<div class="tx-text">' + content + '</div>';
            }
            if (block.kind === 'thinking') {
              var uid = txId();
              return '<div class="tx-tool"><button class="tx-fold-head" onclick="txToggle(\\'' + uid + '\\')">' +
                '<span class="tx-caret" id="' + uid + '-c">›</span><span class="tx-think-label">💭 思考</span>' +
                '</button><pre class="tx-fold-body" id="' + uid + '" style="display:none">' + esc(txClip(block.text)) + '</pre></div>';
            }
            if (block.kind === 'tool_use') {
              var res = block.id ? results[block.id] : undefined;
              var summary = txToolSummary(block.name, block.input);
              var hasErr = !!(res && res.isError);
              var uid2 = txId();
              return '<div class="tx-tool"' + (hasErr ? ' data-error="1"' : '') + '>' +
                '<button class="tx-fold-head" onclick="txToggle(\\'' + uid2 + '\\')">' +
                '<span class="tx-caret" id="' + uid2 + '-c">›</span><span class="tx-tool-ico">⚙</span>' +
                '<span class="tx-tool-name">' + esc(block.name) + '</span>' +
                (summary ? '<span class="tx-tool-sum">' + esc(summary) + '</span>' : '') +
                (hasErr ? '<span class="tx-tool-badge">错误</span>' : '') +
                '</button><div id="' + uid2 + '" style="display:none">' +
                txRenderToolInput(block.name, block.input) +
                (res ? '<div class="tx-result' + (res.isError ? ' err' : '') + '">' +
                  '<div class="tx-result-head">' + (res.isError ? '⚠ 工具返回' : '↳ 工具返回') + '</div>' +
                  (res.text ? '<pre class="tx-result-body">' + esc(txClip(res.text)) + '</pre>' : '') +
                  '</div>' : '') + '</div></div>';
            }
            return '';
          }
          function parseTranscript(jsonl) {
            var items = [], lines = jsonl.split(/\\r?\\n/);
            for (var i = 0; i < lines.length; i++) {
              var line = lines[i].trim();
              if (!line) continue;
              var obj; try { obj = JSON.parse(line); } catch (e) { continue; }
              if ((obj.type !== 'user' && obj.type !== 'assistant') || !obj.message) continue;
              var content = obj.message.content;
              var raw = typeof content === 'string' ? [{type:'text',text:content}] : Array.isArray(content) ? content : [];
              var blocks = [];
              for (var j = 0; j < raw.length; j++) {
                var b = raw[j];
                if (!b || typeof b !== 'object') continue;
                if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) blocks.push({kind:'text', text:b.text});
                else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) blocks.push({kind:'thinking', text:b.thinking});
                else if (b.type === 'tool_use') blocks.push({kind:'tool_use', id:txStr(b.id), name:txStr(b.name)||'tool', input:b.input});
                else if (b.type === 'tool_result') blocks.push({kind:'tool_result', toolUseId:typeof b.tool_use_id==='string'?b.tool_use_id:null, text:txToolResultText(b.content), isError:!!b.is_error});
              }
              if (blocks.length) items.push({role:obj.type, blocks:blocks});
            }
            return items;
          }
          var TX_RENDER_CAP = 120;
          function renderTranscriptHtml(items) {
            var results = {};
            for (var i = 0; i < items.length; i++) {
              for (var j = 0; j < items[i].blocks.length; j++) {
                var b = items[i].blocks[j];
                if (b.kind === 'tool_result' && b.toolUseId) results[b.toolUseId] = {text:b.text, isError:b.isError};
              }
            }
            // H1：只渲染最近 TX_RENDER_CAP 条，封顶 DOM 规模——长对话(571KB+)整棵重建会卡死渲染进程。
            // tool_result 配对表仍从全量 items 建（上面），保证被渲染轮里的工具返回能正确配上。完整记录见 Web 控制台。
            var startIdx = items.length > TX_RENDER_CAP ? items.length - TX_RENDER_CAP : 0;
            var html = '<div class="tx">';
            if (startIdx > 0) html += '<div class="tx-truncated">仅显示最近 ' + TX_RENDER_CAP + ' 条消息（完整记录见 Web 控制台）</div>';
            for (var i = startIdx; i < items.length; i++) {
              var item = items[i];
              var renderable = item.blocks.filter(function(b2) { return b2.kind !== 'tool_result'; });
              if (!renderable.length) continue;
              var isUser = item.role === 'user';
              html += '<div class="tx-row ' + (isUser ? 'user' : 'asst') + '"><div class="tx-msg ' + (isUser ? 'user' : 'asst') + '">';
              for (var j = 0; j < renderable.length; j++) html += txRenderBlock(renderable[j], results);
              html += '</div></div>';
            }
            return html + '</div>';
          }

          // —— 对话面板（只读：本 worker 承接的远程实时对话，展开见消息线 + 流式实时增量）——
          var expandedConvId = null;
          var convCache = [];
          var convListFp = '';
          var convDetailFp = null;
          var convDetailFpId = null;
          // H2：当前展开对话的 jsonl 缓存 + 版本（synced_at 毫秒）。版本命中则主进程回传 jsonl=null，
          // 复用缓存、跳过 571KB blob 的 DB 读 + IPC 传输。
          var convDetailJsonl = "";
          var convDetailJsonlVer = "";
          var convDetailJsonlConvId = null;
          // 「思考中」指示 HTML（✦ 内联 SVG 取自 lucide sparkles，与 Web 控制台同款）。
          var TX_THINKING_HTML = '<div class="tx-thinking"><svg class="tx-thinking-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/></svg><span class="tx-thinking-label">思考中…</span></div>';
          function convRow(c) {
            const right = c.generating ? '<span class="conv-live">回复中</span>' : '';
            const activeClass = expandedConvId === c.id ? ' conv-active' : '';
            return '<div class="conv-item">' +
              '<div class="conv-row' + activeClass + '" data-conv-row="' + esc(c.id) + '">' +
                '<span class="li-main"><span class="li-title">' + esc(c.title || "未命名对话") + '</span>' +
                '<span class="li-sub">' + esc(c.project_name || "") + (c.branch ? " · " + esc(c.branch) : "") + '</span></span>' +
                right +
                '<span class="task-time">' + (c.last_message_at ? elapsed(c.last_message_at) : "") + '</span>' +
              '</div>' +
            '</div>';
          }
          function renderConversations(list) {
            convCache = list || [];
            var liveN = convCache.filter(function (c) { return c.generating; }).length;
            setNavCount("navConvCount", liveN);
            if (!convCache.length) { $("conversations").innerHTML = '<span class="empty">本机暂无对话</span>'; convListFp = ''; return; }
            var newFp = (expandedConvId || '') + '|' + convCache.map(function(c) { return c.id + (c.generating ? '1' : '0'); }).join(',');
            if (convListFp === newFp) return;
            convListFp = newFp;
            $("conversations").innerHTML = convCache.map(convRow).join("");
            if (expandedConvId) loadConvDetail(expandedConvId);
          }
          async function reloadConversations() {
            let list = [];
            try { list = await window.workerApi.listMyConversations(); } catch (e) { return; }
            renderConversations(list);
          }
          // 本轮(最后一条 done assistant 之后)、jsonl 尚未收录的 user 消息 → 「思考中」阶段先本地可见。
          // 多轮续接时 web 刚发来的新问题已落 conversation_messages，但 jsonl 还停在上几轮（claude 本轮未同步），
          // 若只渲染 jsonl 会把新问题吞掉；这里把它补成 user 气泡（与 Web 端 pending/jsonl.includes 同思路）。
          function pendingTurnUserBubbles(msgs, jsonl) {
            var lastDone = -1;
            for (var i = 0; i < msgs.length; i++) {
              if (msgs[i].role === "assistant" && msgs[i].status === "done") lastDone = i;
            }
            var out = "";
            for (var i = lastDone + 1; i < msgs.length; i++) {
              var m = msgs[i];
              if (m.role !== "user") continue;
              var body = m.body || "";
              if (!body) continue;
              if (jsonl && jsonl.indexOf(body) >= 0) continue;
              out += '<div class="tx-row user"><div class="tx-msg user"><div class="tx-text"><span style="white-space:pre-wrap">' + esc(body) + '</span></div></div></div>';
            }
            return out;
          }
          var convDetailLoadingId = null;
          async function loadConvDetail(convId) {
            // 单飞：同一对话已在途加载则跳过，避免 400ms 轮询叠加大 jsonl 慢取堆成请求风暴（卡顿主因）。
            // 切到「不同」对话不拦（convId 不同即放行），靠下方「过期丢弃」只渲染当前选中对话的结果。
            if (convDetailLoadingId === convId) return;
            var box = document.getElementById("conv-detail-panel");
            if (!box) return;
            convDetailLoadingId = convId;
            try {
              var scrollEl = document.getElementById("conv-detail-body");
              var prevTop = scrollEl ? scrollEl.scrollTop : null;
              // 从对话列表缓存取 generating 状态，不依赖 msgs（msgs 早期可能为空）
              var convMeta = convCache.find(function(c) { return c.id === convId; });
              var isGenerating = !!(convMeta && convMeta.generating);
              var known = (convDetailJsonlConvId === convId) ? convDetailJsonlVer : null;
              var d;
              try { d = await window.workerApi.getConversationDetail(convId, known); }
              catch (e) { if (convId === expandedConvId) box.innerHTML = '<span class="empty">加载失败</span>'; return; }
              // 过期丢弃：await 期间用户已切到别的对话 → 本次结果不再渲染，否则两对话内容互相覆盖、循环渲染。
              if (convId !== expandedConvId) return;
              var msgs = d.messages || [];
              // H2：jsonl==null 表示版本未变 → 复用缓存；否则刷新缓存。
              var jsonl;
              if (d.jsonl == null) {
                jsonl = (convDetailJsonlConvId === convId) ? convDetailJsonl : "";
              } else {
                jsonl = d.jsonl;
                convDetailJsonl = jsonl; convDetailJsonlVer = d.jsonlVersion || ""; convDetailJsonlConvId = convId;
              }
              // 若对话正在生成且内容还未就绪，只展示动画；否则无内容时显示占位文字
              if (!msgs.length && !jsonl) {
                if (isGenerating) {
                  var animFp = "generating|" + convId;
                  if (convDetailFpId === convId && convDetailFp === animFp) return;
                  convDetailFp = animFp; convDetailFpId = convId;
                  box.innerHTML = TX_THINKING_HTML;
                  if (scrollEl) scrollEl.scrollTo({ top: 0, behavior: 'instant' });
                } else {
                  box.innerHTML = '<span class="empty">无消息</span>';
                }
                return;
              }
              var hasStreaming = isGenerating || msgs.some(function(m) { return m.role === "assistant" && (m.status === "streaming" || m.status === "pending"); });
              var fp = msgs.map(function(m) { return m.id + m.status; }).join(",") + "|" + jsonl.length + "|" + (isGenerating ? "1" : "0");
              if (convDetailFpId === convId && convDetailFp === fp) return;
              convDetailFp = fp;
              convDetailFpId = convId;
              var html = "";
              if (jsonl) {
                html = renderTranscriptHtml(parseTranscript(jsonl));
                // 本轮已发出但 jsonl 尚未收录的 user 消息（多轮续接的新问题在「思考中」阶段也立即可见）。
                var pendingHtml = pendingTurnUserBubbles(msgs, jsonl);
                if (pendingHtml) html += '<div class="tx">' + pendingHtml + '</div>';
              } else {
                // JSONL 未就绪（对话启动头几秒）：降级为纯文本气泡
                html = '<div class="tx">' + msgs.map(function(m) {
                  var isUser = m.role === "user";
                  var body = m.status === "failed" ? "执行失败：" + esc(m.error_message || "") : esc(m.body || "");
                  if (!body && !isUser) return "";
                  return '<div class="tx-row ' + (isUser ? "user" : "asst") + '"><div class="tx-msg ' + (isUser ? "user" : "asst") + '">' +
                    '<div class="tx-text"><span style="white-space:pre-wrap">' + body + '</span></div></div></div>';
                }).join("") + '</div>';
              }
              if (hasStreaming) html += TX_THINKING_HTML;
              box.innerHTML = html;
              if (!scrollEl) return;
              if (hasStreaming || prevTop === null) {
                scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: 'instant' });
              } else {
                scrollEl.scrollTo({ top: prevTop, behavior: 'instant' });
              }
            } finally {
              if (convDetailLoadingId === convId) convDetailLoadingId = null;
            }
          }

          async function refresh() {
            let s;
            try { s = await window.workerApi.getState(); } catch (e) { return; }
            if (!s) return;
            const working = s.workingState === "working";

            // 侧栏身份
            $("sideName").textContent = s.workerName || "worker";
            $("sideHost").textContent = s.hostName || (s.os && s.os.label) || "—";

            // 顶栏 SSE 中转连通性：dot 着色 + 文案；仅 connected 时脉冲（绿）。
            const relayMeta = {
              connected: { color: "var(--success)", text: "SSE 已连通（" + (s.relayChannels || 0) + " 频道）", pulse: true },
              connecting: { color: "var(--running)", text: "SSE 连接中…", pulse: false },
              reconnecting: { color: "var(--pending)", text: "SSE 重连中…", pulse: false },
              disabled: { color: "var(--cancelled)", text: "轮询模式（SSE 未启用）", pulse: false }
            }[s.relayState] || { color: "var(--cancelled)", text: "轮询模式（SSE 未启用）", pulse: false };
            const relayDot = $("relayDot");
            relayDot.style.background = relayMeta.color;
            relayDot.classList.toggle("pulse", relayMeta.pulse);
            $("relay").textContent = relayMeta.text;

            // 顶栏数据库连通性：connected 绿且脉冲；未配置灰；连不上红。
            const dbMeta = {
              connected: { color: "var(--success)", text: "数据库已连接", pulse: true },
              unconfigured: { color: "var(--cancelled)", text: "数据库未配置", pulse: false },
              error: { color: "var(--failed)", text: "数据库连不上", pulse: false }
            }[s.dbState] || { color: "var(--cancelled)", text: "数据库未配置", pulse: false };
            const dbDot = $("dbDot");
            dbDot.style.background = dbMeta.color;
            dbDot.classList.toggle("pulse", dbMeta.pulse);
            $("dbStat").textContent = dbMeta.text;

            // 顶栏工作态徽标
            const state = $("state");
            state.setAttribute("data-tone", working ? "success" : "pending");
            state.innerHTML = '<span class="glyph">' + (working ? "▶" : "⏸") + "</span>" + (working ? "工作中" : "空闲");

            // 设置页控件回显（避免覆盖正在编辑的输入）
            if (document.activeElement !== $("workingToggle")) $("workingToggle").checked = working;
            if (document.activeElement !== $("remoteToggle")) $("remoteToggle").checked = !!s.allowRemoteControl;
            if (document.activeElement !== $("maxParallel")) $("maxParallel").value = s.maxParallel;

            // 能力自检
            const caps = s.capabilities || {};
            $("caps").innerHTML = [capDot("git", caps.git), capDot("gh", caps.gh), capDot("claude", caps.claude), capDot("node.js", caps.nodejs), capDot("python", caps.python)].join("");

            // 套餐用量
            const u = s.usage || {};
            const bars = usageBar("5 小时窗口", u.five_hour) + usageBar("7 天窗口", u.seven_day);
            $("usageSection").style.display = bars ? "block" : "none";
            $("usage").innerHTML = bars;

            // 总览统计卡
            $("statWorking").textContent = working ? "工作中" : "空闲";
            $("statWorking").className = "stat-value " + (working ? "ok" : "muted");
            $("statWorkingFoot").textContent = working ? "正在等待新任务" : "在线但不接任务";
            $("statActive").innerHTML = s.activeCount + '<span class="unit">/ ' + s.maxParallel + "</span>";
            $("statActiveFoot").textContent = "并发上限 " + s.maxParallel;
            const capList = [caps.git, caps.gh, caps.claude, caps.nodejs, caps.python];
            const capOk = capList.filter(function (c) { return c && c.ok; }).length;
            $("statCaps").innerHTML = capOk + '<span class="unit">/ 5</span>';
            const miss = [];
            if (!(caps.git && caps.git.ok)) miss.push("git");
            if (!(caps.gh && caps.gh.ok)) miss.push("gh");
            if (!(caps.claude && caps.claude.ok)) miss.push("claude");
            if (!(caps.nodejs && caps.nodejs.ok)) miss.push("node.js");
            if (!(caps.python && caps.python.ok)) miss.push("python");
            $("statCapsFoot").textContent = miss.length ? "缺：" + miss.join("、") : "全部就绪";
            const relayShort = { connected: (s.relayChannels || 0) + " 频道", connecting: "连接中", reconnecting: "重连中", disabled: "未启用" }[s.relayState] || "未启用";
            $("statRelay").textContent = relayShort;
            $("statRelayFoot").textContent = s.relayState === "connected" ? "SSE 实时线已连通" : s.relayState === "disabled" ? "纯数据库轮询" : "SSE " + relayMeta.text;

            // 总览本机信息
            $("ovName").textContent = s.workerName || "—";
            $("ovHost").textContent = s.hostName || "—";
            $("ovOs").textContent = (s.os && s.os.label) || "—";
            $("ovClaude").textContent = s.claudeVersion || "—";
            $("ovSub").textContent = s.subscriptionType || "—";
            $("ovTerminal").textContent = s.terminalCommand || "默认";
            if (currentPage === "overview") {
              var _now = new Date(); var _p2 = function(n) { return String(n).padStart(2, "0"); };
              $("pageSub").textContent = "本机运行状态、能力与套餐用量 · 每 15s 刷新 · 上次 " + _p2(_now.getHours()) + ":" + _p2(_now.getMinutes()) + ":" + _p2(_now.getSeconds());
            }

            // 日志（仅内存，全高卡片内滚；保留近 200 行）
            const logs = s.logs || [];
            const box = $("logs");
            const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 8;
            box.innerHTML = logs.slice(-200).map((l) =>
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
              '<span class="task-actions"><button class="btn btn-sm" data-openpath="' + esc(l.local_path) + '">打开目录</button>' +
              '<button class="btn btn-sm danger" data-unlink="' + esc(l.project_name) + "|||" + esc(l.local_path) + '">删除</button></span>' +
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
            // 前置命令示例按平台给：非 Windows（mac/Linux）用 bash 语法，避免误导用户写 PowerShell。
            if (s && s.os && s.os.platform !== "win32") {
              $("preCommand").placeholder = "留空 = 不执行；示例(bash)：export HTTPS_PROXY=http://127.0.0.1:10808";
            }
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

          // —— SSE 中转服务地址 / token 配置（持久化进 worker.json，覆盖 env，保存即时重连）——
          async function loadRelay() {
            let s = null;
            try { s = await window.workerApi.getState(); } catch (e) {}
            if (!s) return;
            if (document.activeElement !== $("relayUrl")) $("relayUrl").value = s.relayUrl || "";
            if (document.activeElement !== $("relayPublishToken")) $("relayPublishToken").value = s.relayPublishToken || "";
            if (document.activeElement !== $("relayWorkerToken")) $("relayWorkerToken").value = s.relayWorkerToken || "";
          }
          $("saveRelay").addEventListener("click", async () => {
            const btn = $("saveRelay"), hint = $("relayHint");
            btn.disabled = true; hint.textContent = "保存中…";
            try {
              await window.workerApi.setRelayConfig({
                url: $("relayUrl").value.trim(),
                publishToken: $("relayPublishToken").value.trim(),
                workerToken: $("relayWorkerToken").value.trim()
              });
              hint.textContent = $("relayUrl").value.trim() ? "已保存，即时生效（连通状态见顶栏）" : "已保存，中转已禁用（纯数据库轮询）";
              await loadRelay();
            } catch (e) { hint.textContent = "保存失败：" + (e && e.message ? e.message : e); }
            finally { btn.disabled = false; }
          });

          // —— 数据库连接串配置（持久化进 worker.json，覆盖 env，保存即时连接并重启循环）——
          async function loadDb() {
            let s = null;
            try { s = await window.workerApi.getState(); } catch (e) {}
            if (!s) return;
            if (document.activeElement !== $("databaseUrl")) $("databaseUrl").value = s.databaseUrl || "";
          }
          $("saveDatabase").addEventListener("click", async () => {
            const btn = $("saveDatabase"), hint = $("databaseHint");
            const url = $("databaseUrl").value.trim();
            btn.disabled = true; hint.textContent = "保存并连接中…";
            try {
              const r = await window.workerApi.setDatabaseConfig(url);
              if (!url) hint.textContent = "已清空数据库配置（Worker 将停止接活）";
              else if (r && r.ok) hint.textContent = "已保存，数据库连接成功，已重新注册";
              else hint.textContent = "已保存，但连接失败：" + ((r && r.error) || "未知原因") + "（检查连接串 / 网络后重试）";
              await loadDb();
              refresh();
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
          $("tasksRefresh").addEventListener("click", function() { reloadTasks(true); });
          $("tasksPrev").addEventListener("click", function() { if (tasksPage > 1) { tasksPage--; reloadTasks(true); } });
          $("tasksNext").addEventListener("click", function() {
            var totalPages = Math.ceil(tasksTotal / tasksPageSize) || 1;
            if (tasksPage < totalPages) { tasksPage++; reloadTasks(true); }
          });
          $("convRefresh").addEventListener("click", reloadConversations);
          $("logsClear").addEventListener("click", async () => { await window.workerApi.clearLogs(); refresh(); });

          // 侧边栏菜单切换
          document.querySelectorAll("[data-nav]").forEach(function (el) {
            el.addEventListener("click", function () { showPage(el.getAttribute("data-nav")); });
          });

          document.addEventListener("click", async (e) => {
            const capPathEl = e.target.closest && e.target.closest("[data-cap-path]");
            if (capPathEl) { const p = capPathEl.getAttribute("data-cap-path"); if (p) window.workerApi.openPath(p); return; }
            const filterBtn = e.target.closest && e.target.closest("[data-tasks-filter]");
            if (filterBtn) { tasksFilter = filterBtn.getAttribute("data-tasks-filter"); tasksPage = 1; reloadTasks(true); return; }
            const actionEl = e.target.closest && e.target.closest("[data-task-action]");
            if (actionEl) {
              await handleTaskAction(actionEl.getAttribute("data-task-action"),
                actionEl.getAttribute("data-task-id"), actionEl);
              return;
            }
            const openPathEl = e.target.closest && e.target.closest("[data-openpath]");
            if (openPathEl) {
              await window.workerApi.openPath(openPathEl.getAttribute("data-openpath"));
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
              renderTasks();
              return;
            }
            const convRowEl = e.target.closest && e.target.closest("[data-conv-row]");
            if (convRowEl) {
              const cid = convRowEl.getAttribute("data-conv-row");
              if (expandedConvId !== cid) {
                expandedConvId = cid;
                convListFp = '';
                convDetailFp = null;
                convDetailFpId = null;
                renderConversations(convCache);
                const conv = convCache.find(function(c) { return c.id === cid; });
                const titleEl = document.getElementById("conv-detail-title");
                if (titleEl) titleEl.textContent = (conv && conv.title) ? conv.title : "未命名对话";
              }
            }
          });

          showPage("overview");
          refresh(); loadProjects(); reloadTasks(); reloadConversations(); loadTerminals(); loadRelay(); loadDb();
          // 冷启动预热：主进程现在窗口先于 worker.start() 渲染（DB 不可达也能出窗口），但能力自检/OS/用量要等
          // start() 完成后才有值；只靠 15s 常规轮询会让能力区空窗最长 15s。开局再快轮询几次，start() 一就绪
          //（通常 1-3s）能力即显示，之后回落到 15s 常规节奏。
          [1200, 2500, 5000, 9000].forEach(function(ms) { setTimeout(refresh, ms); });
          setInterval(refresh, 15000);
          setInterval(loadProjects, 15000);
          setInterval(() => { if (!isEditingTask()) reloadTasks(); }, 4000);
          setInterval(reloadConversations, 3000);
          // 详情高频刷新只在「生成中」对话上跑：静态对话内容不变，无需每 400ms 经 IPC 重取整段 jsonl（卡顿源）；
          // 静态对话的内容已由点击切换 / 列表变化时的 renderConversations→loadConvDetail 兜住。
          setInterval(() => {
            if (!expandedConvId) return;
            var meta = convCache.find(function(c) { return c.id === expandedConvId; });
            if (meta && meta.generating) loadConvDetail(expandedConvId);
          }, 400);
        </script>
      </body>
    </html>
  `;
}
