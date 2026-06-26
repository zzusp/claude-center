"use client";

import { ChevronRight, Wrench } from "lucide-react";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { extractBackgroundJobs, isMetaUserEntry, parseTranscript, pendingBackgroundJobs } from "./transcript-parse";
import type { BackgroundJob, TBlock, TItem } from "./transcript-parse";

// Claude Code session .jsonl 富展示：解析 NDJSON → 消息块，渲染为带工具折叠 / diff / markdown / thinking 的
// 会话回放。任务详情与对话页共用（移植自 claude-code-session 的 MessageBubble / ToolBlock / MarkdownContent）。
// 纯解析逻辑（parseTranscript / extractBackgroundJobs / isMetaUserEntry）在 transcript-parse.ts，
// 无 React 依赖、可被 e2e / 服务端 import；这里只放渲染组件 + re-export 兼容已有 import 路径。

export { extractBackgroundJobs, isMetaUserEntry, parseTranscript, pendingBackgroundJobs };
export type { BackgroundJob, TBlock, TItem };

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

// 首屏只挂载末尾 FIRST_BATCH 条消息（视口 + 一屏缓冲），剩下在浏览器 idle 时一次性挂上：
// 长对话从「同步渲染 500+ 块」降到「同步渲染 30 块」，首屏可感秒出；往上滚有极短挂载延迟，绝大多数场景无感。
const FIRST_BATCH = 30;

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

  const [revealed, setRevealed] = useState(() => Math.min(FIRST_BATCH, items.length));

  // items.length 增长时（轮询拉到新消息）也跟着抬高已揭示数量；避免 100 条对话首屏只显示 30 后
  // 再增长到 130 时仍然停在 30。
  useEffect(() => {
    setRevealed((cur) => Math.max(cur, Math.min(FIRST_BATCH, items.length)));
  }, [items.length]);

  // 全量挂载：浏览器空闲时把剩余消息一次性补上。requestIdleCallback 不可用（Safari < 15.4 / 旧 Firefox）
  // 时回退到 setTimeout(16)，无功能性降级。
  useEffect(() => {
    if (revealed >= items.length) return;
    type IdleHandle = number;
    type RIC = (cb: () => void) => IdleHandle;
    type CIC = (h: IdleHandle) => void;
    const w = window as unknown as { requestIdleCallback?: RIC; cancelIdleCallback?: CIC };
    const ric: RIC = w.requestIdleCallback ?? ((cb) => window.setTimeout(cb, 16) as unknown as IdleHandle);
    const cic: CIC = w.cancelIdleCallback ?? ((h) => window.clearTimeout(h as unknown as number));
    const handle = ric(() => setRevealed(items.length));
    return () => cic(handle);
  }, [items.length, revealed]);

  // items 按时间正序：末尾 revealed 条先挂，前面延后；保证首屏可见范围（底部）立即渲染。
  const start = Math.max(0, items.length - revealed);
  const visible = items.slice(start);

  return (
    <div className="tx">
      {visible.map((item, i) => {
        const renderable = item.blocks.filter((b) => b.kind !== "tool_result");
        if (renderable.length === 0) return null;
        return <MessageRow key={start + i} role={item.role} blocks={renderable} results={results} />;
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

// 命中任一 markdown 特征就走 ReactMarkdown；否则当纯文本展示，省掉 remark 解析 + JSX 树构建：
// 反引号 / # / * / _ / ~ / [..](..)（链接） / 行首 - 或 > / 有序列表 / 空行段落 / 表格管道。
// 误判方向安全：把 markdown 当纯文本会显示原 markdown 字符（不破坏内容），把纯文本当 markdown 多花 CPU 不影响显示。
function hasMarkdownFeatures(text: string): boolean {
  return /[`#*_~]|\[[^\]]+\]\(|^\s*[->]|^\s*\d+\.\s|\n\n|^\s*\|/m.test(text);
}

function BlockView({ block, results }: { block: TBlock; results: Map<string, ToolResult> }) {
  if (block.kind === "text") {
    return (
      <div className="tx-text">
        {hasMarkdownFeatures(block.text) ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.text}</ReactMarkdown>
        ) : (
          <span style={{ whiteSpace: "pre-wrap" }}>{block.text}</span>
        )}
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
