import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkerConfig } from "./config.js";
import { runCommand } from "./shell.js";
import { shellFamily, type ShellFamily } from "./terminal.js";

// 采集 worker 机器上 Claude Code 的安装/账号信息，上报给中控展示。
// 数据源在 docs/spec/worker-detail-usage-parallel.md 有实测记录，全部容错：拿不到不崩 worker。

export type UsageWindow = { utilization: number; resets_at: string };
export type WorkerUsage = {
  five_hour?: UsageWindow;
  seven_day?: UsageWindow;
  fetched_at?: string;
};

export type ClaudeInspect = {
  claudeVersion: string | null;
  subscriptionType: string;
  usage: WorkerUsage;
};

// 单个外部依赖的可用性自检结果:能否调用 + 解析出的版本号。
export type Capability = { ok: boolean; version: string | null };
// worker 执行任务依赖的三个外部命令的自检结果。registerWorker 用其替换原硬编码 capabilities。
export type Capabilities = { git: Capability; gh: Capability; claude: Capability };

// `claude --version` → "2.1.177 (Claude Code)"，取前导语义版本号。
export async function getClaudeVersion(config: WorkerConfig): Promise<string | null> {
  try {
    const result = await runCommand(config.claudeCommand, ["--version"], { timeoutMs: 15_000 });
    const match = result.stdout.match(/(\d+\.\d+\.\d+(?:[-.\w]*)?)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

// 跑 `<cmd> --version` 自检单个命令:成功(退出 0)即 ok,顺带解析版本号。容错:命令不存在/报错 → {ok:false}。
async function probeCommand(command: string, versionRe = /(\d+\.\d+\.\d+(?:[-.\w]*)?)/): Promise<Capability> {
  try {
    const result = await runCommand(command, ["--version"], { timeoutMs: 15_000 });
    const match = result.stdout.match(versionRe) ?? result.stderr.match(versionRe);
    return { ok: true, version: match?.[1] ?? null };
  } catch {
    return { ok: false, version: null };
  }
}

// 启动时自检 worker 执行任务所需的三个外部命令是否可用。结果上报 DB(Console 可见)+ 桌面 UI 红绿点展示。
export async function detectCapabilities(config: WorkerConfig): Promise<Capabilities> {
  const [git, gh, claude] = await Promise.all([
    probeCommand("git"),
    probeCommand(config.ghCommand),
    probeCommand(config.claudeCommand)
  ]);
  return { git, gh, claude };
}

// worker 所在机器的操作系统概览，桌面端展示用。label 形如 "Windows 10.0.26200 (x64)"。
export type OsInfo = { platform: NodeJS.Platform; release: string; arch: string; label: string };
export function inspectOs(): OsInfo {
  const platform = process.platform;
  const name =
    platform === "win32" ? "Windows" : platform === "darwin" ? "macOS" : platform === "linux" ? "Linux" : platform;
  const release = os.release();
  const arch = os.arch();
  return { platform, release, arch, label: `${name} ${release} (${arch})` };
}

// 本机已装的可选运行终端，供桌面端下拉选择。command 为解析出的可执行文件全路径。
export type TerminalInfo = { name: string; command: string; family: ShellFamily };

// 解析命令到可执行文件全路径：Windows 用 where、POSIX 用 which，取首个命中；解析不到 → null。
async function resolveCommand(name: string): Promise<string | null> {
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    const result = await runCommand(finder, [name], { timeoutMs: 8_000 });
    const first = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)[0];
    return first || null;
  } catch {
    return null;
  }
}

// Git Bash 在 PATH 上常与 WSL 的 bash（System32\bash.exe）同名混淆，故不用 where bash，
// 改按已知安装路径探测；都不命中再从 git 可执行文件位置反推（<root>\bin\bash.exe），覆盖装在任意路径的 Git。
async function findGitBash(): Promise<string | null> {
  const candidates = [
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
    path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Git", "bin", "bash.exe")
  ];
  const known = candidates.find((candidate) => candidate && existsSync(candidate));
  if (known) return known;

  const git = await resolveCommand("git");
  if (!git) return null;
  // git 常在 <root>\cmd\git.exe 或 <root>\bin\git.exe；bash 在 <root>\bin\bash.exe。
  const fromGit = path.join(path.dirname(path.dirname(git)), "bin", "bash.exe");
  return existsSync(fromGit) ? fromGit : null;
}

// 检测本机已装终端。全部容错：探不到的项不返回。Windows 优先 PowerShell/pwsh/cmd/Git Bash/WSL，
// 其余平台探常见 POSIX shell。返回列表供桌面端下拉，用户也可手动输入任意路径。
export async function detectTerminals(): Promise<TerminalInfo[]> {
  const found: TerminalInfo[] = [];
  if (process.platform === "win32") {
    const probes: { name: string; bin: string; family: ShellFamily }[] = [
      { name: "Windows PowerShell", bin: "powershell", family: "powershell" },
      { name: "PowerShell 7 (pwsh)", bin: "pwsh", family: "powershell" },
      { name: "命令提示符 (cmd)", bin: "cmd", family: "cmd" }
    ];
    for (const probe of probes) {
      const command = await resolveCommand(probe.bin);
      if (command) found.push({ name: probe.name, command, family: probe.family });
    }
    const gitBash = await findGitBash();
    if (gitBash) found.push({ name: "Git Bash", command: gitBash, family: "bash" });
    const wsl = await resolveCommand("wsl");
    if (wsl) found.push({ name: "WSL", command: wsl, family: "bash" });
    return found;
  }

  for (const bin of ["bash", "zsh", "fish", "sh"]) {
    const command = await resolveCommand(bin);
    if (command) found.push({ name: bin, command, family: shellFamily(command) });
  }
  return found;
}

// Claude Code 配置目录：CLAUDE_CONFIG_DIR 覆盖，否则 ~/.claude。凭据在其下 .credentials.json。
function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

type Subscription = { subscriptionType: string; accessToken: string | null };

// 判定订阅类型：凭据文件有 claudeAiOauth → 套餐（取 subscriptionType，如 max/pro）；
// 否则有 ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN → api（按量计费）；都没有 → unknown。
function readSubscription(): Subscription {
  try {
    const raw = readFileSync(path.join(claudeConfigDir(), ".credentials.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: { subscriptionType?: string; accessToken?: string };
    };
    const oauth = parsed.claudeAiOauth;
    if (oauth?.accessToken) {
      return {
        subscriptionType: oauth.subscriptionType || "unknown",
        accessToken: oauth.accessToken
      };
    }
  } catch {
    // 文件不存在 / 不可读 / 非 JSON：回退到 env 判定。
  }

  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    return { subscriptionType: "api", accessToken: null };
  }
  return { subscriptionType: "unknown", accessToken: null };
}

function parseWindow(value: unknown): UsageWindow | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const win = value as { utilization?: unknown; resets_at?: unknown };
  if (typeof win.utilization === "number" && typeof win.resets_at === "string") {
    return { utilization: win.utilization, resets_at: win.resets_at };
  }
  return undefined;
}

