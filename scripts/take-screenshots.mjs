/**
 * 截取 Console 各主要页面真实截图，存入 docs/screenshots/
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

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

// 登录
const loginResp = await ctx.request.post(`${BASE}/api/auth/login`, {
  data: { username, password },
  headers: { 'Content-Type': 'application/json' },
});
if (loginResp.status() !== 200) {
  console.error('login failed:', await loginResp.text());
  await browser.close();
  process.exit(1);
}
console.log('login ok');

// 拿一个任务 ID 用于详情截图
const tasksResp = await ctx.request.get(`${BASE}/api/tasks?limit=1`);
const tasksData = await tasksResp.json();
const firstTaskId = tasksData?.tasks?.[0]?.id;
console.log('first task id:', firstTaskId);

const page = await ctx.newPage();

async function shot(url, name, delay = 2500) {
  await page.goto(`${BASE}${url}`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(delay);
  await page.screenshot({ path: path.join(OUT, name), fullPage: false });
  console.log(`✓ ${name}`);
}

await shot('/', 'overview.png');
await shot('/tasks', 'tasks.png');
if (firstTaskId) {
  await shot(`/tasks/${firstTaskId}`, 'task-detail.png');
}
await shot('/workers', 'workers.png');
await shot('/chat', 'chat.png');

await browser.close();
console.log(`\n截图已保存至 ${OUT}`);
