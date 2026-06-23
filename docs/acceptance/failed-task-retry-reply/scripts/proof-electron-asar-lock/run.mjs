// 证明根因 + 修复：Electron 进程删含 .asar 的 node_modules → 默认会自锁（删不掉）；process.noAsar=true 则删得掉。
// 跑法：node docs/acceptance/failed-task-retry-reply/scripts/proof-electron-asar-lock/run.mjs
import { mkdirSync, copyFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../..");
const electronExe = path.join(repoRoot, "node_modules", "electron", "dist", "electron.exe");
const srcAsar = path.join(repoRoot, "node_modules", "electron", "dist", "resources", "default_app.asar");
const main = path.join(here, "main.cjs");

if (!existsSync(electronExe)) throw new Error(`electron.exe 不存在：${electronExe}`);
if (!existsSync(srcAsar)) throw new Error(`default_app.asar 不存在：${srcAsar}`);

const tmp = path.join(os.tmpdir(), `asar-proof-${Date.now()}`);

function makeTree(mode) {
  const nm = path.join(tmp, mode, "nm");
  const resDir = path.join(nm, "electron", "dist", "resources");
  mkdirSync(resDir, { recursive: true });
  copyFileSync(srcAsar, path.join(resDir, "default_app.asar"));
  writeFileSync(path.join(nm, "filler.txt"), "x"); // 让目录非空，贴近真实
  return nm;
}

function runElectron(mode, nm) {
  const r = spawnSync(electronExe, [main, mode, nm], {
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" }
  });
  const line = (r.stdout || "").split(/\r?\n/).find((l) => l.trim().startsWith("{")) || "";
  let parsed = null;
  try { parsed = JSON.parse(line); } catch { /* */ }
  return { code: r.status, parsed, stderr: (r.stderr || "").slice(-300) };
}

function assert(cond, label) {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`✓ ${label}`);
}

try {
  // —— A) 默认 asar 集成：复现自锁（删不掉）——
  const nmLock = makeTree("lock");
  const a = runElectron("lock", nmLock);
  console.log("lock  →", JSON.stringify(a.parsed), a.stderr ? `(stderr: ${a.stderr})` : "");
  assert(a.parsed != null, "A：lock 模式 electron 跑通并有结果");
  assert(a.parsed.ok === false && a.parsed.exists === true, "A：默认 asar 集成下 Electron 删不掉含 .asar 的目录（复现自锁）");
  assert(/EBUSY|EPERM|ENOTEMPTY|resource busy|locked|perm/i.test(a.parsed.err), `A：失败原因是占用/锁（${a.parsed.err}）`);

  // —— B) process.noAsar=true：修复（删得掉）——
  const nmFix = makeTree("noasar");
  const b = runElectron("noasar", nmFix);
  console.log("noasar→", JSON.stringify(b.parsed), b.stderr ? `(stderr: ${b.stderr})` : "");
  assert(b.parsed != null, "B：noasar 模式 electron 跑通并有结果");
  assert(b.parsed.ok === true && b.parsed.exists === false, "B：process.noAsar=true 后 Electron 能删掉含 .asar 的目录（修复生效）");

  console.log("\nPROVED: Electron asar 集成会自锁 .asar 导致删不掉；process.noAsar=true 解锁。");
} finally {
  try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best-effort */ }
}
