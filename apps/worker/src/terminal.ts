import path from "node:path";

// 运行终端抽象:把「在某终端里跑前置命令 + 调 claude」所需的、按 shell 家族而异的语法
// （env 引用 / 语句分隔符 / 内联脚本参数）收敛到一处,供 executor 拼脚本、inspect 检测、
// config 取默认值复用。家族判定靠终端可执行文件名,prompt/路径经 env 传入并安全引用。

export type ShellFamily = "powershell" | "cmd" | "bash";

// claude 调用里经环境变量传入的动态值(prompt/路径含空格/换行,直接内联会被 shell 破坏)。
// executor 设置这些 env,脚本里按家族引用;headless 测试据此断言拼接正确。
export const CLAUDE_ENV = {
  CMD: "CLAUDE_CENTER_CLAUDE_CMD",
  PROMPT: "CLAUDE_CENTER_PROMPT",
  SETTINGS: "CLAUDE_CENTER_SETTINGS_PATH",
  RULES: "CLAUDE_CENTER_RULES_PATH"
} as const;

// 终端文件名(去 .exe)→ shell 家族。powershell/pwsh/未识别 在 Windows 归 powershell（$env: 引用对
// 多行值最安全）、其余平台归 bash;cmd 单列;bash/sh/zsh/dash/wsl 归 bash。
export function shellFamily(command: string): ShellFamily {
  const base = path.basename(command).toLowerCase().replace(/\.exe$/, "");
  if (base === "cmd") return "cmd";
  if (["bash", "sh", "zsh", "dash", "wsl"].includes(base)) return "bash";
  if (base === "powershell" || base === "pwsh") return "powershell";
  return process.platform === "win32" ? "powershell" : "bash";
}

// 空配置时的默认终端:Windows=powershell,其余=bash。
export function defaultTerminalCommand(): string {
  return process.platform === "win32" ? "powershell" : "bash";
}

// 在脚本里引用环境变量的取值(含空格/多行不被分词)。
export function envRef(family: ShellFamily, name: string): string {
  if (family === "powershell") return `$env:${name}`;
  if (family === "cmd") return `%${name}%`;
  return `"$${name}"`;
}

// 以「存于环境变量的可执行文件路径」为命令发起调用(处理含空格路径)。
export function invokeRef(family: ShellFamily, name: string): string {
  if (family === "powershell") return `& $env:${name}`; // & 调用操作符
  if (family === "cmd") return `%${name}%`;
  return `"$${name}"`;
}

// 前置命令与 claude 调用之间的语句分隔符。
export function statementSep(family: ShellFamily): string {
  return family === "cmd" ? " & " : "; ";
}

// 把「<前置命令> <sep> <要在终端里跑的命令>」拼成一段在所选终端会话里顺序执行的脚本（前置命令可空）。
// 前置命令先行，故它设置的环境（代理 / VPN / 登录）会被后面的命令继承；二者按所选终端家族的语法书写。
// buildClaudeScript（claude 调用）与定向 shell 指令共用此拼接，避免各写一份。
export function buildTerminalScript(family: ShellFamily, preCommand: string, command: string): string {
  return preCommand ? `${preCommand}${statementSep(family)}${command}` : command;
}

export type ClaudeScriptOpts = {
  family: ShellFamily;
  // true=任务执行(带 settings/rules/permission-mode/output json);false=定向 claude 指令(仅 -p)。
  full: boolean;
  modelArg: string | null;
  resumeSessionId?: string;
  permissionMode: string;
  // 已 trim 的前置命令,可能为空(自定义终端但无前置命令时只跑 claude)。
  preCommand: string;
};

// 渲染「<前置命令> <sep> <claude 调用>」脚本。modelArg/session-id(UUID)/permission-mode/output-format
// 是无 shell 元字符的安全字面量,内联;CLAUDE_CMD/PROMPT/路径经 env 引用。
export function buildClaudeScript(o: ClaudeScriptOpts): string {
  const parts = [invokeRef(o.family, CLAUDE_ENV.CMD), "-p", envRef(o.family, CLAUDE_ENV.PROMPT)];
  if (o.modelArg) parts.push("--model", o.modelArg);
  if (o.resumeSessionId) parts.push("--resume", o.resumeSessionId);
  if (o.full) {
    parts.push(
      "--permission-mode",
      o.permissionMode,
      "--settings",
      envRef(o.family, CLAUDE_ENV.SETTINGS),
      "--append-system-prompt-file",
      envRef(o.family, CLAUDE_ENV.RULES),
      "--output-format",
      "json"
    );
  }
  const call = parts.join(" ");
  return buildTerminalScript(o.family, o.preCommand, call);
}

// 把脚本以内联方式交给终端执行:返回 spawn 用的 {cmd,args}(script 作为末参)。
// wsl 特殊:`wsl bash -lc <script>`（wsl 不接 -lc,需显式 bash）;其余按家族。
export function terminalLaunch(command: string, script: string): { cmd: string; args: string[] } {
  const base = path.basename(command).toLowerCase().replace(/\.exe$/, "");
  if (base === "wsl") {
    return { cmd: command, args: ["bash", "-lc", script] };
  }
  const family = shellFamily(command);
  if (family === "powershell") {
    return { cmd: command, args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script] };
  }
  if (family === "cmd") {
    return { cmd: command, args: ["/d", "/s", "/c", script] };
  }
  return { cmd: command, args: ["-lc", script] };
}

// WSL 不继承 Windows 进程 env,需在 WSLENV 声明转发的变量名(冒号分隔)。
export function isWsl(command: string): boolean {
  return path.basename(command).toLowerCase().replace(/\.exe$/, "") === "wsl";
}
