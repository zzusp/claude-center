// 截取一个已合并 GitHub PR 的「头部区域」→ pr-merged.png（Playwright）
// 用法：node render-pr.mjs [PR号]   默认 132
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const PR = process.argv[2] || '132';
const url = `https://github.com/zzusp/claude-center/pull/${PR}`;
const out = path.join(dir, 'pr-merged.png');

const browser = await chromium.launch({ proxy: { server: 'http://127.0.0.1:10808' } });
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 }, deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('text=Merged', { timeout: 30000 }).catch(() => {});

let el = await page.$('#partial-discussion-header');
if (!el) el = await page.$('.gh-header');
if (el) {
  await el.scrollIntoViewIfNeeded();
  await el.screenshot({ path: out });
} else {
  await page.screenshot({ path: out, clip: { x: 0, y: 60, width: 1500, height: 460 } });
}
await browser.close();
console.log('PR SHOT ->', out, '| PR #' + PR + ' |', url);
