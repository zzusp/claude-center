import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs";
import path from "node:path";
import { runCommand, type CommandResult } from "./shell.js";

// 真并发执行的工作树隔离：每个工作类任务一棵独立 git worktree，互不踩工作树（含同项目并发）。
// 主仓（localPath）只用于 fetch 与 worktree 管理，不被切到工作分支，全程保持稳定。
//
// 工作树建在项目主仓内 <localPath>/.claude/worktrees/ 下（与 Claude Code 原生 .claude/worktrees/
// 约定一致），而非全局数据目录——这样 cwd 落在项目路径前缀下，Claude Code 的 session transcript
// 记录在 ~/.claude/projects/<项目前缀>--claude-worktrees-worktree-<id>/，紧邻项目普通 session。
// git 会跳过已注册的 linked worktree 目录，主仓 status 不被弄脏。

const TASK_WT_PREFIX = "worktree-";
const CONV_WT_PREFIX = "worktree-conv-";
// 任务/会话 id 是 UUID；用它把「本 worker 管理的工作树」与同目录下 Claude Code dev 工作树（名为
// 人类 slug）区分开，避免 GC 误删用户在用的 dev 树。
const TASK_WT_RE = /^worktree-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function worktreesRoot(localPath: string): string {
  return path.join(localPath, ".claude", "worktrees");
}

export function worktreePathFor(localPath: string, taskId: string): string {
  return path.join(worktreesRoot(localPath), `${TASK_WT_PREFIX}${taskId}`);
}

// 实时对话的只读工作树：每会话一棵，检出到 origin/<branch>，全程不 commit。conv- 段与任务树区分。
export function conversationWorktreePathFor(localPath: string, conversationId: string): string {
  return path.join(worktreesRoot(localPath), `${CONV_WT_PREFIX}${conversationId}`);
}

// 让主仓忽略我们的工作树根（<localPath>/.claude/worktrees/），避免 git status 把它报成未跟踪而弄脏主仓。
// 写主仓本地 .git/info/exclude（不改动被跟踪的 .gitignore；多数项目已在 .gitignore 忽略，这里兜底覆盖未忽略的项目）。
// best-effort：失败不阻断任务。
function ensureWorktreesIgnored(localPath: string): void {
  try {
    const gitDir = path.join(localPath, ".git");
    if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) {
      return; // .git 为文件（localPath 本身是工作树）等异常情形不处理
    }
    const infoDir = path.join(gitDir, "info");
    const excludeFile = path.join(infoDir, "exclude");
    const current = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
    if (current.includes(".claude/worktrees")) {
      return;
    }
    mkdirSync(infoDir, { recursive: true });
    const prefix = current && !current.endsWith("\n") ? "\n" : "";
    writeFileSync(excludeFile, `${current}${prefix}/.claude/worktrees/\n`, "utf8");
  } catch {
    // best-effort：写不进不影响功能（项目多半已在 .gitignore 忽略）。
  }
}

async function gitTolerant(args: string[]): Promise<void> {
  try {
    await runCommand("git", args, { timeoutMs: 5 * 60_000 });
  } catch {
    // worktree remove/prune 容错：分支/目录可能本就不存在，不抛、留给 GC 兜底。
  }
}

