"use client";

import { ChevronRight, Wrench } from "lucide-react";
import { useEffect, useState } from "react";
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

// 命令 / skill 加载 / 系统提示等内部注入消息的判定：Claude 把这些以 type=user 写入 jsonl，
// 标 isMeta=true（或内容是 <local-command-caveat>/<command-name>/<command-message>/<local-command-stdout>
// 这类 XML 标签），并非用户真发的话。早期把它们当作用户气泡渲染（如加载某个 skill 时显示该 skill 的整段文档），
// 此处统一过滤掉。
function isMetaUserEntry(obj: { type?: string; isMeta?: unknown; message?: { content?: unknown } }): boolean {
  if (obj.type !== "user") return false;
  if (obj.isMeta === true) return true;
  const content = obj.message?.content;
  let head = "";
  if (typeof content === "string") {
    head = content.trimStart().slice(0, 80);
  } else if (Array.isArray(content)) {
    const first = (content as Array<Record<string, unknown>>).find(
      (b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string"
    );
    head = first ? (first.text as string).trimStart().slice(0, 80) : "";
  }
  return /^<(local-command-caveat|local-command-stdout|command-name|command-message|command-args|system-reminder)\b/.test(head);
}

// 解析 Claude Code session .jsonl（NDJSON）：取 user/assistant 且带 message 的行，content 归一化为块。
// tool_use 保留原始 input（按工具特化渲染），tool_result 带 tool_use_id（配对到对应调用下）。
export function parseTranscript(jsonl: string): TItem[] {
  const items: TItem[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: { type?: string; isMeta?: unknown; message?: { content?: unknown } };
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if ((obj.type !== "user" && obj.type !== "assistant") || !obj.message) continue;
    if (isMetaUserEntry(obj)) continue;
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

// 「后台进程」结构：Claude 用 Bash 带 run_in_background:true 启动一个后台命令，tool_result 携带
// backgroundTaskId（短哈希），后续完成后由 Claude Code 注入 type=attachment + attachment.type=queued_command
// 的 <task-notification> 唤醒主对话。主对话本轮 assistant 已落完最后一段文字时，往往还有若干后台任务在跑——
// 此时不算「真正结束」：再下一轮才是后台完成回写后的最终答。这里扫一遍 jsonl 把「已派发 - 已完成」算出来。
export type BackgroundJob = {
  id: string;            // backgroundTaskId（短哈希）
  description: string;   // 命令的 description（无则取命令首行）
  startedAt: string | null;
  finishedAt: string | null;
  status: "running" | "completed" | "failed" | "killed";
  summary: string | null;
};

const BG_STATUS_RE = /<status>([^<]*)<\/status>/;
const BG_TASKID_RE = /<task-id>([^<]*)<\/task-id>/;
const BG_SUMMARY_RE = /<summary>([\s\S]*?)<\/summary>/;

export function extractBackgroundJobs(jsonl: string | null | undefined): BackgroundJob[] {
  if (!jsonl) return [];
  const byId = new Map<string, BackgroundJob>();
  const toolUseDesc = new Map<string, string>(); // tool_use_id → description

  for (const line of jsonl.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = typeof obj.timestamp === "string" ? (obj.timestamp as string) : null;

    // assistant: tool_use Bash with run_in_background → 记 description（按 tool_use_id 索引，等后续 result 携带 backgroundTaskId 时回填）
    if (obj.type === "assistant") {
      const msg = obj.message as { content?: unknown } | undefined;
      const blocks = Array.isArray(msg?.content) ? (msg!.content as Array<Record<string, unknown>>) : [];
      for (const b of blocks) {
        if (b && b.type === "tool_use" && b.name === "Bash") {
          const input = (b.input as Record<string, unknown>) || {};
          if (input.run_in_background === true) {
            const id = typeof b.id === "string" ? b.id : null;
            const desc =
              (typeof input.description === "string" && input.description.trim()) ||
              (typeof input.command === "string" ? (input.command as string).split("\n")[0]?.slice(0, 140) : "") ||
              "(后台命令)";
            if (id) toolUseDesc.set(id, desc);
          }
        }
      }
      continue;
    }

    // user 行的 tool_result 携带 backgroundTaskId → 入表 running
    if (obj.type === "user") {
      const msg = obj.message as { content?: unknown } | undefined;
      const blocks = Array.isArray(msg?.content) ? (msg!.content as Array<Record<string, unknown>>) : [];
      for (const b of blocks) {
        if (b && b.type === "tool_result") {
          const tur = obj.toolUseResult as { backgroundTaskId?: unknown } | undefined;
          const bgId = typeof tur?.backgroundTaskId === "string" ? tur.backgroundTaskId : null;
          if (bgId) {
            const tuId = typeof b.tool_use_id === "string" ? b.tool_use_id : null;
            const desc = (tuId && toolUseDesc.get(tuId)) || "(后台命令)";
            if (!byId.has(bgId)) {
              byId.set(bgId, {
                id: bgId,
                description: desc,
                startedAt: ts,
                finishedAt: null,
                status: "running",
                summary: null
              });
            }
          }
        }
      }
      continue;
    }

    // attachment.queued_command 的 <task-notification>：完成通知 → 翻转 status / 记完成时间
    if (obj.type === "attachment") {
      const attachment = obj.attachment as { type?: unknown; prompt?: unknown; content?: unknown } | undefined;
      if (attachment?.type !== "queued_command") continue;
      const prompt = typeof attachment.prompt === "string" ? attachment.prompt : "";
      if (!prompt.includes("<task-notification>")) continue;
      const idMatch = BG_TASKID_RE.exec(prompt);
      const statusMatch = BG_STATUS_RE.exec(prompt);
      const summaryMatch = BG_SUMMARY_RE.exec(prompt);
      const id = idMatch?.[1]?.trim();
      if (!id) continue;
      const raw = (statusMatch?.[1] ?? "").trim().toLowerCase();
      const status: BackgroundJob["status"] =
        raw === "completed" ? "completed" : raw === "failed" ? "failed" : raw === "killed" ? "killed" : "running";
      const existing = byId.get(id);
      if (existing) {
        existing.status = status;
        existing.finishedAt = ts ?? existing.finishedAt;
        if (summaryMatch?.[1]) existing.summary = summaryMatch[1].trim();
      } else {
        // 没见过 spawn 时也补一条（保守：派发记录可能在更早 / 跨 session）
        byId.set(id, {
          id,
          description: "(后台命令)",
          startedAt: null,
          finishedAt: ts,
          status,
          summary: summaryMatch?.[1] ? summaryMatch[1].trim() : null
        });
      }
    }
  }
  return Array.from(byId.values());
}

export function pendingBackgroundJobs(jobs: BackgroundJob[]): BackgroundJob[] {
  return jobs.filter((j) => j.status === "running");
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
