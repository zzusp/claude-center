"use client";

import { ChevronRight, Wrench } from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Claude Code session .jsonl 富展示：解析 NDJSON → 消息块，渲染为带工具折叠 / diff / markdown / thinking 的
// 会话回放。任务详情与对话页共用（移植自 claude-code-session 的 MessageBubble / ToolBlock / MarkdownContent）。

export type TBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; toolUseId: string | null; text: string; isError: boolean };

export type TItem = { role: "user" | "assistant"; blocks: TBlock[] };
type ToolResult = { text: string; isError: boolean };

const TRUNCATE = 4000;
const RESULT_PREVIEW = 280;

function clip(text: string): string {
  return text.length > TRUNCATE ? `${text.slice(0, TRUNCATE)}\n… (已截断 ${text.length - TRUNCATE} 字)` : text;
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function stringifyInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

// tool_result.content 可能是字符串或 [{type:'text',text}] 块数组。
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""
      )
      .filter(Boolean)
      .join("\n");
  }
  return content == null ? "" : stringifyInput(content);
}

function tailPath(p: string): string {
  if (!p) return "";
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join("/")}`;
}

// 折叠头摘要：读起来像自然语句（文件尾部路径 / 命令首行 / pattern）。
function toolSummary(name: string, input: unknown): string {
  const o = asRecord(input);
  if (name === "Bash" || name === "PowerShell") return str(o.command).split("\n")[0]?.slice(0, 140) ?? "";
  if (name === "Read" || name === "Write" || name === "Edit" || name === "MultiEdit" || name === "NotebookEdit") {
    return tailPath(str(o.file_path) || str(o.notebook_path));
  }
  if (name === "Grep" || name === "Glob") return str(o.pattern);
  if (name === "Task") return str(o.description);
  if (name === "WebFetch") return str(o.url);
  return "";
}

// 解析 Claude Code session .jsonl（NDJSON）：取 user/assistant 且带 message 的行，content 归一化为块。
// tool_use 保留原始 input（按工具特化渲染），tool_result 带 tool_use_id（配对到对应调用下）。
export function parseTranscript(jsonl: string): TItem[] {
  const items: TItem[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: { type?: string; message?: { content?: unknown } };
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if ((obj.type !== "user" && obj.type !== "assistant") || !obj.message) continue;
    const content = obj.message.content;
    const raw = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
    const blocks: TBlock[] = [];
    for (const b of raw as Array<Record<string, unknown>>) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        blocks.push({ kind: "text", text: b.text });
      } else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
        blocks.push({ kind: "thinking", text: b.thinking });
      } else if (b.type === "tool_use") {
        blocks.push({ kind: "tool_use", id: str(b.id), name: str(b.name) || "tool", input: b.input });
      } else if (b.type === "tool_result") {
        blocks.push({
          kind: "tool_result",
          toolUseId: typeof b.tool_use_id === "string" ? b.tool_use_id : null,
          text: toolResultText(b.content),
          isError: Boolean(b.is_error)
        });
      }
    }
    if (blocks.length) items.push({ role: obj.type, blocks });
  }
  return items;
}

export function TranscriptView({ items }: { items: TItem[] }) {
  // 配对：tool_use_id → 工具返回（claude 把 tool_result 放进下一条 user 消息）。配对后该 result 显示在调用下，
  // 该「纯 tool_result」的 user 消息整条不再渲染为气泡。
  const results = new Map<string, ToolResult>();
  for (const it of items) {
    for (const b of it.blocks) {
      if (b.kind === "tool_result" && b.toolUseId) {
        results.set(b.toolUseId, { text: b.text, isError: b.isError });
      }
    }
  }
  return (
    <div className="tx">
      {items.map((item, i) => {
        const renderable = item.blocks.filter((b) => b.kind !== "tool_result");
        if (renderable.length === 0) return null;
        return <MessageRow key={i} role={item.role} blocks={renderable} results={results} />;
      })}
    </div>
  );
}

function MessageRow({ role, blocks, results }: { role: "user" | "assistant"; blocks: TBlock[]; results: Map<string, ToolResult> }) {
  const isUser = role === "user";
  return (
    <div className={`tx-row ${isUser ? "user" : "asst"}`}>
      <div className={`tx-msg ${isUser ? "user" : "asst"}`}>
        {blocks.map((b, i) => (
          <BlockView key={i} block={b} results={results} />
        ))}
      </div>
    </div>
  );
}

function BlockView({ block, results }: { block: TBlock; results: Map<string, ToolResult> }) {
  if (block.kind === "text") {
    return (
      <div className="tx-text">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.text}</ReactMarkdown>
      </div>
    );
  }
  if (block.kind === "thinking") {
    return <ThinkingBlock text={block.text} />;
  }
  if (block.kind === "tool_use") {
    return <ToolUseBlock name={block.name} input={block.input} result={block.id ? results.get(block.id) : undefined} />;
  }
  return null; // tool_result 已配对到工具调用下，不单独渲染
}

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tx-think">
      <button type="button" className="tx-fold-head" onClick={() => setOpen((v) => !v)}>
        <ChevronRight size={13} className={`tx-caret${open ? " open" : ""}`} />
        <span className="tx-think-label">💭 思考</span>
      </button>
      {open ? <pre className="tx-fold-body">{clip(text)}</pre> : null}
    </div>
  );
}

function ToolUseBlock({ name, input, result }: { name: string; input: unknown; result?: ToolResult }) {
  const [open, setOpen] = useState(false);
  const summary = toolSummary(name, input);
  return (
    <div className="tx-tool" data-error={result?.isError ? "1" : undefined}>
      <button type="button" className="tx-fold-head" onClick={() => setOpen((v) => !v)}>
        <ChevronRight size={13} className={`tx-caret${open ? " open" : ""}`} />
        <Wrench size={12} className="tx-tool-ico" />
        <span className="tx-tool-name">{name}</span>
        {summary ? <span className="tx-tool-sum">{summary}</span> : null}
        {result?.isError ? <span className="tx-tool-badge">错误</span> : null}
      </button>
      {open ? (
        <div className="tx-fold-body">
          <ToolInput name={name} input={input} />
          {result ? <ToolResultView text={result.text} isError={result.isError} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function ToolInput({ name, input }: { name: string; input: unknown }) {
  const o = asRecord(input);
  if (name === "Edit" && typeof o.old_string === "string" && typeof o.new_string === "string") {
    return <Diff oldText={o.old_string} newText={o.new_string} />;
  }
  if (name === "Write" && typeof o.content === "string") {
    return <Diff oldText="" newText={o.content} />;
  }
  if (name === "MultiEdit" && Array.isArray(o.edits)) {
    return (
      <>
        {(o.edits as Array<Record<string, unknown>>).map((e, i) => (
          <Diff key={i} oldText={str(e.old_string)} newText={str(e.new_string)} />
        ))}
      </>
    );
  }
  if ((name === "Bash" || name === "PowerShell") && typeof o.command === "string") {
    return <pre className="tx-cmd">{clip(o.command)}</pre>;
  }
  const s = stringifyInput(input);
  return s ? <pre className="tx-json">{clip(s)}</pre> : null;
}

function Diff({ oldText, newText }: { oldText: string; newText: string }) {
  const oldLines = oldText ? oldText.split("\n") : [];
  const newLines = newText ? newText.split("\n") : [];
  return (
    <pre className="tx-diff">
      {oldLines.map((l, i) => (
        <div key={`o${i}`} className="tx-diff-del">
          {`- ${l}`}
        </div>
      ))}
      {newLines.map((l, i) => (
        <div key={`n${i}`} className="tx-diff-add">
          {`+ ${l}`}
        </div>
      ))}
    </pre>
  );
}

function ToolResultView({ text, isError }: { text: string; isError: boolean }) {
  const [open, setOpen] = useState(false);
  const long = text.length > RESULT_PREVIEW;
  const shown = open || !long ? text : text.slice(0, RESULT_PREVIEW);
  return (
    <div className={`tx-result${isError ? " err" : ""}`}>
      <div className="tx-result-head">{isError ? "⚠ 工具返回" : "↳ 工具返回"}</div>
      {text ? <pre className="tx-result-body">{clip(shown)}</pre> : null}
      {long ? (
        <button type="button" className="tx-more" onClick={() => setOpen((v) => !v)}>
          {open ? "收起" : "展开全部"}
        </button>
      ) : null}
    </div>
  );
}
