/**
 * 用 Playwright Electron API 截取 Worker 桌面端截图
 * 用法: node scripts/take-worker-screenshot.mjs
 * 前置: Worker dist 已构建（npm -w @claude-center/worker run build）
 */
import { _electron as electron } from 'playwright';
import { mkdir } from 'fs/promises';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const WORKER_MAIN = path.join(ROOT, 'apps', 'worker', 'dist', 'main.js');

function loadEnv() {
  const env = readFileSync(path.join(ROOT, '.env'), 'utf8');
  const result = {};
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) result[m[1]] = m[2].trim();
  }
  return result;
}

await mkdir(OUT, { recursive: true });

const app = await electron.launch({
  args: [WORKER_MAIN],
  env: { ...process.env, ...loadEnv() },
  cwd: path.join(ROOT, 'apps', 'worker'),
});

const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(5000);

async function nav(dataNav, filename, delay = 1500) {
  await win.click(`button[data-nav="${dataNav}"]`);
  await win.waitForTimeout(delay);
  await win.screenshot({ path: path.join(OUT, filename) });
  console.log(`✓ ${filename}`);
}

// 总览（默认激活）
await win.screenshot({ path: path.join(OUT, 'worker-app.png') });
console.log('✓ worker-app.png');

await nav('tasks',         'worker-tasks.png');
await nav('projects',      'worker-projects.png');
await nav('settings',      'worker-settings.png');

await app.close();
console.log(`\n截图已保存至 ${OUT}`);
