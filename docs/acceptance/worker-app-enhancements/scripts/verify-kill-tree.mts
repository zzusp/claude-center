// killProcessTree 实跑验证:spawn 一个长时 powershell Start-Sleep,杀进程树,断言被终结。
// 用法:从 worktree 根 `npx tsx docs/acceptance/worker-app-enhancements/scripts/verify-kill-tree.mts`
// 依赖已构建的 worker dist(`npm -w @claude-center/worker run build`)。
import { spawn } from "node:child_process";
import { killProcessTree } from "../../../../apps/worker/dist/shell.js";

function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const child = spawn("powershell", ["-NoProfile", "-Command", "Start-Sleep -Seconds 60"], { windowsHide: true });
let exited = false;
child.on("exit", () => {
  exited = true;
});
const pid = child.pid;
console.log("spawned pid:", pid);

await sleep(800);
const aliveBefore = isAlive(pid);
console.log("alive before kill:", aliveBefore);

killProcessTree(child);
await sleep(2000);

const aliveAfter = isAlive(pid);
console.log("alive after kill:", aliveAfter, "| exit event fired:", exited);

if (aliveBefore && !aliveAfter) {
  console.log("PASS: killProcessTree 终结了进程");
} else {
  console.error("FAIL: 进程未按预期被终结");
  process.exitCode = 1;
}
