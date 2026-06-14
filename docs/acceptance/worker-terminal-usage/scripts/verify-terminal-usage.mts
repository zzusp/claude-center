// 运行终端 + 运行环境/用量 特性的 headless 实跑验证。对已构建的 worker dist 断言:
//   1. terminal.ts 按 shell 家族拼 claude 脚本/launch（不真跑 claude,断言拼接正确）
//   2. inspectOs / detectTerminals 实跑本机
//   3. config round-trip：terminalCommand / claudePreCommand 持久化 + env 兜底 + 持久化优先
// 用法（从 worktree 根，dist 已构建）：
//   npx tsx docs/acceptance/worker-terminal-usage/scripts/verify-terminal-usage.mts
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildClaudeScript,
  defaultTerminalCommand,
  isWsl,
  shellFamily,
  terminalLaunch
} from "../../../../apps/worker/dist/terminal.js";
import { detectTerminals, inspectOs } from "../../../../apps/worker/dist/inspect.js";

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

// —— 1. shell 家族判定 ——
check(shellFamily("powershell.exe") === "powershell", "shellFamily: powershell.exe → powershell");
check(shellFamily("pwsh") === "powershell", "shellFamily: pwsh → powershell");
check(shellFamily("cmd.exe") === "cmd", "shellFamily: cmd.exe → cmd");
check(shellFamily("C:\\Program Files\\Git\\bin\\bash.exe") === "bash", "shellFamily: git bash → bash");
check(shellFamily("wsl") === "bash", "shellFamily: wsl → bash");

// —— 2. buildClaudeScript 各家族 ——
const psFull = buildClaudeScript({
  family: "powershell",
  full: true,
  modelArg: "opus",
  resumeSessionId: "11111111-2222-3333-4444-555555555555",
  permissionMode: "bypassPermissions",
  preCommand: "& 'C:\\vpn.exe' connect"
});
check(psFull.startsWith("& 'C:\\vpn.exe' connect; "), "PS脚本: 前置命令在前 + 分号分隔");
check(psFull.includes("& $env:CLAUDE_CENTER_CLAUDE_CMD -p $env:CLAUDE_CENTER_PROMPT"), "PS脚本: 调用 + prompt 用 $env: 引用");
check(psFull.includes("--settings $env:CLAUDE_CENTER_SETTINGS_PATH"), "PS脚本: settings 路径 env 引用");
check(psFull.includes("--append-system-prompt-file $env:CLAUDE_CENTER_RULES_PATH"), "PS脚本: rules 路径 env 引用");
check(psFull.includes("--permission-mode bypassPermissions") && psFull.includes("--output-format json"), "PS脚本: 安全字面量内联");
check(psFull.includes("--model opus") && psFull.includes("--resume 11111111-2222-3333-4444-555555555555"), "PS脚本: model/resume 内联");

const bashFull = buildClaudeScript({
  family: "bash",
  full: true,
  modelArg: null,
  permissionMode: "bypassPermissions",
  preCommand: "source ~/login.sh"
});
check(bashFull.startsWith("source ~/login.sh; "), "bash脚本: 前置命令在前 + 分号分隔");
check(bashFull.includes('"$CLAUDE_CENTER_CLAUDE_CMD" -p "$CLAUDE_CENTER_PROMPT"'), "bash脚本: 调用 + prompt 用 \"$VAR\" 引用");
check(bashFull.includes('--settings "$CLAUDE_CENTER_SETTINGS_PATH"'), "bash脚本: settings 路径 \"$VAR\" 引用");
check(!bashFull.includes("--model"), "bash脚本: modelArg=null 不带 --model");

const cmdFull = buildClaudeScript({
  family: "cmd",
  full: true,
  modelArg: null,
  permissionMode: "bypassPermissions",
  preCommand: "set HTTPS_PROXY=http://127.0.0.1:10808"
});
check(cmdFull.includes("set HTTPS_PROXY=http://127.0.0.1:10808 & "), "cmd脚本: 前置命令在前 + & 分隔");
check(cmdFull.includes("%CLAUDE_CENTER_CLAUDE_CMD% -p %CLAUDE_CENTER_PROMPT%"), "cmd脚本: 调用 + prompt 用 %VAR% 引用");

const direct = buildClaudeScript({
  family: "powershell",
  full: false,
  modelArg: null,
  permissionMode: "bypassPermissions",
  preCommand: ""
});
check(!direct.includes("--settings") && !direct.includes("--output-format") && !direct.includes("--permission-mode"), "定向指令(full=false): 不带安全姿态/json");
check(direct === "& $env:CLAUDE_CENTER_CLAUDE_CMD -p $env:CLAUDE_CENTER_PROMPT", "定向指令(无前置命令): 仅 -p");

