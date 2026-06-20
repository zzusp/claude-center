// 渲染 terminal-anim.html → terminal.mp4（Playwright 逐帧截图 + ffmpeg 合成）
// 用法：
//   node render-terminal.mjs preview   只出一帧 terminal-preview.png（确认视觉）
//   node render-terminal.mjs           出完整 terminal.mp4
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const htmlUrl = pathToFileURL(path.join(dir, 'terminal-anim.html')).href + '?mode=seek';
const framesDir = path.join(dir, '.frames');
const outMp4 = path.join(dir, 'terminal.mp4');
const previewPng = path.join(dir, 'terminal-preview.png');

const FPS = 30, DURATION = 6.4, W = 1920, H = 1080, SCALE = 2;
const mode = process.argv[2] || 'video';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE });
await page.goto(htmlUrl);
await page.evaluate(() => document.fonts.ready);

if (mode === 'preview') {
  await page.evaluate(t => window.__seek(t), 5.9);
  await page.screenshot({ path: previewPng });
  await browser.close();
  console.log('PREVIEW ->', previewPng);
} else {
  if (existsSync(framesDir)) rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });
  const total = Math.round(FPS * DURATION);
  for (let i = 0; i < total; i++) {
    const t = i / FPS;
    await page.evaluate(t => window.__seek(t), t);
    await page.screenshot({ path: path.join(framesDir, 'f' + String(i).padStart(4, '0') + '.png') });
  }
  await browser.close();
  execFileSync('ffmpeg', ['-y', '-framerate', String(FPS), '-i', path.join(framesDir, 'f%04d.png'),
    '-vf', 'scale=' + W + ':' + H + ':flags=lanczos', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-crf', '18', '-movflags', '+faststart', outMp4], { stdio: 'inherit' });
  rmSync(framesDir, { recursive: true, force: true });
  console.log('VIDEO ->', outMp4);
}
