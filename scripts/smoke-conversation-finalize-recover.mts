// 行为冒烟：实时对话「无完整结果」假失败的修复。在 ephemeral 干净库上 seed 一会话 + streaming turn，
// 然后 **直接调用 worker 真 helper**（finalizeConversationFromSession / tryRecoverConversationTurnFromClaudeLog），
// 验证三条收尾路径，对齐 executor.executeConversationTurn 兜底与 runner reattach 的真实分支。
//
// 用法：node scripts/run-smoke-against-ephemeral.mjs scripts/smoke-conversation-finalize-recover.mts
//
// 校验三段：
//   A. stdout 兜底挽回：jsonl 缺 → finalizeConversationFromSession 返 false；后续 tryRecover 读
//      stdoutLogFile 拿到 `{result, session_id}` → 把 turn 翻 done、清 log 文件。模拟 worker 在
//      detached + stdio:'ignore' 退化、或 claude 没写 jsonl 但写了 stdout JSON 的真实失败场景。
//   B. preferSessionId 过期回退：CLAUDE_CONFIG_DIR 下伪造同一 cwd 的两个 .jsonl（A 旧、B 新）。
//      preferSessionId='A' 但 A.mtime/birthtime 双双在 sinceMs 之前 → 不再被快路径锁死，回退扫描
//      命中 B → extractFinalAssistantText 取得本轮文本、finalize done。这是「claude --resume 派生
//      新 sessionId 写新文件」场景的真重现，本路径之前会一直读旧空 file 触发"无完整结果"假失败。
//   C. 两路全没东西：jsonl 不存在 + log 文件不存在 → 两 helper 都返 false、DB 仍 streaming（caller
//      在 executor 真路径里据此 failConversationTurn，但本 smoke 只校验"没误判 done"）。

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addConversationMessage,
  claimNextConversationTurn,
  closePool,
  createConversation,
  getConversation,
  getPool,
  registerWorker
} from "@claude-center/db";
import {
  conversationTurnClaudeLogPath,
  finalizeConversationFromSession,
  tryRecoverConversationTurnFromClaudeLog
} from "@claude-center/worker/dist/executor.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-conv-fr-"));
const claudeConfigDir = path.join(tmpRoot, "dot-claude");
fs.mkdirSync(path.join(claudeConfigDir, "projects"), { recursive: true });
// 关键：worker 走 CLAUDE_CONFIG_DIR 找 ~/.claude/projects，本 smoke 把它指向临时目录，避免污染用户真实 ~/.claude。
process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function asstLine(ts: string, text: string): string {
  return JSON.stringify({ type: "assistant", timestamp: ts, message: { content: [{ type: "text", text }] } });
}

async function seedConv(label: string): Promise<{ convId: string; turnId: string; wtPath: string }> {
  const pool = getPool();
  const projId = randomUUID();
  const workerId = randomUUID();
  const localPath = path.join(tmpRoot, `local-${label}`).replace(/\\/g, "/");
  const wtPath = path.join(tmpRoot, `wt-${label}`).replace(/\\/g, "/");
  fs.mkdirSync(localPath, { recursive: true });
  fs.mkdirSync(path.join(wtPath, ".claude"), { recursive: true });

  await pool.query(
    `INSERT INTO projects (id, name, repo_url, default_branch) VALUES ($1, $2, $3, 'main')`,
    [projId, `Proj-${label}`, `https://x/${label}.git`]
  );
  await registerWorker(pool, {
    id: workerId,
    name: `worker-${label}`,
    hostName: "host-x",
    appVersion: "test",
    capabilities: {},
    metadata: {}
  });
  await pool.query(
    `INSERT INTO worker_project_links (worker_id, project_id, local_path, repo_identity, enabled)
     VALUES ($1, $2, $3, 'repo.git', true)`,
    [workerId, projId, localPath]
  );
  const conv = await createConversation(pool, {
    projectId: projId,
    workerId,
    branch: "main",
    model: "default",
    title: `conv-${label}`,
    createdBy: null
  });
  await addConversationMessage(pool, { conversationId: conv.id, role: "user", body: "hello" });
  const turn = await claimNextConversationTurn(pool, workerId);
  if (!turn) throw new Error(`claim failed for ${label}`);
  if (turn.status !== "streaming") throw new Error(`expected streaming, got ${turn.status}`);
  return { convId: conv.id, turnId: turn.id, wtPath };
}

