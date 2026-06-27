import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPool, upsertConversationSession, upsertTaskSession } from "@claude-center/db";

// Claude Code 把每个会话的 transcript 写到 <claudeDir>/projects/<encode(cwd)>/<sessionId>.jsonl。
// claudeDir 默认 ~/.claude，可被 CLAUDE_CONFIG_DIR 覆盖；encode = cwd 中非字母数字一律换成 '-'
//（已对真实 transcript 文件实证完全吻合：C:\Users\...\worktrees\<id> → C--Users----worktrees-<id>）。

const TASK_SYNC_INTERVAL_MS = 20_000;
// 对话是交互式的，需更快看到富内容（工具调用 / 思考），用更短的同步周期。
const CONVERSATION_SYNC_INTERVAL_MS = 3_000;

function claudeProjectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
  return path.join(base, "projects");
}

function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

// 定位某 cwd（任务工作树，每任务唯一→该目录即本任务会话）对应 projects 目录下最新的 .jsonl transcript
// + 其 mtimeMs（供周期同步按 mtime 跳过未变的整文件读盘）。全异步 IO（fs.promises），不阻塞主进程事件循环——
// 同步 readdirSync/statSync/readFileSync 会卡住 Electron 主进程、连带拖慢并发的 IPC 响应。
// 目录尚未建（claude 刚启动）/ 无 jsonl 时返回 null。
//
// opts.sinceMs：仅考虑 mtime 或 birthtime ≥ sinceMs 的文件。用于排除「用户在同一 cwd（如非 git 项目里的
// localPath、或同一 worktree）单独开终端跑过 claude」留下的旧 session 文件——否则 findSessionFile 取最新
// 那条会把我们的 conversation/task 误连到别的会话历史上（用户原报：定时消息发出后回显另一个终端窗口的历史）。
// opts.preferSessionId：当 <sessionId>.jsonl 存在时直接命中（--resume 同一会话写回原文件名场景的快路径）。
async function findSessionFile(
  cwd: string,
  opts?: { sinceMs?: number | null; preferSessionId?: string | null }
): Promise<{ file: string; mtime: number } | null> {
  const dir = path.join(claudeProjectsDir(), encodeProjectDir(cwd));
  const sinceMs = opts?.sinceMs ?? null;
  const preferSessionId = opts?.preferSessionId ?? null;

  // 快路径：明确知道 --resume 的 sessionId 且 <id>.jsonl 存在 → 直接锁定，不与同目录其它会话比较。
  // 快路径仍要过时间窗：claude `-p --resume <id>` 在某些版本会派生新 session id（写到新 <newId>.jsonl）而
  // 非追加到 <id>.jsonl。直接 return 会让本路径一直锁回上一轮留下的旧 file，extractFinalAssistantText 滤完
  // 时间窗后永远返回 ""（→ finalize=false → "claude 退出了但本轮无完整结果（jsonl 中未找到本轮 assistant 文本）"
  // 模糊假失败）。在快路径里同样核对 mtime/birthtime ≥ sinceMs，过期文件就回退扫描去找新派生的 file。
  if (preferSessionId) {
    const target = path.join(dir, `${preferSessionId}.jsonl`);
    try {
      const st = await fsp.stat(target);
      if (sinceMs === null) {
        return { file: target, mtime: st.mtimeMs };
      }
      const birth = Number.isFinite(st.birthtimeMs) ? st.birthtimeMs : 0;
      if (st.mtimeMs >= sinceMs || birth >= sinceMs) {
        return { file: target, mtime: st.mtimeMs };
      }
      // preferSessionId.jsonl 是过期的（未在本轮被写过）→ fall through 到扫描，让时间窗逻辑找新派生的 file。
    } catch {
      // 不存在 / 不可读 → 落到下面的扫描（可能 claude 当轮 fork 出新 sessionId）
    }
  }

  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return null;
  }
  let newest: { file: string; mtime: number } | null = null;
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const full = path.join(dir, entry);
    try {
      const stat = await fsp.stat(full);
      // 时间窗过滤：只在 mtime 或 birthtime ≥ sinceMs 时才视作本次执行产生的文件。
      // birthtime 是文件创建时刻——首次写就被认领；mtime 是最后写入——用于已存在文件被本次 claude --resume 续写的场景。
      if (sinceMs !== null) {
        const birth = Number.isFinite(stat.birthtimeMs) ? stat.birthtimeMs : 0;
        if (stat.mtimeMs < sinceMs && birth < sinceMs) continue;
      }
      if (!newest || stat.mtimeMs > newest.mtime) {
        newest = { file: full, mtime: stat.mtimeMs };
      }
    } catch {
      // 文件可能在枚举与 stat 之间被删/轮转，跳过。
    }
  }
  return newest;
}

