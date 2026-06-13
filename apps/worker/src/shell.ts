import { spawn } from "node:child_process";

export type CommandResult = {
  command: string;
  args: string[];
  cwd?: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

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
  options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; shell?: boolean } = {}
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: options.shell ?? process.platform === "win32",
      windowsHide: true,
      env: options.env ?? process.env
    });

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

      if (result.exitCode === 0) {
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

export function runPowerShell(
  script: string,
  options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<CommandResult> {
  // Spawn PowerShell directly (shell: false) so the script reaches it as a
  // single argv element — going through cmd.exe (shell: true) would re-parse
  // embedded quotes / `;` / `&` and corrupt it.
  return runCommand("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? 20 * 60_000,
    env: options.env,
    shell: false
  });
}
