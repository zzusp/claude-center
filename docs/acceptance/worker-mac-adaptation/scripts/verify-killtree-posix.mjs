#!/usr/bin/env node
// POSIX 进程树 kill 验证（M1 修复）：证明取消任务时 claude 及其【孙进程】都被杀，不泄漏。
//
// 机制：runCommand 起一个 bash（直接子进程），bash 内 `sleep 300 &` 派生一个后台孙进程。
//  · newProcessGroup:true  → 子进程成新进程组组长，killProcessTree 的 process.kill(-pid) 命中整组 → 子+孙都死。
//  · newProcessGroup:false → 子进程继承父进程组，-pid ESRCH → 回退 child.kill 只杀直接子进程 → 孙进程泄漏（旧 bug）。
//
// 用法：node docs/acceptance/worker-mac-adaptation/scripts/verify-killtree-posix.mjs
//       node docs/acceptance/worker-mac-adaptation/scripts/verify-killtree-posix.mjs --check   # 零副作用自检
// 退出码：0 = 修复生效（newProcessGroup 杀净 + 对照组确实泄漏）；非 0 = 断言失败。
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const shellMod = resolve(repoRoot, "apps/worker/dist/shell.js");

if (process.argv.includes("--check")) {
  console.log("[check] verify-killtree-posix 计划：");
  console.log("  - import", shellMod);
  console.log("  - 起 bash(子) → sleep 300 &(孙)，两种 newProcessGroup 模式各跑一次");
  console.log("  - killProcessTree 后用 process.kill(pid,0) 探活，断言：fix 模式子+孙皆死；对照模式孙泄漏");
  console.log("  - 末尾清理任何泄漏的孙进程，零残留");
  process.exit(0);
}

const { runCommand, killProcessTree } = await import(shellMod);

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // 存在但非本用户（这里都是本用户，故 ESRCH=已死）
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 跑一轮：返回 {childPid, grandPid, childAliveAfter, grandAliveAfter}
async function runCase(newProcessGroup) {
  let childHandle = null;
  let grandPid = 0;
  // bash 内：后台起 1 个 sleep(孙) 打印其 pid，再 `wait` 阻塞在该后台任务上（保持子进程存活直到被杀）。
  // 用 wait 而非再起一个前台 sleep——避免 control 模式下 bash 被 child.kill 后多留一个无法追踪的前台 sleep。
  const script = "sleep 300 & echo GC=$!; wait";
  const promise = runCommand("bash", ["-c", script], {
    newProcessGroup,
    timeoutMs: 60_000,
    onSpawn: (c) => {
      childHandle = c;
      c.stdout?.on("data", (d) => {
        const m = String(d).match(/GC=(\d+)/);
        if (m) grandPid = Number(m[1]);
      });
    }
  }).catch(() => {}); // 被 kill 后会 reject，吞掉

  // 等子进程起来 + 打印出孙进程 pid
  for (let i = 0; i < 50 && !grandPid; i += 1) await sleep(100);
  const childPid = childHandle?.pid ?? 0;
  if (!childPid || !grandPid) throw new Error(`子/孙进程未就绪 childPid=${childPid} grandPid=${grandPid}`);

  const childAliveBefore = alive(childPid);
  const grandAliveBefore = alive(grandPid);

  // 执行树 kill（取消任务时的真实调用）
  killProcessTree(childHandle);
  await sleep(800); // 等信号生效

  const childAliveAfter = alive(childPid);
  const grandAliveAfter = alive(grandPid);
  await promise;

  // 清理：无论结果如何，确保不留残留
  for (const pid of [childPid, grandPid]) {
    if (alive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
    }
  }
  return { newProcessGroup, childPid, grandPid, childAliveBefore, grandAliveBefore, childAliveAfter, grandAliveAfter };
}

const fix = await runCase(true);
const control = await runCase(false);

console.log("=== fix (newProcessGroup:true) ===");
console.log(JSON.stringify(fix));
console.log("=== control (newProcessGroup:false, 旧行为) ===");
console.log(JSON.stringify(control));

const failures = [];
// 修复模式：子 + 孙 都必须被杀
if (!fix.childAliveBefore || !fix.grandAliveBefore) failures.push("fix: 起始时子/孙未存活，用例无效");
if (fix.childAliveAfter) failures.push("fix: killProcessTree 后子进程仍存活");
if (fix.grandAliveAfter) failures.push("fix: killProcessTree 后【孙进程泄漏】——进程组 kill 未生效");
// 对照模式：复现旧 bug（孙进程泄漏），证明修复确实必要；若对照组也不泄漏说明用例无区分度
if (!control.grandAliveAfter) failures.push("control: 旧行为下孙进程未泄漏——用例无法区分修复价值（环境异常？）");

if (failures.length) {
  console.error("\n[FAIL]");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("\n[PASS] newProcessGroup 杀净子+孙；对照组复现孙进程泄漏（证明修复必要且生效）。");
process.exit(0);
