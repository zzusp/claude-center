// 诊断：单次硬加载首页，停留 20s，捕获浏览器 console（含 [diag] Notifications MOUNT/UNMOUNT）
// 与 /api/notifications 调用，判定一个文档里到底有几个 Notifications 实例 / 几个 poller。
import { chromium } from "playwright-core";
import { createSession, getPool, closePool } from "@claude-center/db";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..", "..", "..");
process.loadEnvFile(path.join(root, ".env"));

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:3010";
const ADMIN_ID = "66a52299-e964-44e5-8f7a-2f0f1e9d91da";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pool = getPool();
const token = await createSession(pool, ADMIN_ID, 1);
await closePool();

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext();
await context.addCookies([{ name: "cc_session", value: token, url: baseUrl, httpOnly: true, sameSite: "Lax" }]);
const page = await context.newPage();

const t0 = Date.now();
page.on("console", (msg) => {
  const txt = msg.text();
  if (txt.includes("[diag]")) console.log(`+${((Date.now() - t0) / 1000).toFixed(2)}s  ${txt}`);
});
page.on("request", (req) => {
  const u = req.url();
  if (u.startsWith(baseUrl) && /\/api\/(notifications|workers|tasks|projects|dashboard)(\?|$)/.test(u)) {
    console.log(`+${((Date.now() - t0) / 1000).toFixed(2)}s  REQ ${u.replace(baseUrl, "")}`);
  }
});

// 预热：逐路由硬加载，等 nav 渲染 + 多停 2s 让首次编译跑完，避免冷编译污染计时。
for (const r of ["/", "/tasks", "/chat", "/workers", "/projects"]) {
  await page.goto(baseUrl + r, { waitUntil: "commit" }).catch(() => {});
  await page.locator("a.nav-item").first().waitFor({ timeout: 30000 }).catch(() => {});
  await sleep(2000);
}
console.log(`+${((Date.now() - t0) / 1000).toFixed(2)}s  === warmup done ===`);

// 纯净 no-nav：硬加载首页，静置 50s，看 15000 poller 的 run 触发源，定位通知多发根因。
console.log(`+${((Date.now() - t0) / 1000).toFixed(2)}s  === HARD goto / then dwell 50s (NO NAV) ===`);
await page.goto(baseUrl + "/", { waitUntil: "commit" }).catch(() => {});
await sleep(50000);
await context.close();
await browser.close();
console.log("diag done");