// 强删 wtPath 目录（Node 递归删）。关键兜底：Windows 上 `git worktree remove --force` 对含 node_modules 的
// 长路径常**删不净**——要么整条失败、要么只摘了 git 注册却把目录留在盘上，于是下次 `git worktree add` 撞
// `fatal: '<path>' already exists`（实测 `--force` 也不豁免「目标目录已存在且非空」这一项），任务卡死在
// worktree 准备阶段、续接重试每次同样过不去（真实 task 2ee00794 即此：dir 在、node_modules 在、.git 丢、未注册）。
// Node 的 rmSync 对 >260 长路径 + 只读文件都能删（已实测），比 git 自带删除可靠。**关键**：必须带 maxRetries——
// Windows 删刚 npm install 出来的 node_modules 常撞瞬时锁（杀软扫描 / 句柄未及时释放 → EBUSY/EPERM/ENOTEMPTY），
// 不重试的 rmSync 会当场抛错被吞、目录残留、add 继续撞 already exists（这正是上一版 fix 仍复发的原因）。
// maxRetries 是 Node 官方对这几类 Windows 错误的解药（线性退避重试）；给足额度兜杀软几秒的扫描窗口。
// 真被活进程独占才放弃，交给随后的 add 抛明确错误由上层标 failed。
function rmWorktreeDir(wtPath: string): void {
  if (!existsSync(wtPath)) {
    return;
  }
  try {
    rmSync(wtPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // 删不掉留给 worktree add 报 "already exists"，上层据此标 failed。
  }
}

// 移除一棵工作树并 prune 元数据。容错。
// 顺序：先 git remove（摘注册、尽量删盘）→ Node 强删兜底（git 在 Windows 长路径/node_modules 上常删不净，
// 留下无 .git 的孤儿目录）→ prune 清悬挂注册。三步后该路径在盘上与 git 注册里都不再残留，下次 add 不撞车。
export async function removeWorktree(localPath: string, wtPath: string): Promise<void> {
  await gitTolerant(["-C", localPath, "worktree", "remove", "--force", wtPath]);
  rmWorktreeDir(wtPath);
  await gitTolerant(["-C", localPath, "worktree", "prune"]);
}

// removeWorktree 后该路径理应已清空；若仍存在，说明目录被某个**运行中的进程**持有 OS 文件锁 / 占为 cwd，
// 导致 git remove、rmSync、rename 全部失败、目录根本删不掉——`git worktree add` 必然撞 `already exists`，
// 且**任何删除逻辑都无解**（实测 task 2ee00794：Worker 自身的 electron 进程 pid 持有该 worktree 内
// node_modules/electron/.../default_app.asar 的句柄，自锁；Restart Manager 确认锁主即 Worker 进程本身）。
// 此处抛出明确可执行的错误（而非让 add 抛晦涩的 already exists 让人反复重试），把根因 + 处置直接写进任务
// error_message：重启 Worker 释放句柄后重试，重启后的新进程不再持锁，清理逻辑即可删掉残留目录、add 成功。
function assertPathCleared(wtPath: string): void {
  if (!existsSync(wtPath)) {
    return;
  }
  throw new Error(
    `工作树目录无法清理，被运行中的进程占用（OS 文件锁 / 进程 cwd）：${wtPath}\n` +
      `git worktree remove / rmSync / rename 均失败 → 任何删除逻辑都无法腾出该路径，git worktree add 会一直撞 ` +
      `"already exists"。常见为 Worker 自身的 electron 进程持有该 worktree 内 node_modules 的句柄（自锁）。\n` +
      `处置：重启 ClaudeCenter Worker 释放句柄后重试——重启后的新进程不再持锁，清理逻辑会自动删掉残留目录、add 即成功。`
  );
}

// 确保任务的工作树就绪。
// fresh（新任务）：删旧 → 从 origin/<base> 新建工作分支 workBranch 的工作树。
// recover（续接/打回重跑）：工作树在就复用；不在则从已有 workBranch 重建。
export async function ensureWorktree(
  localPath: string,
  wtPath: string,
  opts: { workBranch: string; baseRef?: string; fresh: boolean }
): Promise<void> {
  ensureWorktreesIgnored(localPath);
  if (opts.fresh) {
    // removeWorktree 已 robust 清理（git remove + Node 强删 + prune），无论目标是已注册工作树还是孤儿残留目录
    //（含删不净的 node_modules）都清干净，随后的 add 不再撞 "already exists"。
    await removeWorktree(localPath, wtPath);
    assertPathCleared(wtPath); // 清不掉（被进程占用）→ 抛明确可执行错误，而非让 add 抛晦涩的 already exists
    await runCommand(
      "git",
      ["-C", localPath, "worktree", "add", "--force", "-B", opts.workBranch, wtPath, opts.baseRef ?? opts.workBranch],
      { timeoutMs: 10 * 60_000 }
    );
    return;
  }

  // 续接 / 重试：工作树的 .git 是指向主仓的文件，存在即视为可复用（持有上一轮未提交改动，直接接着干）。
  if (existsSync(path.join(wtPath, ".git"))) {
    return;
  }
  // 不是有效工作树（.git 丢失但目录作为孤儿残留 / 悬挂注册）：robust 清理后从已有 workBranch 重建（不再误报失败）。
  await removeWorktree(localPath, wtPath);
  assertPathCleared(wtPath); // 同 fresh：清不掉（被进程占用）→ 抛明确可执行错误
  await runCommand(
    "git",
    ["-C", localPath, "worktree", "add", "--force", wtPath, opts.workBranch],
    { timeoutMs: 10 * 60_000 }
  );
}

// 多仓任务支持（docs/spec/task-multi-repo.md §6、docs/spec/project-repos-runtime-path.md）：
// 子仓本地路径约定为 <mainLocal>/<relative_path>（与主仓 .gitignore 忽略路径一致）。
// 任务执行前确保该子仓已 clone：不存在则 git clone；存在视为可复用。父目录不存在时先建。
// clone 失败抛错（强语义下整任务 failed）。
export async function ensureSubRepoCloned(subRepoLocal: string, repoUrl: string): Promise<void> {
  if (existsSync(path.join(subRepoLocal, ".git"))) {
    return;
  }
  mkdirSync(path.dirname(subRepoLocal), { recursive: true });
  await runCommand("git", ["clone", repoUrl, subRepoLocal], { timeoutMs: 10 * 60_000 });
}

// 把任意形态的 git 仓库 URL 归一为对等比较用 key：忽略尾 .git、协议(https/git/ssh)、user@host、端口。
// 例：
//   https://github.com/foo/bar.git → github.com/foo/bar
//   git@github.com:foo/bar         → github.com/foo/bar
//   ssh://git@github.com:22/foo/bar.git → github.com/foo/bar
function normalizeRepoUrl(url: string): string {
  let s = url.trim();
  if (!s) return "";
  s = s.replace(/\.git$/i, "");
  // ssh://user@host:port/path 形式
  s = s.replace(/^[a-z]+:\/\//i, "");
  // scp 风格 user@host:path
  s = s.replace(/^[^@/]+@/, "");
  // 主机后的 ":" 或 "/" 统一成 "/"
  s = s.replace(/:/, "/");
  // 收尾斜杠
  s = s.replace(/\/+$/, "");
  return s.toLowerCase();
}

// 从 git URL 派生本机文件夹 basename（去尾 .git）。
function basenameFromRepoUrl(repoUrl: string): string {
  const cleaned = repoUrl.replace(/[\/\s]+$/, "");
  const tail = cleaned.split(/[\/:]/).pop() ?? cleaned;
  return tail.replace(/\.git$/i, "");
}

// 进程缓存：同 worker 多任务复用同一 (mainLocal, repoUrl) 的派生结果。
const subRepoResolveCache = new Map<string, Promise<string>>();

// 扫主仓本地的子目录（深度 ≤ MAX_DEPTH），找含 .git 且 `remote.origin.url` 与 repoUrl 等价的目录，
// 返回相对 mainLocal 的 POSIX 路径。命中即返回；扫不到返回 null（由调用方走 basename 兜底）。
async function findSubRepoByRemote(
  mainLocal: string,
  repoUrl: string,
  maxDepth = 3
): Promise<string | null> {
  const target = normalizeRepoUrl(repoUrl);
  if (!target) return null;
  const SKIP_DIRS = new Set([
    "node_modules", ".git", ".next", ".turbo", "dist", "build", "out",
    ".claude", ".vscode", ".idea", "coverage"
  ]);

  type Entry = { abs: string; rel: string; depth: number };
  const stack: Entry[] = [{ abs: mainLocal, rel: ".", depth: 0 }];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(cur.abs, { withFileTypes: true, encoding: "utf8" }) as Dirent[];
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (SKIP_DIRS.has(ent.name)) continue;
      const childAbs = path.join(cur.abs, ent.name);
      const childRel = cur.rel === "." ? ent.name : `${cur.rel}/${ent.name}`;
      // 主仓自身（depth 0 的 .git）也会被命中——SKIP_DIRS 已排掉 .git 这一项目录；
      // 但子目录里若藏着 .git 才是子仓候选。
      const dotGit = path.join(childAbs, ".git");
      if (existsSync(dotGit)) {
        try {
          const r = await runCommand("git", ["-C", childAbs, "config", "--get", "remote.origin.url"], {
            timeoutMs: 10_000,
            acceptExitCodes: [0, 1]
          });
          if (r.exitCode === 0) {
            const candidate = normalizeRepoUrl(r.stdout.trim());
            if (candidate && candidate === target) {
              return childRel;
            }
          }
        } catch {
          // 忽略：这个候选不算数，继续扫。
        }
        // 子仓内部不再下钻，避免 monorepo 内嵌套吃满栈。
        continue;
      }
      if (cur.depth + 1 < maxDepth) {
        stack.push({ abs: childAbs, rel: childRel, depth: cur.depth + 1 });
      }
    }
  }
  return null;
}

