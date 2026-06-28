// Claude Code session .jsonl 的纯解析层（无 React 依赖，可被 Node 测试 / 服务端 / 桌面端按需 import）。
// transcript.tsx 是渲染层，引用本模块取这些纯函数；任何解析规则的修改都该在这里、配上单元/合成 fixture 验证。

export type TBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; toolUseId: string | null; text: string; isError: boolean };

// ts：jsonl 行自带的 timestamp（ISO 字符串），用来给 TranscriptView 按时间插入失败错误条；旧 jsonl 可能没有 → null。
export type TItem = { role: "user" | "assistant"; ts: string | null; blocks: TBlock[] };

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

// 命令 / skill 加载 / 系统提示等内部注入消息的判定：Claude 把这些以 type=user 写入 jsonl，
// 标 isMeta=true（或内容是 <local-command-caveat>/<command-name>/<command-message>/<local-command-stdout>
// 这类 XML 标签），并非用户真发的话。早期把它们当作用户气泡渲染（如加载某个 skill 时显示该 skill 的整段文档），
// 此处统一过滤掉。
export function isMetaUserEntry(obj: { type?: string; isMeta?: unknown; message?: { content?: unknown } }): boolean {
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
    let obj: { type?: string; isMeta?: unknown; timestamp?: unknown; message?: { content?: unknown } };
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
    const ts = typeof obj.timestamp === "string" ? obj.timestamp : null;
    if (blocks.length) items.push({ role: obj.type as "user" | "assistant", ts, blocks });
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
