// 镜像 apps/worker/src/executor.ts:runClaudeJson 的 --model 拼接逻辑（两分支），
// 断言三种 model 输入的命令形态。源码为权威，此脚本仅印证逻辑。
// runClaudeJson 未导出，故此处复刻其拼接表达式逐字对齐。

type Opts = { prompt: string; resumeSessionId?: string; model?: string };

const PERMISSION = "bypassPermissions";
const SETTINGS = "C:/app/settings.json";
const RULES = "C:/app/rules.md";

// 复刻 executor.ts 的 modelArg
function modelArgOf(opts: Opts): string | null {
  return opts.model && opts.model !== "default" ? opts.model : null;
}

// 复刻直接 runCommand 分支的 argv
function buildArgv(opts: Opts): string[] {
  const modelArg = modelArgOf(opts);
  return [
    "-p",
    opts.prompt,
    ...(modelArg ? ["--model", modelArg] : []),
    ...(opts.resumeSessionId ? ["--resume", opts.resumeSessionId] : []),
    "--permission-mode",
    PERMISSION,
    "--settings",
    SETTINGS,
    "--append-system-prompt-file",
    RULES,
    "--output-format",
    "json"
  ];
}

// 复刻 PowerShell 分支命令尾部（model + resume 拼接顺序）
function buildPwshTail(opts: Opts): string {
  const modelArg = modelArgOf(opts);
  return `--output-format json${modelArg ? ` --model ${modelArg}` : ""}${
    opts.resumeSessionId ? ` --resume ${opts.resumeSessionId}` : ""
  }`;
}

let pass = true;
function check(name: string, cond: boolean, detail: string) {
  if (!cond) pass = false;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}  ${detail}`);
}

// opus -> 含 --model opus
const a1 = buildArgv({ prompt: "p", model: "opus" });
check("argv opus", a1.join(" ").includes("--model opus"), a1.join(" "));
check("pwsh opus", buildPwshTail({ prompt: "p", model: "opus" }).includes("--model opus"), buildPwshTail({ prompt: "p", model: "opus" }));

// default -> 不传 --model
const a2 = buildArgv({ prompt: "p", model: "default" });
check("argv default no --model", !a2.includes("--model"), a2.join(" "));
check("pwsh default no --model", !buildPwshTail({ prompt: "p", model: "default" }).includes("--model"), buildPwshTail({ prompt: "p", model: "default" }));

// undefined（旧任务/未设）-> 不传 --model
const a3 = buildArgv({ prompt: "p" });
check("argv undefined no --model", !a3.includes("--model"), a3.join(" "));

// sonnet + resume -> --model 在 --resume 之前
const a4 = buildArgv({ prompt: "p", model: "sonnet", resumeSessionId: "uuid-1" });
const mi = a4.indexOf("--model");
const ri = a4.indexOf("--resume");
check("argv sonnet+resume order", mi !== -1 && ri !== -1 && mi < ri && a4[mi + 1] === "sonnet", a4.join(" "));

console.log(pass ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(pass ? 0 : 1);
