import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { ClaudeCenterWorker } from "./runner.js";

let worker: ClaudeCenterWorker | null = null;

// 窗口 HTML：状态 / 用量 / 能力自检 / 关联项目 / 在途任务 / 日志，经 preload 暴露的 workerApi 驱动。
// 渲染层用字符串拼接（不嵌套反引号）避免与外层模板字面量冲突。
function windowHtml(): string {
  return `
    <!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <style>
          :root { --ink:#151716; --line:#202421; --paper:#fffdf6; --bg:#f3f1ea; --muted:#66736f; --faint:#97a09c; }
          * { box-sizing: border-box; }
          body {
            margin: 0; padding: 16px; background: var(--bg); color: var(--ink);
            font-family: Segoe UI, sans-serif; font-size: 13px;
          }
          h1 { margin: 0 0 2px; font-size: 18px; }
          .meta { margin: 0 0 12px; color: var(--muted); font-size: 12px; }
          section {
            border: 1px solid var(--line); border-radius: 6px; background: var(--paper);
            box-shadow: 3px 3px 0 var(--line); padding: 12px 14px; margin-bottom: 12px;
          }
          section h2 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
          .row { display: flex; align-items: center; justify-content: space-between; padding: 7px 0; border-top: 1px solid #e7e3d6; }
          .row:first-of-type { border-top: 0; }
          .label { font-size: 13px; }
          .hint { display: block; color: var(--faint); font-size: 11px; margin-top: 2px; }
          .state { font-weight: 600; }
          .state.on { color: #1f7a4d; } .state.off { color: #9a6a00; }
          .switch { position: relative; width: 42px; height: 24px; flex: none; }
          .switch input { opacity: 0; width: 0; height: 0; }
          .slider { position: absolute; inset: 0; cursor: pointer; background: #cfcabb; border-radius: 24px; transition: .15s; }
          .slider::before { content: ""; position: absolute; height: 18px; width: 18px; left: 3px; top: 3px; background: var(--paper); border-radius: 50%; transition: .15s; }
          input:checked + .slider { background: #1f7a4d; }
          input:checked + .slider::before { transform: translateX(18px); }
          .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
          .dot.ok { background: #1f7a4d; } .dot.bad { background: #c0392b; }
          .gauge { margin: 8px 0; }
          .gauge .bar { height: 8px; background: #e7e3d6; border-radius: 4px; overflow: hidden; }
          .gauge .fill { height: 100%; background: #1f7a4d; }
          .gauge .fill.warn { background: #d08700; } .gauge .fill.hot { background: #c0392b; }
          .gauge .cap { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); margin-bottom: 3px; }
          .item { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 0; border-top: 1px solid #e7e3d6; }
          .item:first-child { border-top: 0; }
          .item .who { min-width: 0; }
          .item .who b { font-weight: 600; }
          .item .who small { display: block; color: var(--faint); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 320px; }
          button { font-family: inherit; font-size: 12px; border: 1px solid var(--line); background: var(--paper); border-radius: 4px; padding: 4px 10px; cursor: pointer; }
          button:hover { background: #f3eede; }
          button.danger { color: #c0392b; border-color: #c0392b; }
          button:disabled { opacity: .5; cursor: default; }
          input[type=number] { width: 64px; font-family: inherit; font-size: 13px; padding: 3px 6px; border: 1px solid var(--line); border-radius: 4px; }
          select, input.path { font-family: inherit; font-size: 12px; padding: 4px 6px; border: 1px solid var(--line); border-radius: 4px; }
          .addform { display: grid; grid-template-columns: 1fr auto; gap: 6px; margin-top: 8px; }
          .addform .path { width: 100%; }
          .addform .grow { display: flex; gap: 6px; }
          .empty { color: var(--faint); font-size: 12px; padding: 4px 0; }
          #logs { font-family: Consolas, monospace; font-size: 11px; background: #1d211e; color: #d6e2dc; border-radius: 4px; padding: 8px; height: 150px; overflow: auto; white-space: pre-wrap; }
          #logs .err { color: #ff9b8a; }
        </style>
      </head>
      <body>
        <h1>ClaudeCenter Worker</h1>
        <p class="meta" id="meta">连接中…</p>

        <section>
          <h2>状态与设置</h2>
          <div class="row">
            <span class="label">当前状态</span>
            <span class="state off" id="state">—</span>
          </div>
          <div class="row">
            <span class="label">工作状态<span class="hint">开 = 接任务；关 = 在线但不接任务</span></span>
            <label class="switch"><input type="checkbox" id="workingToggle" /><span class="slider"></span></label>
          </div>
          <div class="row">
            <span class="label">允许 web 端远程开关<span class="hint">关闭后中控无法远程切换工作态</span></span>
            <label class="switch"><input type="checkbox" id="remoteToggle" /><span class="slider"></span></label>
          </div>
          <div class="row">
            <span class="label">并发上限<span class="hint">同时执行的在途任务数</span></span>
            <input type="number" id="maxParallel" min="1" max="16" />
          </div>
        </section>

        <section>
          <h2>能力自检</h2>
          <div id="caps">—</div>
        </section>

        <section id="usageSection" style="display:none">
          <h2>套餐用量</h2>
          <div id="usage"></div>
        </section>

        <section>
          <h2>关联项目</h2>
          <div id="projects"><span class="empty">加载中…</span></div>
          <div class="addform">
            <select id="cloudProject"></select>
            <div class="grow">
              <button id="pickBtn" type="button">选择文件夹</button>
              <button id="addBtn" type="button">添加</button>
            </div>
            <input class="path" id="localPath" placeholder="本地路径（点「选择文件夹」）" readonly />
            <span></span>
          </div>
        </section>

        <section>
          <h2>在途任务</h2>
          <div id="active"><span class="empty">无在途任务</span></div>
        </section>

        <section>
          <h2>日志</h2>
          <div id="logs"></div>
        </section>

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
            return '<span><span class="dot ' + (ok ? "ok" : "bad") + '"></span>' + name +
              (ok && cap.version ? " " + esc(cap.version) : ok ? "" : " 未检出") + "</span>";
          }

          function usageBar(label, win) {
            if (!win) return "";
            const pct = Math.max(0, Math.min(100, Math.round(win.utilization)));
            const cls = pct >= 90 ? "hot" : pct >= 70 ? "warn" : "";
            return '<div class="gauge"><div class="cap"><span>' + label + '</span><span>' + pct + '%</span></div>' +
              '<div class="bar"><div class="fill ' + cls + '" style="width:' + pct + '%"></div></div></div>';
          }

          async function refresh() {
            let s;
            try { s = await window.workerApi.getState(); } catch (e) { return; }
            if (!s) return;
            const working = s.workingState === "working";
            $("meta").textContent =
              (s.workerName || "worker") + " · claude " + (s.claudeVersion || "—") + " · " +
              s.subscriptionType + " · 在途 " + s.activeCount + "/" + s.maxParallel;
            const state = $("state");
            state.textContent = working ? "工作中（接任务）" : "空闲（不接任务）";
            state.className = "state " + (working ? "on" : "off");
            if (document.activeElement !== $("workingToggle")) $("workingToggle").checked = working;
            if (document.activeElement !== $("remoteToggle")) $("remoteToggle").checked = !!s.allowRemoteControl;
            if (document.activeElement !== $("maxParallel")) $("maxParallel").value = s.maxParallel;

            const caps = s.capabilities || {};
            $("caps").innerHTML = [capDot("git", caps.git), capDot("gh", caps.gh), capDot("claude", caps.claude)].join("　");

            const u = s.usage || {};
            const bars = usageBar("5 小时窗口", u.five_hour) + usageBar("7 天窗口", u.seven_day);
            $("usageSection").style.display = bars ? "block" : "none";
            $("usage").innerHTML = bars;

            const tasks = s.activeTasks || [];
            $("active").innerHTML = tasks.length ? tasks.map((t) =>
              '<div class="item"><span class="who"><b>' + esc(t.title) + '</b><small>' +
              t.kind + " · " + elapsed(t.startedAt) + (t.cancelled ? " · 取消中" : "") + "</small></span>" +
              (t.kind === "task" && t.taskId && !t.cancelled
                ? '<button class="danger" data-cancel="' + esc(t.taskId) + '">取消</button>' : "") +
              "</div>").join("") : '<span class="empty">无在途任务</span>';

            const logs = s.logs || [];
            const box = $("logs");
            const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 8;
            box.innerHTML = logs.slice(-60).map((l) =>
              '<div class="' + (l.level === "error" ? "err" : "") + '">' +
              esc(l.ts.slice(11, 19)) + " " + esc(l.message) + "</div>").join("");
            if (atBottom) box.scrollTop = box.scrollHeight;
          }

          async function loadProjects() {
            let links = [], cloud = [];
            try { links = await window.workerApi.listProjectLinks(); } catch (e) {}
            try { cloud = await window.workerApi.listCloudProjects(); } catch (e) {}
            $("projects").innerHTML = (links && links.length) ? links.map((l) =>
              '<div class="item"><span class="who"><b>' + esc(l.project_name) + '</b><small>' +
              esc(l.local_path) + "</small></span>" +
              '<button class="danger" data-unlink="' + esc(l.project_name) + "|||" + esc(l.local_path) + '">删除</button>' +
              "</div>").join("") : '<span class="empty">未关联任何项目</span>';
            const sel = $("cloudProject");
            sel.innerHTML = (cloud && cloud.length)
              ? cloud.map((p) => '<option value="' + esc(p.name) + '">' + esc(p.name) + "</option>").join("")
              : '<option value="">（无云端项目）</option>';
          }

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
          document.addEventListener("click", async (e) => {
            const cancel = e.target.getAttribute && e.target.getAttribute("data-cancel");
            if (cancel) { e.target.disabled = true; await window.workerApi.cancelTask(cancel); refresh(); return; }
            const unlink = e.target.getAttribute && e.target.getAttribute("data-unlink");
            if (unlink) {
              const [projectName, localPath] = unlink.split("|||");
              await window.workerApi.removeProjectLink({ projectName, localPath }); await loadProjects();
            }
          });

          refresh(); loadProjects();
          setInterval(refresh, 3000);
          setInterval(loadProjects, 15000);
        </script>
      </body>
    </html>
  `;
}

function createWindow(): void {
  // preload 与资产同样按 ../ 解析到 apps/worker 下，dist(electron) 与 src(tsx) 两种运行方式路径一致。
  const appDir = path.dirname(fileURLToPath(import.meta.url));
  const window = new BrowserWindow({
    width: 560,
    height: 820,
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
  ipcMain.handle("worker:listCloudProjects", () => worker?.listCloudProjects() ?? []);
  ipcMain.handle("worker:listProjectLinks", () => worker?.listProjectLinks() ?? []);
  ipcMain.handle("worker:addProjectLink", (_event, input: { projectName: string; localPath: string }) =>
    worker?.addProjectLink(input)
  );
  ipcMain.handle("worker:removeProjectLink", (_event, input: { projectName: string; localPath: string }) =>
    worker?.removeProjectLink(input)
  );
  ipcMain.handle("worker:cancelTask", (_event, taskId: string) => worker?.cancelTask(taskId) ?? false);

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