// 读取某 cwd 对应任务会话 transcript 全文（异步）。无则 null。
export async function readSessionJsonl(cwd: string): Promise<string | null> {
  const found = await findSessionFile(cwd);
  if (!found) return null;
  try {
    return await fsp.readFile(found.file, "utf8");
  } catch {
    return null;
  }
}

// 读取某 cwd 对应会话 transcript 全文 + sessionId（= .jsonl 文件名）。供对话轮「从 session 收尾」用：
// detached/重连场景下 claude 的 stdout 已不可得，终态的 result/sessionId 都从这里取。无则 null。
//
// opts.sinceMs/preferSessionId：见 findSessionFile 文档——用于把本次 claude 进程产生的 session 文件与
// 同目录其它（用户另开终端 / 别次执行）会话区分开，防止误把别的对话历史写回本对话。
export async function findSessionInfo(
  cwd: string,
  opts?: { sinceMs?: number | null; preferSessionId?: string | null }
): Promise<{ jsonl: string; sessionId: string } | null> {
  const found = await findSessionFile(cwd, opts);
  if (!found) return null;
  try {
    const jsonl = await fsp.readFile(found.file, "utf8");
    const sessionId = path.basename(found.file).replace(/\.jsonl$/i, "");
    return { jsonl, sessionId };
  } catch {
    return null;
  }
}

// 执行期间周期同步某 cwd 的 session transcript，persist 落库；返回 stop()：清定时器 + 强制最终同步一次
//（保证终态——成功/失败/超时/取消——落库的是完整文件）。transcript append-only、长度单调增，故周期同步：
//   ① 先按 mtime 跳过未写过的轮（claude 思考/工具间隙的空转，免整文件读盘）；
//   ② 再按长度跳过 no-op 写。
// 仅在「已持久化 / 确认无需持久化」后才推进 lastSyncedMtime——persist 失败则 mtime 不推进，下一轮
// (found.mtime !== lastSyncedMtime) 自然重试，不会被 mtime 跳过吞掉失败。最终同步 force 忽略两道跳过。
function startSync(
  cwd: string,
  persist: (jsonl: string) => Promise<void>,
  intervalMs: number,
  opts?: { sinceMs?: number | null; preferSessionId?: string | null }
): () => Promise<void> {
  let lastLen = -1;
  let lastSyncedMtime = -1;
  let stopped = false;

  const syncOnce = async (force: boolean): Promise<void> => {
    const found = await findSessionFile(cwd, opts);
    if (found == null) return;
    if (!force && found.mtime === lastSyncedMtime) return;
    let content: string;
    try {
      content = await fsp.readFile(found.file, "utf8");
    } catch {
      return;
    }
    if (!force && content.length === lastLen) {
      lastSyncedMtime = found.mtime;
      return;
    }
    await persist(content);
    lastLen = content.length;
    lastSyncedMtime = found.mtime;
  };

  const timer = setInterval(() => {
    if (stopped) return;
    void syncOnce(false).catch((error) => {
      // 周期同步失败不阻塞执行：lastSyncedMtime 未推进，下一轮自动重试；这里打一条让失败可见（曾全静默难定位）。
      console.warn(`[session] 周期同步失败，将于下一轮重试：${error instanceof Error ? error.message : String(error)}`);
    });
  }, intervalMs);

  return async () => {
    stopped = true;
    clearInterval(timer);
    try {
      await syncOnce(true);
    } catch {
      /* 最终同步失败不影响终态翻转 */
    }
  };
}

// 任务执行期间周期 + 终态同步 transcript 到 task_sessions。
// sinceMs：本次 claude 进程启动时刻（毫秒）—— 用于排除同目录里的旧 session 文件。
export function startTaskSessionSync(taskId: string, cwd: string, sinceMs?: number | null): () => Promise<void> {
  return startSync(
    cwd,
    (jsonl) => upsertTaskSession(getPool(), taskId, jsonl),
    TASK_SYNC_INTERVAL_MS,
    { sinceMs: sinceMs ?? null }
  );
}

// 对话执行期间周期 + 终态同步 transcript 到 conversation_sessions（一个对话多轮 --resume 续接对应同一 session 文件）。
// resumeSessionId：已知本对话的会话 id（之前轮存进 conversations.claude_session_id）。<id>.jsonl 命中则直接锁定，
// 不会被同目录里其它 claude 终端会话「最新写入」抢走（用户原报：定时消息触发后回显另一个终端窗口的历史）。
// sinceMs：本次 claude 进程启动时刻，用作 resumeSessionId 命中失败时的兜底过滤。
export function startConversationSessionSync(
  conversationId: string,
  cwd: string,
  opts?: { sinceMs?: number | null; resumeSessionId?: string | null }
): () => Promise<void> {
  return startSync(
    cwd,
    (jsonl) => upsertConversationSession(getPool(), conversationId, jsonl),
    CONVERSATION_SYNC_INTERVAL_MS,
    { sinceMs: opts?.sinceMs ?? null, preferSessionId: opts?.resumeSessionId ?? null }
  );
}
