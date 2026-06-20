import { spawnSync } from "node:child_process";

// macOS 从 Finder / Dock 启动的 GUI 应用继承的是 launchd 的最小 PATH（/usr/bin:/bin:/usr/sbin:/sbin），
// 不含登录 shell 里 brew / nvm / Claude Code 装到的目录（/opt/homebrew/bin、/usr/local/bin、~/.local/bin…）。
// 结果：git/gh/claude/node 全部能力自检为 missing、任务一律 "claude CLI not found"，桌面端形同不可用。
// 旧 workaround 是从终端 `open -a "ClaudeCenter Worker"` 启动让它继承终端 PATH（见 worker-install-guide §11）。
//
// 这里在启动时拉一次登录 shell 的真实 PATH 合并进 process.env.PATH，让后续 spawn（detectCapabilities /
// 跑 claude / git / gh / npm / curl）都能解析到这些命令，从 Finder 直接双击启动即可用。
// 仅对 darwin 生效；从终端启动（PATH 已含登录 shell 路径）时合并同样安全（去重，不改变可解析结果）。

export function fixMacGuiPath(): void {
  if (process.platform !== "darwin") {
    return;
  }
  const shell = process.env.SHELL || "/bin/zsh";
  // 哨兵包裹 PATH：交互式登录 shell 可能往 stdout 打 MOTD / 提示，靠哨兵从噪声里精确截取这一段。
  const begin = "__CC_PATH_BEGIN__";
  const end = "__CC_PATH_END__";
  try {
    const result = spawnSync(
      shell,
      // -ilc：交互式(-i)登录(-l) shell 执行命令(-c)，确保 .zprofile/.zshrc/.bash_profile 里对 PATH
      // 的修改都被 source 到；DISABLE_AUTO_UPDATE 防 oh-my-zsh 等启动时挂在更新提示上拖死。
      // 用 `printenv PATH` 而非 `"$PATH"`：fish 把 $PATH 当列表、字符串化为【空格】分隔，会让下面按 ":" 切分的
      // mergePath 收到一个含空格的伪目录、真目录全丢（fish 用户从 Finder 启动仍解析不到 claude/git）。
      // printenv 读的是【真实环境变量】PATH，任何 shell（含 fish）都是冒号分隔，且目录名含空格也安全。
      ["-ilc", `printf '%s' '${begin}'; /usr/bin/printenv PATH; printf '%s' '${end}'`],
      {
        encoding: "utf8",
        // 5s：PATH 提取在正常情况下近乎瞬时，留足 source profile 的余量即可；过长只会在 shell 卡死时拖慢首屏。
        timeout: 5_000,
        env: { ...process.env, DISABLE_AUTO_UPDATE: "true" }
      }
    );
    const out = result.stdout ?? "";
    const start = out.indexOf(begin);
    const stop = out.indexOf(end);
    if (start === -1 || stop === -1 || stop <= start) {
      return;
    }
    const shellPath = out.slice(start + begin.length, stop).trim();
    if (shellPath) {
      mergePath(shellPath);
    }
  } catch {
    // best-effort：拿不到登录 shell PATH 不致命，退回原 PATH（用户仍可 open -a 或设 CLAUDE_CODE_COMMAND）。
  }
}

// 登录 shell PATH 优先（brew 等在此），其后接当前进程 PATH，去重保序。
function mergePath(shellPath: string): void {
  const current = process.env.PATH ?? "";
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const dir of [...shellPath.split(":"), ...current.split(":")]) {
    const d = dir.trim();
    if (!d || seen.has(d)) {
      continue;
    }
    seen.add(d);
    merged.push(d);
  }
  process.env.PATH = merged.join(":");
}
