// 真实浏览器探针：驱动系统 Chrome 跑 console（next dev），录制 HAR + 请求时间线，
// 量化 (1) /api/notifications 轮询周期 (2) 切换页面初始化接口是否重复。
//
// 用法（dev server 须已在 BASE_URL 起好）：
//   node docs/acceptance/console-polling-dedup/scripts/probe-polling.mjs --label before
//   BASE_URL=http://127.0.0.1:3010 node ... --label after --home-dwell 35
//
// 依赖：playwright-core（--no-save 装在仓库 node_modules）、@claude-center/db（发会话）。
import { chromium } from "playwright-core";
import { createSession, getPool, closePool } from "@claude-center/db";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.dirname(here); // docs/acceptance/console-polling-dedup
process.loadEnvFile(path.join(outDir, "..", "..", "..", ".env"));

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const label = getArg("label", "run");
const baseUrl = process.env.BASE_URL || "http://127.0.0.1:3010";
const homeDwellS = Number(getArg("home-dwell", "35"));
const navDwellS = Number(getArg("nav-dwell", "4"));

const ADMIN_ID = "66a52299-e964-44e5-8f7a-2f0f1e9d91da"; // admin（dev 库唯一用户）
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const runDir = path.join(outDir, "round-1", label);
mkdirSync(runDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const pool = getPool();
  const token = await createSession(pool, ADMIN_ID, 1);
  await closePool();

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  // recordHar 用 minimal：只留请求/响应头与时序，不录响应体——full 模式会把 JS bundle 等全录进去，
  // 单次 HAR 达数十 MB（大 binary 不入库）。时序分析只需 timeline.json，HAR 仅作可选原始留存且已 gitignore。
  const context = await browser.newContext({
    recordHar: { path: path.join(runDir, "session.har"), mode: "minimal" }
  });
  await context.addCookies([
    { name: "cc_session", value: token, url: baseUrl, httpOnly: true, sameSite: "Lax" }
  ]);

  const t0 = Date.now();
  const timeline = []; // {t, phase, method, path, search}
  let phase = "warmup";
  const page = await context.newPage();
  page.on("request", (req) => {
    const url = req.url();
    if (!url.startsWith(baseUrl)) return;
    let p, s;
    try {
      const u = new URL(url);
      p = u.pathname;
      s = u.search;
    } catch {
      p = url;
      s = "";
    }
    if (!p.startsWith("/api/")) return; // 只关心数据接口
    timeline.push({ t: Date.now() - t0, phase, method: req.method(), path: p, search: s });
  });

  const routes = ["/", "/tasks", "/chat", "/workers", "/projects"];

  // 预热：逐个访问把 Turbopack 首次编译噪声跑掉（首编译会拖慢/错位时间线）。
  // 用 commit + 等 nav 渲染，避免 networkidle 因轮询永不空闲而每路由 30s 超时。
  for (const r of routes) {
    await page.goto(baseUrl + r, { waitUntil: "commit" }).catch(() => {});
    await page.locator("a.nav-item").first().waitFor({ timeout: 30000 }).catch(() => {});
    await sleep(1500);
  }

  // 阶段一：首页停留量通知周期。
  phase = "home-dwell";
  await page.goto(baseUrl + "/", { waitUntil: "commit" }).catch(() => {});
  await page.locator("a.nav-item").first().waitFor({ timeout: 30000 }).catch(() => {});
  const dwellMark = Date.now() - t0;
  await sleep(homeDwellS * 1000);

  // 阶段二：依次导航量初始化重复（用 SPA 软导航，模拟用户点侧边栏）。
  const navMarks = [];
  for (const r of ["/tasks", "/chat", "/workers", "/projects", "/"]) {
    phase = `nav:${r}`;
    const at = Date.now() - t0;
    navMarks.push({ route: r, at });
    // 软导航：点侧边栏链接（href=r）。找不到则 goto 兜底。
    const link = page.locator(`a.nav-item[href="${r}"]`).first();
    if (await link.count()) {
      await link.click().catch(() => {});
    } else {
      await page.goto(baseUrl + r, { waitUntil: "commit" }).catch(() => {});
    }
    await sleep(navDwellS * 1000);
  }

  await context.close(); // flush HAR
  await browser.close();

  writeFileSync(
    path.join(runDir, "timeline.json"),
    JSON.stringify({ label, baseUrl, t0, dwellMark, navMarks, timeline }, null, 2)
  );

  // ---- 分析 ----
  const notif = timeline.filter((e) => e.path === "/api/notifications" && e.t >= dwellMark);
  const cadence = [];
  for (let i = 1; i < notif.length; i++) cadence.push(((notif[i].t - notif[i - 1].t) / 1000).toFixed(2));

  console.log(`\n=== [${label}] notifications cadence (home-dwell window, ${homeDwellS}s) ===`);
  console.log(`calls: ${notif.length}  intervals(s): [${cadence.join(", ")}]`);

  console.log(`\n=== [${label}] per-navigation init duplicates ===`);
  const navReport = [];
  for (let i = 0; i < navMarks.length; i++) {
    const start = navMarks[i].at;
    const end = i + 1 < navMarks.length ? navMarks[i + 1].at : Infinity;
    const win = timeline.filter((e) => e.t >= start && e.t < end);
    const counts = {};
    for (const e of win) {
      const k = `${e.method} ${e.path}${e.search}`;
      counts[k] = (counts[k] || 0) + 1;
    }
    const dups = Object.entries(counts).filter(([, n]) => n > 1);
    navReport.push({ route: navMarks[i].route, dups });
    console.log(
      `nav ${navMarks[i].route.padEnd(10)} -> ${
        dups.length ? dups.map(([k, n]) => `${k} x${n}`).join("; ") : "no dup"
      }`
    );
  }

  writeFileSync(
    path.join(runDir, "analysis.json"),
    JSON.stringify({ label, notifCalls: notif.length, cadence, navReport }, null, 2)
  );
  console.log(`\nartifacts: ${runDir}`);
}

main().catch((e) => {
  console.error("PROBE ERROR:", e);
  process.exit(1);
});