// 套餐用量：undocumented oauth/usage 接口。用 curl（跨平台、可靠认 -x 代理）；
// shell:false 防 Windows 把含空格的 Authorization 头重解析。失败/非套餐 → 空对象。
async function fetchUsage(accessToken: string, proxy: string | null): Promise<WorkerUsage> {
  const curl = process.platform === "win32" ? "curl.exe" : "curl";
  const args = [
    "-sS",
    "--max-time",
    "20",
    "-H",
    `Authorization: Bearer ${accessToken}`,
    "-H",
    "anthropic-beta: oauth-2025-04-20",
    ...(proxy ? ["-x", proxy] : []),
    "https://api.anthropic.com/api/oauth/usage"
  ];

  try {
    const result = await runCommand(curl, args, { timeoutMs: 25_000, shell: false });
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    const usage: WorkerUsage = { fetched_at: new Date().toISOString() };
    const fiveHour = parseWindow(parsed.five_hour);
    const sevenDay = parseWindow(parsed.seven_day);
    if (fiveHour) usage.five_hour = fiveHour;
    if (sevenDay) usage.seven_day = sevenDay;
    return usage;
  } catch {
    return {};
  }
}

// 一次性采集全部：版本 + 订阅 + （仅套餐账号才查）用量。
export async function inspectClaude(config: WorkerConfig): Promise<ClaudeInspect> {
  const [claudeVersion, subscription] = await Promise.all([
    getClaudeVersion(config),
    Promise.resolve(readSubscription())
  ]);

  const usage = subscription.accessToken
    ? await fetchUsage(subscription.accessToken, config.usageProxy)
    : {};

  return { claudeVersion, subscriptionType: subscription.subscriptionType, usage };
}