// 运行时派生子仓本机相对路径（docs/spec/project-repos-runtime-path.md）：
//   1) 优先扫主仓本地下子目录，找 remote.origin.url 等价于 repoUrl 的现存 clone → 命中复用其相对路径
//   2) 否则用 basename(repoUrl) 作目录名；若该路径已存在但 .git 缺失或 remote 不匹配 → 抛错（让上层标 failed），
//      不自动改名以免误伤
//   3) 命中 (2) 且路径不存在时，仅返回相对路径——真正的 git clone 由 ensureSubRepoCloned 触发
// 结果做进程级缓存（同 worker 多任务复用）。
export async function resolveSubRepoRelativePath(
  mainLocal: string,
  repoUrl: string
): Promise<string> {
  const key = `${mainLocal}::${normalizeRepoUrl(repoUrl)}`;
  const cached = subRepoResolveCache.get(key);
  if (cached) return cached;

  const promise = (async () => {
    const found = await findSubRepoByRemote(mainLocal, repoUrl);
    if (found) return found;

    const base = basenameFromRepoUrl(repoUrl);
    if (!base) {
      throw new Error(`无法从 repoUrl 派生子仓本机目录名：${repoUrl}`);
    }
    const targetAbs = path.join(mainLocal, base);
    if (existsSync(targetAbs)) {
      // 路径已存在但前面 findSubRepoByRemote 没匹配上 → 不是同一仓（或缺 .git）。
      // 抛错让用户在 worker 上手动处理（rename / 删错占的目录）。
      throw new Error(
        `子仓本机目录 ${base} 已被其它内容占用（在 ${mainLocal} 下），且其 remote.origin.url 与 ${repoUrl} 不匹配。请在 worker 本机重命名或删除该目录后重试。`
      );
    }
    return base;
  })();

  subRepoResolveCache.set(key, promise);
  try {
    return await promise;
  } catch (err) {
    // 失败不缓存，下次重试有机会。
    subRepoResolveCache.delete(key);
    throw err;
  }
}

