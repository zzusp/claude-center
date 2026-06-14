// 能力自检 + worker.json 持久化/合并的实跑验证。用临时 dataDir,不污染真实 ~/.claude-center。
// 用法:从 worktree 根 `npx tsx docs/acceptance/worker-app-enhancements/scripts/verify-config-capabilities.mts`
// 依赖已构建的 worker dist。
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectCapabilities } from "../../../../apps/worker/dist/inspect.js";

let pass = 0;
let fail = 0;
function check(cond: boolean, msg: string): void {
  if (cond) {
    pass += 1;
    console.log(`PASS: ${msg}`);
  } else {
    fail += 1;
    console.error(`FAIL: ${msg}`);
  }
}

// —— 能力自检 ——
const caps = await detectCapabilities({ ghCommand: "gh", claudeCommand: "claude" } as never);
console.log("capabilities:", JSON.stringify(caps));
check(
  typeof caps.git.ok === "boolean" && typeof caps.gh.ok === "boolean" && typeof caps.claude.ok === "boolean",
  "detectCapabilities 返回 git/gh/claude 三项布尔自检结果"
);

// —— worker.json 持久化/合并(临时 dataDir + 临时 env)——
const tmpDir = mkdtempSync(path.join(os.tmpdir(), "wac-"));
process.env.CLAUDE_CENTER_DATA_DIR = tmpDir;
process.env.CLAUDE_CENTER_PROJECTS = JSON.stringify([{ projectName: "envp", localPath: "E:\\envp" }]);
// 动态 import,确保 config 读取上面设置的 env。
const config = await import("../../../../apps/worker/dist/config.js");

try {
  const initial = config.readWorkerState(tmpDir);
  check(typeof initial.workerId === "string" && initial.workerId.length > 0, "readWorkerState 首次生成稳定 workerId");
  const workerId = initial.workerId;

  config.persistWorkerState(tmpDir, { maxParallel: 3 });
  let state = config.readWorkerState(tmpDir);
  check(state.maxParallel === 3 && state.workerId === workerId, "persistWorkerState 写 maxParallel 且保留 workerId");

  config.persistWorkerState(tmpDir, { projects: [{ projectName: "localp", localPath: "L:\\localp" }] });
  state = config.readWorkerState(tmpDir);
  check(
    state.maxParallel === 3 && (state.projects ?? []).some((p: { projectName?: string }) => p.projectName === "localp"),
    "persistWorkerState 合并写 projects 且保留先前 maxParallel"
  );

  config.persistWorkerState(tmpDir, { allowRemoteControl: true });
  state = config.readWorkerState(tmpDir);
  check(
    state.allowRemoteControl === true && state.maxParallel === 3 && (state.projects ?? []).length === 1,
    "persistWorkerState 再写 allowRemoteControl 不丢 maxParallel/projects"
  );

  const full = config.readWorkerConfig();
  const envLink = full.projects.find((p: { projectName?: string }) => p.projectName === "envp");
  const localLink = full.projects.find((p: { projectName?: string }) => p.projectName === "localp");
  check(!!envLink && envLink.source === "env", "readWorkerConfig 含 env 项目且 source=env");
  check(!!localLink && localLink.source === "local", "readWorkerConfig 含本地项目且 source=local");
  check(full.maxParallel === 3 && full.allowRemoteControl === true, "readWorkerConfig 采用持久化的 maxParallel/allowRemoteControl");

  console.log(`\n结果:${pass} PASS / ${fail} FAIL`);
  if (fail > 0) process.exitCode = 1;
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
