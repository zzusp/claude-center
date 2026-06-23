// 在真实 Electron 主进程里复现 / 验证：删含 .asar 的 node_modules 树。
// argv[2]=mode('lock'|'noasar')  argv[3]=要删的根目录
// lock  ：默认 asar 集成开启 → 触发 asar 缓存后 rmSync → 期望删不掉（复现自锁）
// noasar：process.noAsar=true → asar 当普通文件 → 期望删干净（验证修复）
const fs = require("node:fs");
const path = require("node:path");

const mode = process.argv[2];
const root = process.argv[3];
if (mode === "noasar") process.noAsar = true;

const asar = path.join(root, "electron", "dist", "resources", "default_app.asar");
// 触发 Electron asar 集成：把 .asar 当目录访问其内部文件 → Electron 打开并进程级缓存该归档。
try { fs.statSync(path.join(asar, "package.json")); } catch { /* noasar 下当普通文件、内部路径不存在，忽略 */ }

let ok = false, err = "";
try {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  ok = !fs.existsSync(root);
} catch (e) {
  err = `${e.code} ${String(e.message).slice(0, 120)}`;
}
process.stdout.write(JSON.stringify({ mode, ok, exists: fs.existsSync(root), err }) + "\n");
process.exit(ok ? 0 : 1);
