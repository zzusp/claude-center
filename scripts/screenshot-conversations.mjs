import { _electron as electron } from 'playwright-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../');
const ELECTRON_BIN = path.join(ROOT, 'node_modules/electron/dist/electron.exe');
const OUT = path.join(ROOT, 'docs/tmp/shot-conversations.png');

import fs from 'node:fs';
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const app = await electron.launch({
  executablePath: ELECTRON_BIN,
  args: [path.join(ROOT, 'apps/worker')],
  timeout: 30000,
});

// Wait for app to load
await new Promise(r => setTimeout(r, 5000));

const page = app.windows().find(w => !w.url().startsWith('devtools://')) ?? await app.firstWindow();
console.log('windows:', app.windows().map(w => w.url()));

// Click the conversations nav item
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('[data-nav]')].find(b => b.getAttribute('data-nav') === 'conversations');
  if (btn) btn.click();
});
await new Promise(r => setTimeout(r, 800));

await page.screenshot({ path: OUT });
console.log('screenshot saved:', OUT);
await app.close();
