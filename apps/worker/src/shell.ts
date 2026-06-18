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

// 按 pid 杀进程树（重连的对话轮无 ChildProcess 句柄，只有持久化的 pid）。语义同 killProcessTree。
export function killByPid(pid: number): void {
  if (!pid) {
    return;
  }
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).on("error", () => {});
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 进程可能已退出
    }
  }
}

// 取某 pid 的进程「创建时间」(epoch ms)，无该进程返回 null。pid 退出后会被 OS 复用，单看 pid 存活无法区分
// 「还是原来那个进程」还是「pid 被别的进程占了」——创建时间对同一进程的整个生命周期恒定、复用的新进程则不同，
// 故用 (pid, 创建时间) 做进程身份。Win32:Win32_Process.CreationDate；POSIX:ps -o lstart=。
export function getProcessStartTime(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    if (!pid || pid <= 0) {
      resolve(null);
      return;
    }
    const child =
      process.platform === "win32"
        ? spawn(
            "powershell",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; if($p){([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()}`
            ],
            { windowsHide: true }
          )
        : spawn("ps", ["-o", "lstart=", "-p", String(pid)]);
    let out = "";
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    child.on("error", () => resolve(null));
    child.on("close", () => {
      const text = out.trim();
      if (!text) {
        resolve(null);
        return;
      }
      const value = process.platform === "win32" ? Number(text) : Date.parse(text);
      resolve(Number.isFinite(value) ? value : null);
    });
  });
}

// 「pid 当前指向的，仍是我们当初记录的那个进程」：pid 存活 + 创建时间与 startedAt 精确相等。
// startedAt 为 null（未记录到创建时间）时一律返回 false——宁可不重连，也不冒误连/误杀复用 pid 的风险。
export async function isSameProcessAlive(pid: number | null, startedAt: number | null): Promise<boolean> {
  if (pid == null || startedAt == null) {
    return false;
  }
  const now = await getProcessStartTime(pid);
  return now != null && now === startedAt;
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
    // detached:子进程脱离父进程组（stdio:ignore + unref）。父进程（worker）退出后子进程不被杀、继续运行。
    // 用于对话轮的 claude「关机存活」（实测见 docs/spec/conversation-turn-survive-restart.md）。
    // 代价：stdio 被忽略，stdout/stderr 拿不到——detached 调用方靠 .jsonl 取结果，不读 stdout。
    detached?: boolean;
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
      env: options.env ?? process.env,
      // detached 下 stdio 必须 ignore：保留管道会让子进程在父退出后随断管而亡（也是实测结论）。
      detached: options.detached ?? false,
      stdio: options.detached ? "ignore" : undefined
    });
    // detached：从父事件循环 unref，使父（worker）可独立退出而不等子进程；子进程继续后台运行。
    if (options.detached) {
      child.unref();
    }
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
