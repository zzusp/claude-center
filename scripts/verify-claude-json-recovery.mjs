#!/usr/bin/env node
// 一次性人工校验：apps/worker/src/executor.ts 里 recoverFromClaudeJsonOutput / lastJsonObjectInText 的兜底解析。
//
// 背景：远端 worker 出现「特定对话连续 7+ 轮全失败、conversation_sessions 一直没数据 / claude 不写 jsonl，
// 但 stdio:'ignore' 把 claude `-p --output-format json` 的 stdout 也丢了」。改成把 stdout/stderr 写文件后，
// 即便 jsonl 缺失也能从 stdout 的 JSON 行里挽回 { session_id, result } 直接收尾。
//
// 与 executor.ts 当前实现 1:1 镜像，函数体改了请同步本脚本。
import assert from "node:assert/strict";

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

// 场景 1：单行 JSON（典型 -p --output-format json 输出）
{
  const captured = `{"session_id":"sess-1","result":"你好，已收到","is_error":false,"usage":{}}\n`;
  const r = recoverFromClaudeJsonOutput(captured);
  assert.deepEqual(r, { body: "你好，已收到", sessionId: "sess-1" });
}

// 场景 2：stdout 前混杂 stderr 几行噪声，最后一行才是 JSON
{
  const captured = [
    "warning: proxy auth retry",
    "[debug] http request taking long",
    `{"session_id":"sess-2","result":"测试结果文本","is_error":false}`
  ].join("\n");
  const r = recoverFromClaudeJsonOutput(captured);
  assert.deepEqual(r, { body: "测试结果文本", sessionId: "sess-2" });
}

// 场景 3：is_error=true → 不挽回（按失败收尾，让 error_message 走 stderr 截断的路径）
{
  const captured = `{"session_id":"sess-3","result":"Auth failed","is_error":true}`;
  assert.equal(recoverFromClaudeJsonOutput(captured), null);
}

// 场景 4：JSON 里 result 为空 / 仅空白 → 不挽回
{
  const captured = `{"session_id":"sess-4","result":"   ","is_error":false}`;
  assert.equal(recoverFromClaudeJsonOutput(captured), null);
}

// 场景 5：没有任何可解析 JSON → 不挽回
{
  const captured = `Error: Network unreachable\nat fetch ()\n`;
  assert.equal(recoverFromClaudeJsonOutput(captured), null);
}

// 场景 6：session_id 缺失也能挽回（仅有 result 即可，sessionId 兜底为 null）
{
  const captured = `{"result":"only result"}`;
  assert.deepEqual(recoverFromClaudeJsonOutput(captured), { body: "only result", sessionId: null });
}

// 场景 7：null / 空字符串 → 不挽回
assert.equal(recoverFromClaudeJsonOutput(null), null);
assert.equal(recoverFromClaudeJsonOutput(""), null);
assert.equal(recoverFromClaudeJsonOutput("   \n\n"), null);

// 场景 8：JSON 数组（非 object）→ 不挽回
{
  const captured = `["session_id","sess-8"]`;
  assert.equal(recoverFromClaudeJsonOutput(captured), null);
}

console.log("OK — recoverFromClaudeJsonOutput / lastJsonObjectInText verified (8 cases)");
