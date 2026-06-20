/**
 * 截取 Console 各主要页面截图（桌面 + 手机端），存入 docs/screenshots/
 * 用法: node scripts/take-screenshots.mjs
 * 前置: dev server 须在 http://127.0.0.1:3000 运行
 */
import { chromium } from 'playwright';
import { mkdir } from 'fs/promises';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const BASE = 'http://127.0.0.1:3000';

function readEnv() {
  const env = readFileSync(path.join(ROOT, '.env'), 'utf8');
  const get = (key) => env.match(new RegExp(`^${key}=(.+)`, 'm'))?.[1]?.trim() ?? '';
  return { username: get('USERNAME'), password: get('PASSWORD') };
}
const { username, password } = readEnv();

await mkdir(OUT, { recursive: true });

async function runCaptures(viewport, prefix) {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport });

  const loginResp = await ctx.request.post(`${BASE}/api/auth/login`, {
    data: { username, password },
    headers: { 'Content-Type': 'application/json' },
  });
  if (loginResp.status() !== 200) {
    console.error(`[${prefix}] login failed:`, await loginResp.text());
    await browser.close();
    return;
  }

  const tasksResp = await ctx.request.get(`${BASE}/api/tasks?limit=1`);
  const tasksData = await tasksResp.json();
  const firstTaskId = tasksData?.tasks?.[0]?.id;

  const page = await ctx.newPage();

  async function shot(url, name, delay = 2500) {
    await page.goto(`${BASE}${url}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(delay);
    const file = path.join(OUT, prefix ? `${prefix}-${name}` : name);
    await page.screenshot({ path: file, fullPage: false });
    console.log(`✓ ${path.basename(file)}`);
  }

  await shot('/', 'overview.png');
  await shot('/tasks', 'tasks.png');
  if (firstTaskId) await shot(`/tasks/${firstTaskId}`, 'task-detail.png');
  await shot('/workers', 'workers.png');
  await shot('/chat', 'chat.png');

  await browser.close();
}

// 桌面端
console.log('\n── 桌面端 (1440×900) ──');
await runCaptures({ width: 1440, height: 900 }, '');

// 手机端（iPhone 14 尺寸）
console.log('\n── 手机端 (390×844) ──');
await runCaptures({ width: 390, height: 844 }, 'mobile');

console.log(`\n✓ 全部截图已保存至 ${OUT}`);