// —— 3. terminalLaunch / isWsl ——
const psLaunch = terminalLaunch("powershell", "SCRIPT");
check(psLaunch.cmd === "powershell" && psLaunch.args.includes("-Command") && psLaunch.args[psLaunch.args.length - 1] === "SCRIPT", "launch: powershell -Command <script>");
const cmdLaunch = terminalLaunch("cmd.exe", "SCRIPT");
check(cmdLaunch.args[cmdLaunch.args.length - 2] === "/c" && cmdLaunch.args[cmdLaunch.args.length - 1] === "SCRIPT", "launch: cmd /c <script>");
const bashLaunch = terminalLaunch("C:\\Program Files\\Git\\bin\\bash.exe", "SCRIPT");
check(bashLaunch.args[0] === "-lc" && bashLaunch.args[1] === "SCRIPT", "launch: bash -lc <script>");
const wslLaunch = terminalLaunch("wsl.exe", "SCRIPT");
check(wslLaunch.args[0] === "bash" && wslLaunch.args[1] === "-lc" && wslLaunch.args[2] === "SCRIPT", "launch: wsl bash -lc <script>");
check(isWsl("wsl.exe") === true && isWsl("bash.exe") === false, "isWsl: 仅 wsl 命中");
check(typeof defaultTerminalCommand() === "string" && defaultTerminalCommand().length > 0, "defaultTerminalCommand 非空");

// —— 4. inspectOs / detectTerminals 实跑 ——
const osInfo = inspectOs();
console.log("os:", JSON.stringify(osInfo));
check(osInfo.platform === process.platform && osInfo.label.length > 0, "inspectOs: platform 正确 + label 非空");

const terminals = await detectTerminals();
console.log("terminals:", JSON.stringify(terminals.map((t) => ({ name: t.name, command: t.command }))));
check(Array.isArray(terminals), "detectTerminals 返回数组");
if (process.platform === "win32") {
  check(terminals.length >= 1, "Windows: 至少检测到一个终端");
  check(terminals.every((t) => typeof t.command === "string" && t.command.length > 0 && t.family), "检测项均有 command 全路径 + family");
}

// —— 5. config round-trip（临时 dataDir，不污染真实 ~/.claude-center）——
const config = await import("../../../../apps/worker/dist/config.js");

// 5a. env 兜底：未持久化 terminalCommand 时取 env。
const tmpA = mkdtempSync(path.join(os.tmpdir(), "wtu-a-"));
process.env.CLAUDE_CENTER_DATA_DIR = tmpA;
process.env.CLAUDE_CENTER_TERMINAL = "C:\\envterm\\pwsh.exe";
process.env.CLAUDE_CENTER_CLAUDE_PRE_COMMAND = "echo from-env";
try {
  config.readWorkerState(tmpA); // 生成 workerId（不含 terminalCommand）
  const c = config.readWorkerConfig();
  check(c.terminalCommand === "C:\\envterm\\pwsh.exe", "config: 未持久化时 terminalCommand 取 env");
  check(c.claudePreCommand === "echo from-env", "config: 未持久化时 claudePreCommand 取 env");
} finally {
  rmSync(tmpA, { recursive: true, force: true });
}

// 5b. 持久化优先 + 合并保留：worker.json 的值覆盖 env，且与既有字段共存。
const tmpB = mkdtempSync(path.join(os.tmpdir(), "wtu-b-"));
process.env.CLAUDE_CENTER_DATA_DIR = tmpB;
try {
  config.readWorkerState(tmpB);
  config.persistWorkerState(tmpB, { maxParallel: 4 });
  config.persistWorkerState(tmpB, { terminalCommand: "C:\\Tools\\bash.exe", claudePreCommand: "source ~/proxy.sh" });
  const state = config.readWorkerState(tmpB);
  check(state.terminalCommand === "C:\\Tools\\bash.exe" && state.maxParallel === 4, "config: 持久化 terminalCommand 且保留先前 maxParallel");
  const c = config.readWorkerConfig();
  check(c.terminalCommand === "C:\\Tools\\bash.exe", "config: 持久化值覆盖 env(terminalCommand)");
  check(c.claudePreCommand === "source ~/proxy.sh", "config: 持久化值覆盖 env(claudePreCommand)");
} finally {
  rmSync(tmpB, { recursive: true, force: true });
}

console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
if (fail > 0) process.exitCode = 1;
