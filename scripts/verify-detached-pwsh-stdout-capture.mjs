#!/usr/bin/env node
// 真机 e2e：用 worker 包构建产物里的 runCommand，按生产对话轮的完全相同配置
//   detached:true + newProcessGroup（POSIX 不影响 win32）+ stdoutLogFile + windowsHide
// 在 Windows + PowerShell 的 terminal 形态下，确认 mock claude 的 stdout 能落到日志文件。
//
// 历史：detached:true 在 win32 上被 Node 翻成 DETACHED_PROCESS，pwsh 启动后立刻退 0 不执行
// 脚本体 → stdout log 文件 0 字节 → 对话轮永远落到「无完整结果」失败文案（即用户报的「实时对话报错」
// claude-center发版 turn dce0e785-... error_message="stdout 日志文件为空（detached + ignore 退化或
// claude 静默退出）"）。修复：win32 下 spawn 不再传 detached:true，靠 child.unref() + Windows
// 默认「父退子活」达成同样语义。
import { runCommand } from "../apps/worker/dist/shell.js";
import { buildClaudeScript, terminalLaunch, CLAUDE_ENV } from "../apps/worker/dist/terminal.js";
import { mkdirSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const mockClaude = path.join(repoRoot, "scripts/mock-claude-echo.cjs");
const tmpDir = path.join(repoRoot, ".tmp-verify-detached-pwsh");
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });
const logFile = path.join(tmpDir, ".claude", "claude-turn-test.log");
mkdirSync(path.dirname(logFile), { recursive: true });

// 真机 worker 配置（来自 DB workers 表，company-pc）：
const terminalCommand = process.platform === "win32"
  ? "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
  : "bash";
const preCommand = process.platform === "win32"
  ? '$env:http_proxy="http://127.0.0.1:10808"'
  : 'export http_proxy=http://127.0.0.1:10808';

// 跟 executor.spawnClaude 的 terminal-form 分支一样：buildClaudeScript + terminalLaunch
const family = process.platform === "win32" ? "powershell" : "bash";
const script = buildClaudeScript({
  family,
  full: true,
  modelArg: null,
  resumeSessionId: undefined,
  permissionMode: "default",
  preCommand
});
console.log("[verify] terminal:", terminalCommand);
console.log("[verify] script:", script);

const launch = terminalLaunch(terminalCommand, script);

// mock claude 被 buildClaudeScript 通过 env CLAUDE_CENTER_CLAUDE_CMD 引用；它需要是单一可执行文件。
// 为了让 pwsh `& $env:CLAUDE_CENTER_CLAUDE_CMD` 能跑 mock，用 node 作为 wrapper 走 .cmd shim 不便，
// 改造：把 CLAUDE_CMD 指向 node.exe 本身，把 mockClaude 路径与 -p prompt 等都塞 env 里然后 script 里
// 转化为 argv。但更稳的是另写一个简短的 .cmd / 直接用一个 .bat 来包 node。
// 简化：因为 mock-claude-echo.cjs 是 node script，且 -p <prompt> argv 模拟 claude 的真行为，我们把
// CLAUDE_CENTER_CLAUDE_CMD 指向 node.exe，但这会让 buildClaudeScript 拼出 `& node -p $prompt`，缺
// mockClaude 文件名。所以这里改走"伪 wrapper"思路：写一个一次性 batch 文件作为 CLAUDE_CMD，里头
// 转发到 node mockClaude。
const wrapperBat = path.join(tmpDir, "fake-claude.cmd");
const wrapperContent = `@echo off\r\nnode "${mockClaude}" %*\r\n`;
const fs = await import("node:fs");
fs.writeFileSync(wrapperBat, wrapperContent);

const env = {
  ...process.env,
  [CLAUDE_ENV.CMD]: wrapperBat,
  [CLAUDE_ENV.PROMPT]: "hello e2e from verify-detached-pwsh-stdout-capture",
  [CLAUDE_ENV.SETTINGS]: path.join(tmpDir, "fake-settings.json"),
  [CLAUDE_ENV.RULES]: path.join(tmpDir, "fake-rules.md"),
  CLAUDE_CENTER_MAIN_REPO: repoRoot
};
fs.writeFileSync(env[CLAUDE_ENV.SETTINGS], "{}");
fs.writeFileSync(env[CLAUDE_ENV.RULES], "");

const start = Date.now();
let exitOk = false, spawnError = null;
try {
  await runCommand(launch.cmd, launch.args, {
    cwd: tmpDir,
    timeoutMs: 30_000,
    env,
    detached: true,
    stdoutLogFile: logFile,
    newProcessGroup: process.platform !== "win32"
  });
  exitOk = true;
} catch (e) {
  spawnError = e instanceof Error ? e.message : String(e);
}
const elapsed = Date.now() - start;

console.log("\n=== result ===");
console.log("exitOk:", exitOk);
console.log("spawnError:", spawnError);
console.log("elapsed ms:", elapsed);
console.log("log file exists:", existsSync(logFile));
console.log("log file bytes:", existsSync(logFile) ? statSync(logFile).size : -1);
if (existsSync(logFile)) {
  const content = readFileSync(logFile, "utf8");
  console.log("log file content (truncated 600):", JSON.stringify(content.slice(0, 600)));
  // 验证 mock claude 的 JSON 是否能解析、result=mock-result
  try {
    // mock 末尾未必有换行；从末行取最后一个 JSON 对象（生产 recoverFromClaudeJsonOutput 同款逻辑）
    const lines = content.trim().split(/\r?\n/);
    let parsed = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try { parsed = JSON.parse(line); if (parsed && typeof parsed === "object") break; } catch {}
    }
    if (!parsed) {
      // 也试整段
      try { parsed = JSON.parse(content.trim()); } catch {}
    }
    console.log("parsed JSON:", parsed && typeof parsed === "object" ? "OK" : "FAIL");
    if (parsed) {
      console.log("session_id:", parsed.session_id);
      console.log("result:", parsed.result);
      console.log("mock.argv:", JSON.stringify(parsed.mock?.argv));
    }
    const pass =
      exitOk &&
      parsed?.result === "mock-result" &&
      Array.isArray(parsed?.mock?.argv) &&
      parsed.mock.argv.includes("hello e2e from verify-detached-pwsh-stdout-capture");
    console.log("\n" + (pass ? "PASS — fix verified: detached pwsh stdout reaches log file"
                              : "FAIL — fix did not catch all cases"));
    process.exit(pass ? 0 : 1);
  } catch (e) {
    console.log("parse err:", e.message);
    process.exit(2);
  }
} else {
  console.log("\nFAIL — log file missing");
  process.exit(3);
}