async function main(): Promise<void> {
  const pool = getPool();

  // ========== Case A：stdout JSON 兜底把 turn 翻 done ==========
  {
    const { convId, turnId, wtPath } = await seedConv("a001");
    // 不写 jsonl —— 直接落 stdoutLogFile，模拟 `claude --output-format json` 写了 stdout 但 jsonl 缺失。
    const logFile = conversationTurnClaudeLogPath(wtPath, turnId);
    const sessionId = `recovered-sess-${turnId}`;
    fs.writeFileSync(
      logFile,
      `${JSON.stringify({ session_id: sessionId, result: "answer-from-stdout", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } })}\n`
    );

    // 第一步：jsonl 兜底应失败（CLAUDE_CONFIG_DIR/projects/<encode(wtPath)>/ 还没有任何 .jsonl）
    const finalized = await finalizeConversationFromSession(pool, {
      conversationId: convId,
      messageId: turnId,
      cwd: wtPath,
      sinceMs: Date.now() - 5_000,
      resumeSessionId: null
    });
    if (finalized) throw new Error("[A] expected finalizeConversationFromSession=false (no jsonl)");

    // 第二步：tryRecover 应读到 stdout 文件、解析 JSON、把 turn 翻 done、清掉 log 文件
    const recovered = await tryRecoverConversationTurnFromClaudeLog(pool, {
      conversationId: convId,
      messageId: turnId,
      wtPath
    });
    if (!recovered) throw new Error("[A] expected tryRecover=true (valid stdout JSON)");
    if (fs.existsSync(logFile)) throw new Error("[A] log file should be cleaned up after recover");

    const row = await pool.query(
      `SELECT status, body FROM conversation_messages WHERE id = $1`,
      [turnId]
    );
    if (row.rows[0]?.status !== "done") throw new Error(`[A] expected status=done, got ${row.rows[0]?.status}`);
    if (row.rows[0]?.body !== "answer-from-stdout") {
      throw new Error(`[A] expected body=answer-from-stdout, got ${row.rows[0]?.body}`);
    }
    // claude_session_id 写在 conversations 表（finalizeConversationTurn COALESCE 写回 conv.claude_session_id）
    const conv = await getConversation(pool, convId);
    if (conv?.claude_session_id !== sessionId) {
      throw new Error(`[A] expected conv.claude_session_id=${sessionId}, got ${conv?.claude_session_id}`);
    }
    console.log("✓ Case A：stdout JSON 兜底把 turn 翻 done + session_id 写回");
  }

  // ========== Case B：preferSessionId 过期 → 回退扫描命中新 file → finalize done ==========
  {
    const { convId, turnId, wtPath } = await seedConv("b002");
    // 在 CLAUDE_CONFIG_DIR/projects/<encode(wtPath)>/ 下伪造一个 A.jsonl（旧）+ B.jsonl（新）
    const projDir = path.join(claudeConfigDir, "projects", encodeProjectDir(wtPath));
    fs.mkdirSync(projDir, { recursive: true });
    const oldStaleId = "old-stale-sess";
    const newForkId = "new-fork-sess";
    fs.writeFileSync(
      path.join(projDir, `${oldStaleId}.jsonl`),
      `${asstLine("2026-06-26T00:00:00.000Z", "上一轮答案不应被本轮取到")}\n`
    );
    // 等一下，让旧 file 的 mtime/birthtime 真实落在 sinceMs 之前——Windows 上 fs.utimes 改不动 birthtime，必须真等。
    await new Promise((r) => setTimeout(r, 200));
    const sinceMs = Date.now();
    await new Promise((r) => setTimeout(r, 50));
    fs.writeFileSync(
      path.join(projDir, `${newForkId}.jsonl`),
      `${asstLine(new Date(sinceMs + 100).toISOString(), "this-is-the-forked-answer")}\n`
    );

    // 关键：preferSessionId=oldStaleId（DB 里上一轮存的 claude_session_id），但 A.jsonl 是上一轮留下的、本轮 claude
    // 实际派生了新 sessionId 写到 B.jsonl。修复前快路径会一直锁 A 取空 → 假失败；修复后回退扫描 → 命中 B → done。
    const finalized = await finalizeConversationFromSession(pool, {
      conversationId: convId,
      messageId: turnId,
      cwd: wtPath,
      sinceMs,
      resumeSessionId: oldStaleId
    });
    if (!finalized) throw new Error("[B] expected finalize=true via stale preferSessionId fallback");
    const row = await pool.query(
      `SELECT status, body FROM conversation_messages WHERE id = $1`,
      [turnId]
    );
    if (row.rows[0]?.status !== "done") throw new Error(`[B] expected status=done, got ${row.rows[0]?.status}`);
    if (row.rows[0]?.body !== "this-is-the-forked-answer") {
      throw new Error(`[B] expected body=this-is-the-forked-answer, got ${row.rows[0]?.body}`);
    }
    const conv = await getConversation(pool, convId);
    if (conv?.claude_session_id !== newForkId) {
      throw new Error(`[B] expected conv.claude_session_id=${newForkId} (forked), got ${conv?.claude_session_id}`);
    }
    console.log("✓ Case B：preferSessionId 过期 → 扫描命中 forked sessionId、turn 翻 done");
  }

  // ========== Case C：jsonl 不存在 + log 文件不存在 → 两 helper 全返 false、turn 仍 streaming ==========
  {
    const { convId, turnId, wtPath } = await seedConv("c003");
    const finalized = await finalizeConversationFromSession(pool, {
      conversationId: convId,
      messageId: turnId,
      cwd: wtPath,
      sinceMs: Date.now() - 5_000,
      resumeSessionId: null
    });
    if (finalized) throw new Error("[C] no jsonl → expected finalize=false");
    const recovered = await tryRecoverConversationTurnFromClaudeLog(pool, {
      conversationId: convId,
      messageId: turnId,
      wtPath
    });
    if (recovered) throw new Error("[C] no log → expected recover=false");
    const row = await pool.query(
      `SELECT status FROM conversation_messages WHERE id = $1`,
      [turnId]
    );
    if (row.rows[0]?.status !== "streaming") {
      throw new Error(`[C] no recovery → expected status=streaming (left to caller failConversationTurn), got ${row.rows[0]?.status}`);
    }
    console.log("✓ Case C：jsonl + log 全无 → 两 helper 返 false、状态守恒不误判 done");
  }

  await closePool();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log("\n✓ smoke-conversation-finalize-recover 通过 (3 cases)");
}

main().catch(async (error) => {
  console.error(error);
  await closePool().catch(() => {});
  process.exit(1);
});
