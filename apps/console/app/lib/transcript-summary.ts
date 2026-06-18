// 服务端安全（无 React）的 session transcript 摘要器：把 Claude Code session .jsonl 压成「存活信号」——
// 最后活动时间 / 工具调用数 / 当前在干嘛。概览在途时轮询 /session/progress 用，避免把整段 blob 拖到前端，
// 也用于一眼区分「在跑」与「卡死」（docs/spec/worktree-exec-observability.md §1）。
export type TranscriptSummary = {
  lastActivityAt: string | null;
  toolCount: number;
  lastStep: string | null;
};

type ContentItem = {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
};

type TranscriptLine = {
  type?: string;
  timestamp?: string;
  message?: { content?: ContentItem[] | string };
  result?: unknown;
};

// 给工具调用挑一个简短可读的提示：优先文件名（取 basename），否则 description/pattern/command/prompt 截断。
function toolHint(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  const pick = (key: string): string | null => {
    const value = input[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  const filePath = pick("file_path");
  if (filePath) return ` ${filePath.split(/[\\/]/).pop()}`;
  const hint = pick("description") ?? pick("pattern") ?? pick("command") ?? pick("prompt");
  return hint ? ` ${hint.replace(/\s+/g, " ").slice(0, 48)}` : "";
}

// transcript 是 append-only、时间单调递增的 jsonl；顺序扫到最后一个有意义的 step / 时间戳即为当前态。
export function summarizeTranscript(jsonl: string | null): TranscriptSummary {
  if (!jsonl) return { lastActivityAt: null, toolCount: 0, lastStep: null };
  let lastActivityAt: string | null = null;
  let toolCount = 0;
  let lastStep: string | null = null;

  for (const raw of jsonl.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(line) as TranscriptLine;
    } catch {
      continue;
    }
    if (typeof parsed.timestamp === "string") lastActivityAt = parsed.timestamp;

    const content = parsed.message?.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item.type === "tool_use") {
          toolCount += 1;
          lastStep = `${item.name ?? "tool"}${toolHint(item.input)}`;
        } else if (item.type === "text" && typeof item.text === "string" && item.text.trim()) {
          lastStep = item.text.replace(/\s+/g, " ").trim().slice(0, 80);
        }
      }
    } else if (parsed.type === "result" && typeof parsed.result === "string" && parsed.result.trim()) {
      lastStep = parsed.result.replace(/\s+/g, " ").trim().slice(0, 80);
    }
  }

  return { lastActivityAt, toolCount, lastStep };
}