// 多仓任务前置硬约束：主仓 .gitignore 必须忽略子仓路径，否则 git worktree add 会撞
// `'<path>' already exists`。`git check-ignore -q <path>` 返回 0 表示被忽略；1 未被忽略；
// 128 命令异常。仅 0 时通过，1 抛带明确指引的错误。128 也抛（让上层把任务标 failed）。
export async function assertSubRepoPathIgnoredInMain(
  mainLocal: string,
  subRelativePath: string
): Promise<void> {
  let result: CommandResult;
  try {
    result = await runCommand("git", ["-C", mainLocal, "check-ignore", "-q", subRelativePath], {
      timeoutMs: 30_000,
      // check-ignore 用 exit code 表达结果（0/1 均非异常）；让 shell 层不把 1 当失败抛出。
      acceptExitCodes: [0, 1]
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `检查子仓路径 ignored 状态失败（${subRelativePath}）：${detail}。请确认主仓本地路径有效且 .gitignore 可被 git 读取。`
    );
  }
  if (result.exitCode === 0) {
    return;
  }
  throw new Error(
    `子仓路径未被主仓 .gitignore 忽略：${subRelativePath}。多仓任务要求主仓忽略子仓目录，否则主仓工作树会占用该路径导致子仓 worktree add 冲突。请在主仓根 .gitignore 加入 "${subRelativePath}/" 后重试。`
  );
}

// GC：清理该项目主仓 .claude/worktrees/ 下、本 worker 管理的任务工作树（worktree-<UUID>）中已进终态
// （不在 keepTaskIds）的残留树。跨生命周期兜底:listActiveTaskIdsForWorker 的 keep 集合包含
// claimed/running/waiting/success/merged/failed/cancelled,仅清崩溃/异常退出留下的真孤儿。严格只碰
// worktree-<UUID> 命名的任务树——同目录下 Claude Code dev 工作树（名为 slug）、
// 会话树（worktree-conv-*）、主仓自身一律不动。
export async function gcWorktrees(localPath: string, keepTaskIds: Set<string>): Promise<void> {
  const root = worktreesRoot(localPath);
  let listed: string;
  try {
    const result = await runCommand("git", ["-C", localPath, "worktree", "list", "--porcelain"], {
      timeoutMs: 60_000
    });
    listed = result.stdout;
  } catch {
    return;
  }

  for (const line of listed.split(/\r?\n/)) {
    if (!line.startsWith("worktree ")) {
      continue;
    }
    const wtPath = line.slice("worktree ".length).trim();
    // 仅碰我们 worktrees 目录下的；主仓自身与其它目录的工作树不动。
    if (path.relative(root, wtPath).startsWith("..")) {
      continue;
    }
    const name = path.basename(wtPath);
    // 严格只清任务树：名必须是 worktree-<UUID>，且该 UUID 不在 keep 集。其它（dev slug 树 / 会话树）跳过。
    if (!TASK_WT_RE.test(name)) {
      continue;
    }
    const taskId = name.slice(TASK_WT_PREFIX.length);
    if (!keepTaskIds.has(taskId)) {
      await removeWorktree(localPath, wtPath);
    }
  }
}
