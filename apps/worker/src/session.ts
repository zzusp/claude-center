import { readdirSync, readFileSync, statSync } from "node:fs";
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

// 定位某 cwd（任务工作树，每任务唯一→该目录即本任务会话）对应 projects 目录下最新的 .jsonl transcript。
// 不需要预先知道 sessionId。目录尚未建（claude 刚启动）/ 无 jsonl 时返回 null。
function findSessionFile(cwd: string): string | null {
  const dir = path.join(claudeProjectsDir(), encodeProjectDir(cwd));
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  let newest: { file: string; mtime: number } | null = null;
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const full = path.join(dir, entry);
    try {
      const mtime = statSync(full).mtimeMs;
      if (!newest || mtime > newest.mtime) {
        newest = { file: full, mtime };
      }
    } catch {
      // 文件可能在枚举与 stat 之间被删/轮转，跳过。
    }
  }
  return newest?.file ?? null;
}

// 读取某 cwd 对应任务会话 transcript 全文。无则 null。
export function readSessionJsonl(cwd: string): string | null {
  const file = findSessionFile(cwd);
  if (!file) return null;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// 执行期间周期同步某 cwd 的 session transcript，persist 落库；返回 stop()：清定时器 + 强制最终同步一次
//（保证终态——成功/失败/超时/取消——落库的是完整文件）。transcript append-only、长度单调增，
// 故周期同步按长度跳过 no-op 写；最终同步强制写一次。任务 / 对话各传自己的 persist。
function startSync(cwd: string, persist: (jsonl: string) => Promise<void>, intervalMs: number): () => Promise<void> {
  let lastLen = -1;
  let stopped = false;

  const syncOnce = async (force: boolean): Promise<void> => {
    const content = readSessionJsonl(cwd);
    if (content == null) return;
    if (!force && content.length === lastLen) return;
    lastLen = content.length;
    await persist(content);
  };

  const timer = setInterval(() => {
    if (stopped) return;
    void syncOnce(false).catch(() => {
      /* 周期同步失败静默，下一轮 / 最终同步重试 */
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
export function startTaskSessionSync(taskId: string, cwd: string): () => Promise<void> {
  return startSync(cwd, (jsonl) => upsertTaskSession(getPool(), taskId, jsonl), TASK_SYNC_INTERVAL_MS);
}

// 对话执行期间周期 + 终态同步 transcript 到 conversation_sessions（一个对话多轮 --resume 续接对应同一 session 文件）。
export function startConversationSessionSync(conversationId: string, cwd: string): () => Promise<void> {
  return startSync(cwd, (jsonl) => upsertConversationSession(getPool(), conversationId, jsonl), CONVERSATION_SYNC_INTERVAL_MS);
}
