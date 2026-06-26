// 截 chat 实时对话页面，重点验证 composer 区域的圆形按钮组（定时/附件/发送）。
// 前置：dev server 在 http://127.0.0.1:3010 启动。
import { chromium } from "playwright";
import { mkdir } from "fs/promises";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FEATURE = path.resolve(__dirname, "..");
const OUT = path.join(FEATURE, "round-1");
const BASE = process.env.CONSOLE_BASE || "http://127.0.0.1:3010";

const env = readFileSync(path.resolve(FEATURE, "../../../.env"), "utf8");
const grab = (k) => env.match(new RegExp(`^${k}=(.+)`, "m"))?.[1]?.trim() ?? "";
const username = grab("USERNAME");
const password = grab("PASSWORD");

await mkdir(OUT, { recursive: true });

async function run(viewport, prefix) {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });

  const login = await ctx.request.post(`${BASE}/api/auth/login`, {
    data: { username, password },
    headers: { "Content-Type": "application/json" }
  });
  if (login.status() !== 200) {
    console.error(`[${prefix}] login failed: ${login.status()} ${await login.text()}`);
    await browser.close();
    return;
  }

  // 拿一个 conversation 进 thread 视图
  const convResp = await ctx.request.get(`${BASE}/api/conversations?limit=10`);
  const convData = await convResp.json();
  const firstConv = convData?.conversations?.[0];

  const page = await ctx.newPage();

  async function shot(url, name, delay = 1800) {
    if (url) {
      await page.goto(`${BASE}${url}`);
      await page.waitForLoadState("networkidle").catch(() => {});
    }
    await page.waitForTimeout(delay);
    const file = path.join(OUT, prefix ? `${prefix}-${name}` : name);
    await page.screenshot({ path: file, fullPage: false });
    console.log(`✓ ${path.basename(file)}`);
    return file;
  }

  // 1. 进入 chat 主界面（会话列表 + 提示面板）
  await shot("/chat", "chat-landing.png");

  if (firstConv?.id) {
    // 2. 进入某条会话，截整体（用户能看到 composer）
    await shot(`/chat?c=${encodeURIComponent(firstConv.id)}`, "chat-thread.png", 2500);

    // 3. 在 composer 输入一段话，截输入态
    const ta = await page.$(".chat-composer-input");
    if (ta) {
      await ta.click();
      await ta.fill("帮我看下这个 bug，定时晚点发");
      await page.waitForTimeout(400);
      await shot(null, "chat-thread-typed.png", 200);

      // 4. 点开定时按钮，截日期面板（向上展开）
      const scheduleBtn = await page.$('.chat-composer-actions .dt-picker .chat-composer-btn');
      if (scheduleBtn) {
        await scheduleBtn.click();
        await page.waitForTimeout(500);
        await shot(null, "chat-thread-schedule-open.png", 200);

        // 选今天上的一天，把面板关掉，截已选定时态（chip + 按钮 is-active 蓝色）
        const todayCell = await page.$('.dt-cell.today');
        if (todayCell) {
          // 选个未来日：尝试 +5 天的 cell（避免被 minNow 拦）
          const cells = await page.$$('.dt-cell:not(.disabled)');
          if (cells.length > 5) {
            await cells[cells.length - 1].click();
          } else if (cells.length > 0) {
            await cells[cells.length - 1].click();
          }
          await page.waitForTimeout(300);
        }
        // 关闭日期面板：按 Escape，避免点击坐标误触菜单 / sidebar
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
        await shot(null, "chat-thread-scheduled.png", 200);
      } else {
        console.warn(`[${prefix}] schedule button not found`);
      }
    } else {
      console.warn(`[${prefix}] textarea not found`);
    }
  } else {
    console.warn(`[${prefix}] no conversation available; only chat-landing shot taken`);
  }

  await browser.close();
}

console.log("── 桌面端 (1440×900) ──");
await run({ width: 1440, height: 900 }, "");

console.log("── 手机端 (390×844) ──");
await run({ width: 390, height: 844 }, "mobile");

console.log(`\n✓ 截图保存至 ${OUT}`);
