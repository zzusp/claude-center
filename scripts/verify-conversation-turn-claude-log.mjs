#!/usr/bin/env node
// 一次性人工校验：apps/worker/src/executor.ts 里 conversationTurnClaudeLogPath /
// tryRecoverConversationTurnFromClaudeLog 的两件事：
//   ① 路径计算与 executor.executeConversationTurn 写入路径完全一致（runner 重连路径据此能读到同一个文件）；
//   ② 文件存在 + 末尾是 `{result,session_id}` 形态的 JSON → 不去碰 jsonl，直接 finalize 落库。
//
// 与 executor.ts 当前实现 1:1 镜像。函数体改了请同步本脚本。
//
// 背景：之前 finalizeOrFailReconnect / reattachConversationTurn 在 finalizeConversationFromSession 返回
// false 时直接判 fail，丢弃 stdoutLogFile 里已写好的 result —— 重启窗口期跑完的轮被误判失败。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function conversationTurnClaudeLogPath(wtPath, turnId) {
  return path.join(wtPath, ".claude", `claude-turn-${turnId}.log`);
}

function lastJsonObjectInText(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const o = JSON.parse(trimmed);
    if (o && typeof o === "object") return o;
  } catch {}
  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? "";
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o === "object") return o;
    } catch {}
  }
  return null;
}

function recoverFromClaudeJsonOutput(captured) {
  if (!captured) return null;
  const parsed = lastJsonObjectInText(captured);
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed;
  if (p.is_error === true) return null;
  const body = typeof p.result === "string" ? p.result.trim() : "";
  if (!body) return null;
  const sessionId = typeof p.session_id === "string" ? p.session_id : null;
  return { body, sessionId };
}

// 模拟 tryRecoverConversationTurnFromClaudeLog 的核心：算路径 → 读文件 → recover → 落库 + 清理。
// finalize 用 spy 记录调用；保留与生产函数一致的返回语义（recovered 即 true）。
async function tryRecoverConversationTurnFromClaudeLog({ conversationId, messageId, wtPath, finalizeSpy }) {
  const file = conversationTurnClaudeLogPath(wtPath, messageId);
  let captured = null;
  try { captured = fs.readFileSync(file, "utf8"); } catch { /* 文件不存在 */ }
  const recovered = recoverFromClaudeJsonOutput(captured);
  if (!recovered) return false;
  finalizeSpy.push({
    conversationId,
    messageId,
    body: recovered.body,
    sessionId: recovered.sessionId
  });
  try { fs.unlinkSync(file); } catch {}
  return true;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctct-log-"));
  const wtPath = path.join(tmp, "worktree-fake");
  fs.mkdirSync(path.join(wtPath, ".claude"), { recursive: true });
  const turnId = "11111111-2222-3333-4444-555555555555";

  // case 1：路径与 executor 写入约定一致（worktree/.claude/claude-turn-<id>.log）
  const expected = path.join(wtPath, ".claude", `claude-turn-${turnId}.log`);
  assert.equal(conversationTurnClaudeLogPath(wtPath, turnId), expected);
  console.log("case 1 path layout matches executor:", "OK");

  // case 2：文件不存在 → recover 失败、不 finalize
  {
    const spy = [];
    const r = await tryRecoverConversationTurnFromClaudeLog({
      conversationId: "conv-2", messageId: turnId, wtPath, finalizeSpy: spy
    });
    assert.equal(r, false);
    assert.equal(spy.length, 0);
    console.log("case 2 missing file → false:", "OK");
  }

  // case 3：单行 JSON（典型 -p --output-format json 输出）→ recover 成功、finalize 拿到正确 body/session
  {
    fs.writeFileSync(expected, `{"session_id":"sess-A","result":"hello from claude","is_error":false}\n`);
    const spy = [];
    const r = await tryRecoverConversationTurnFromClaudeLog({
      conversationId: "conv-3", messageId: turnId, wtPath, finalizeSpy: spy
    });
    assert.equal(r, true);
    assert.deepEqual(spy, [{ conversationId: "conv-3", messageId: turnId, body: "hello from claude", sessionId: "sess-A" }]);
    assert.equal(fs.existsSync(expected), false, "recover 成功后 log 文件应被清理");
    console.log("case 3 single-line JSON → finalize + cleanup:", "OK");
  }

  // case 4：stderr 噪声 + 末行 JSON（生产里很常见，CLI 启动日志会先于 JSON 输出）
  {
    fs.writeFileSync(expected, [
      "[warn] cache miss",
      "[info] resuming session ...",
      `{"session_id":"sess-B","result":"recovered after stderr","is_error":false}`
    ].join("\n"));
    const spy = [];
    const r = await tryRecoverConversationTurnFromClaudeLog({
      conversationId: "conv-4", messageId: turnId, wtPath, finalizeSpy: spy
    });
    assert.equal(r, true);
    assert.deepEqual(spy[0], { conversationId: "conv-4", messageId: turnId, body: "recovered after stderr", sessionId: "sess-B" });
    console.log("case 4 stderr + tail-JSON → finalize:", "OK");
  }

  // case 5：is_error=true → 不挽回（按失败收尾，让上层把 stderr 截断到 error_message）
  {
    fs.writeFileSync(expected, `{"session_id":"sess-C","result":"Auth failed","is_error":true}`);
    const spy = [];
    const r = await tryRecoverConversationTurnFromClaudeLog({
      conversationId: "conv-5", messageId: turnId, wtPath, finalizeSpy: spy
    });
    assert.equal(r, false);
    assert.equal(spy.length, 0);
    console.log("case 5 is_error=true → false:", "OK");
  }

  // case 6：result 为空 → 不挽回
  {
    fs.writeFileSync(expected, `{"session_id":"sess-D","result":"   ","is_error":false}`);
    const spy = [];
    const r = await tryRecoverConversationTurnFromClaudeLog({
      conversationId: "conv-6", messageId: turnId, wtPath, finalizeSpy: spy
    });
    assert.equal(r, false);
    console.log("case 6 result whitespace → false:", "OK");
  }

  // case 7：完全是 stderr 噪声、无可解析 JSON → 不挽回
  {
    fs.writeFileSync(expected, "Error: Network unreachable\n  at fetch (...)\n");
    const spy = [];
    const r = await tryRecoverConversationTurnFromClaudeLog({
      conversationId: "conv-7", messageId: turnId, wtPath, finalizeSpy: spy
    });
    assert.equal(r, false);
    console.log("case 7 no JSON → false:", "OK");
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("\nOK — conversationTurnClaudeLogPath + recover wiring verified (7 cases)");
}

main().catch((e) => { console.error(e); process.exit(1); });
