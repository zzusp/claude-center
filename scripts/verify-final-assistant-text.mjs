#!/usr/bin/env node
// 一次性人工校验：apps/worker/src/executor.ts 里 extractFinalAssistantText 新加的 sinceMs 时间窗过滤。
//
// 背景：实时对话用 --resume 续写同一 .jsonl，文件里上一轮 assistant 文本仍在；旧实现扫整文件取末条 text，
// 一轮 claude 仅 thinking/tool_use 没出文本时，会把上一轮回答错绑到本轮 body（静默错配），或在无 text 时
// 用上一轮的兜底绕过失败兜底。新实现按 entry.timestamp >= sinceMs 仅留本轮条目。
//
// 与 executor.ts::extractFinalAssistantText 当前实现 1:1 镜像（函数没有依赖，直接复制函数体跑）。
// 函数体改了请同步本脚本。
import assert from "node:assert/strict";

function extractFinalAssistantText(jsonl, opts) {
  const sinceMs = opts?.sinceMs ?? null;
  let text = "";
  for (const line of jsonl.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (obj.type !== "assistant" || !obj.message) continue;
    if (obj.isMeta === true) continue;
    if (sinceMs !== null && typeof obj.timestamp === "string") {
      const ts = Date.parse(obj.timestamp);
      if (Number.isFinite(ts) && ts < sinceMs) continue;
    }
    const content = obj.message.content;
    let cur = "";
    if (typeof content === "string") {
      cur = content;
    } else if (Array.isArray(content)) {
      cur = content
        .filter((b) => b && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n");
    }
    if (cur.trim()) text = cur;
  }
  return text;
}

const t1 = "2026-06-27T03:00:00.000Z"; // 上一轮
const t2 = "2026-06-27T04:00:00.000Z"; // 本轮第一条
const t3 = "2026-06-27T04:00:05.000Z"; // 本轮 tool_use
const t4 = "2026-06-27T04:00:10.000Z"; // 本轮最后

function asst(ts, blocks, isMeta) {
  const o = { type: "assistant", timestamp: ts, message: { content: blocks } };
  if (isMeta) o.isMeta = true;
  return JSON.stringify(o);
}

// 场景 1：上轮有 text、本轮也有 text → 取本轮 text
{
  const jsonl = [
    asst(t1, [{ type: "text", text: "上一轮的回答" }]),
    asst(t2, [{ type: "thinking", thinking: "..." }, { type: "tool_use", id: "tu1", name: "Bash" }]),
    asst(t4, [{ type: "text", text: "本轮的回答" }])
  ].join("\n");
  assert.equal(extractFinalAssistantText(jsonl, { sinceMs: Date.parse(t2) - 5_000 }), "本轮的回答");
}

// 场景 2：上轮有 text、本轮仅 tool_use（无 text，被外部杀掉 / 模型中断）→ 不返回上轮 text，应返回 ""
//        这是核心修复点：旧实现会错绑上一轮文本到本轮 body。
{
  const jsonl = [
    asst(t1, [{ type: "text", text: "上一轮的回答" }]),
    asst(t2, [{ type: "thinking", thinking: "..." }, { type: "tool_use", id: "tu1", name: "Bash" }]),
    asst(t4, [{ type: "tool_use", id: "tu2", name: "Read" }])
  ].join("\n");
  assert.equal(extractFinalAssistantText(jsonl, { sinceMs: Date.parse(t2) - 5_000 }), "");
}

// 场景 3：本轮多次 assistant，中段有 text、末段是 tool_use → 取本轮中段 text（与旧"留住最后一条有正文"语义一致）
{
  const jsonl = [
    asst(t1, [{ type: "text", text: "上一轮的回答" }]),
    asst(t2, [{ type: "tool_use", id: "tu0", name: "Read" }]),
    asst(t3, [{ type: "text", text: "本轮中段说明" }]),
    asst(t4, [{ type: "tool_use", id: "tu1", name: "Bash" }])
  ].join("\n");
  assert.equal(extractFinalAssistantText(jsonl, { sinceMs: Date.parse(t2) - 5_000 }), "本轮中段说明");
}

// 场景 4：未传 sinceMs（runner reattach 时无 startedAt 走兜底）→ 退化为旧行为，取全文件末条 text
{
  const jsonl = [
    asst(t1, [{ type: "text", text: "更早的回答" }]),
    asst(t4, [{ type: "text", text: "最终回答" }])
  ].join("\n");
  assert.equal(extractFinalAssistantText(jsonl), "最终回答");
  assert.equal(extractFinalAssistantText(jsonl, { sinceMs: null }), "最终回答");
}

// 场景 5：isMeta:true 的 assistant 注入仍被过滤（已有逻辑，回归保护）
{
  const jsonl = [
    asst(t2, [{ type: "text", text: "正文" }]),
    asst(t4, [{ type: "text", text: "内部注入不算" }], true)
  ].join("\n");
  assert.equal(extractFinalAssistantText(jsonl, { sinceMs: Date.parse(t2) - 5_000 }), "正文");
}

// 场景 6：entry 缺 timestamp → 保守保留（不卡 sinceMs）
{
  const jsonl = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "无时间戳条目" }] } })
  ].join("\n");
  assert.equal(extractFinalAssistantText(jsonl, { sinceMs: Date.parse(t4) }), "无时间戳条目");
}

console.log("OK — extractFinalAssistantText sinceMs window filter verified (6 cases)");
