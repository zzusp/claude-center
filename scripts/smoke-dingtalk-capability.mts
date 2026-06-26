import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectCapabilities } from "../apps/worker/dist/inspect.js";

let pass = 0, fail = 0;
const check = (cond, msg) => { if (cond) { pass++; console.log("PASS:", msg); } else { fail++; console.error("FAIL:", msg); } };

// 1) 禁用 → dingtalk 槽位缺失（不污染统计/不上报）
let caps = await detectCapabilities({ ghCommand: "gh", claudeCommand: "claude", dingtalkEnabled: false, dingtalkCommand: "anything" });
check(caps.dingtalk === undefined, "dingtalkEnabled=false 时 capabilities.dingtalk 缺席");

// 2) 启用 + 命令为空 → 槽位存在但 ok=false（自检结果为缺失，提示用户配置命令）
caps = await detectCapabilities({ ghCommand: "gh", claudeCommand: "claude", dingtalkEnabled: true, dingtalkCommand: "" });
check(caps.dingtalk !== undefined && caps.dingtalk.ok === false, "dingtalkEnabled=true、命令空 → 槽位 ok=false");

// 3) 启用 + 命令指向已装 CLI（git --version 永远 ok）→ 槽位 ok=true、版本回填
caps = await detectCapabilities({ ghCommand: "gh", claudeCommand: "claude", dingtalkEnabled: true, dingtalkCommand: "git" });
check(caps.dingtalk !== undefined && caps.dingtalk.ok === true && typeof caps.dingtalk.version === "string" && caps.dingtalk.version.length > 0, "dingtalkEnabled=true、命令=git → 槽位 ok=true 且回填 version");

// 4) 持久化往返
const tmpDir = mkdtempSync(path.join(os.tmpdir(), "dt-"));
process.env.CLAUDE_CENTER_DATA_DIR = tmpDir;
const config = await import("../apps/worker/dist/config.js");
try {
  config.readWorkerState(tmpDir);
  config.persistWorkerState(tmpDir, { dingtalkEnabled: true, dingtalkCommand: "dingtalk" });
  const full = config.readWorkerConfig();
  check(full.dingtalkEnabled === true && full.dingtalkCommand === "dingtalk", "worker.json 持久化 dingtalkEnabled/dingtalkCommand 往返一致");
} finally { rmSync(tmpDir, { recursive: true, force: true }); }

console.log(`\n结果:${pass} PASS / ${fail} FAIL`);
process.exitCode = fail > 0 ? 1 : 0;
