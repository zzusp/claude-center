import { spawn, type ChildProcess } from "node:child_process";

export type CommandResult = {
  command: string;
  args: string[];
  cwd?: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

// 杀掉一棵进程树。Worker 取消在途任务时用来终结长时 Claude 进程及其子进程。
// win32:`taskkill /PID <pid> /T /F` 杀整棵树（claude 通过 cmd.exe/powershell 间接拉起,
// 直接 child.kill 杀不到孙子进程）;非 win32:negative pid 杀进程组,失败回退单进程。
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) {
    return;
  }
  if (process.platform === "win32") {
    // taskkill 是独立 exe,无需 shell;windowsHide 避免弹窗。best-effort,失败忽略。
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).on("error", () => {});
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // 进程可能已退出
    }
  }
}

const outputLimit = 80_000;

function appendLimited(current: string, chunk: string): string {
  const next = current + chunk;
  if (next.length <= outputLimit) {
    return next;
  }
  return next.slice(next.length - outputLimit);
}

export function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    shell?: boolean;
    // 暴露子进程句柄给调用方（取消在途任务时 runner 据此杀进程树）。
    onSpawn?: (child: ChildProcess) => void;
    // 把这些非零退出码也视为成功 resolve（少数命令用退出码表达状态而非错误，
    // 如 `git check-ignore -q` 退出 1 表示「未被忽略」）。默认仅 0 算成功。
    acceptExitCodes?: number[];
  } = {}
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      // 默认 shell:false（直接 CreateProcess，不经 cmd.exe）。Windows 下 shell:true 会把 args
      // 用空格拼成命令行交给 cmd.exe 且不给含空格的参数加引号，commit message / PR 标题等被按空格
      // 拆成多个 token（曾导致 `git commit -m "ClaudeCenter task: ..."` 报 pathspec 不匹配）；
      // PR body 含换行更无法经 cmd 承载。本 worker 调用的 git / gh / claude 在标准安装下均为真 .exe，
      // shell:false 可直接 spawn 且 args 原样作为独立 argv 传入。.cmd/.bat 形态需走终端形态（在终端
      // shell 内执行），不依赖此默认。
      cwd: options.cwd,
      shell: options.shell ?? false,
      windowsHide: true,
      env: options.env ?? process.env
    });
    options.onSpawn?.(child);

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill();
          settled = true;
          reject(new Error(`Command timed out: ${command} ${args.join(" ")}`));
        }, options.timeoutMs)
      : null;

    child.stdout?.on("data", (data: Buffer) => {
      stdout = appendLimited(stdout, data.toString("utf8"));
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr = appendLimited(stderr, data.toString("utf8"));
    });

    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    child.on("close", (exitCode) => {
      if (timer) clearTimeout(timer);
      if (settled) {
        return;
      }
      settled = true;
      const result = {
        command,
        args,
        cwd: options.cwd,
        exitCode: exitCode ?? 1,
        stdout,
        stderr
      };

      const accepted = options.acceptExitCodes?.includes(result.exitCode) ?? false;
      if (result.exitCode === 0 || accepted) {
        resolve(result);
      } else {
        reject(new Error(formatCommandFailure(result)));
      }
    });
  });
}

export function formatCommandFailure(result: CommandResult): string {
  const lines = [
    `Command failed: ${result.command} ${result.args.join(" ")}`,
    `Exit code: ${result.exitCode}`
  ];
  if (result.stdout.trim()) {
    lines.push(`stdout:\n${result.stdout.trim()}`);
  }
  if (result.stderr.trim()) {
    lines.push(`stderr:\n${result.stderr.trim()}`);
  }
  return lines.join("\n");
}
