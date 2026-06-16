"use client";

import type { DirectCommand } from "@claude-center/db";
import { ChevronDown, ChevronRight, Send, Terminal } from "lucide-react";
import { useCallback, useState } from "react";
import { StatusBadge, fmtDateTime, postJson } from "./shared";
import { usePolling } from "../lib/use-polling";

// 从指令 result（jsonb）里安全取字符串字段。
function resultStr(result: Record<string, unknown>, key: string): string {
  const value = result[key];
  return typeof value === "string" ? value : "";
}

function resultExit(result: Record<string, unknown>): number | null {
  const value = result.exitCode;
  return typeof value === "number" ? value : null;
}

// worker 详情页「下发命令」面板：向该 worker 下发一条终端命令（走既有 /api/direct-commands → SSE/轮询），
// 在其配置的运行终端里执行，并回显历史指令的状态 + stdout/stderr/退出码。仅 admin（canCommand）渲染。
export function WorkerCommandPanel({
  workerId,
  terminalCommand,
  preCommand
}: {
  workerId: string;
  terminalCommand: string;
  preCommand: string;
}) {
  const [text, setText] = useState("");
  const [cwd, setCwd] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [commands, setCommands] = useState<DirectCommand[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(
    async (isActive: () => boolean) => {
      try {
        const res = await fetch(`/api/workers/${workerId}/direct-commands`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { commands?: DirectCommand[] };
        if (isActive()) setCommands(data.commands ?? []);
      } catch {
        /* 轮询失败静默 */
      }
    },
    [workerId]
  );

  usePolling(load, [workerId]);

  async function submit() {
    const command = text.trim();
    if (!command || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      await postJson("/api/direct-commands", {
        workerId,
        command: "shell",
        text: command,
        cwd: cwd.trim() || undefined
      });
      setText("");
      // 下发后立刻拉一次历史，让新指令秒级出现（不必等下一轮轮询）。
      await load(() => true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "下发失败");
    } finally {
      setSubmitting(false);
    }
  }

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const terminalLabel = terminalCommand || "系统默认终端";

  return (
    <div className="cmd-panel">
      <p className="remote-hint" style={{ margin: 0 }}>
        在该 Worker 的运行终端（
        <span className="mono">{terminalLabel}</span>
        {preCommand ? " + 前置命令" : ""}
        ）中按其语法执行，结果回显在下方。
      </p>

      <textarea
        className="mono"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void submit();
          }
        }}
        placeholder="按所选终端语法书写，如：git -C D:\\repo pull（Ctrl/Cmd+Enter 下发）"
        rows={3}
      />
      <div className="cmd-row">
        <input
          className="mono cmd-cwd"
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="工作目录（可选，留空用终端默认）"
        />
        <button type="button" className="btn btn-sm" disabled={submitting || !text.trim()} onClick={submit}>
          <Send size={13} />
          {submitting ? "下发中…" : "下发"}
        </button>
      </div>
      {error ? <p className="remote-hint" style={{ color: "var(--failed)", margin: 0 }}>{error}</p> : null}

      <div className="cmd-history">
        {commands.length === 0 ? (
          <div className="remote-hint">暂无下发记录</div>
        ) : (
          commands.map((cmd) => {
            const isOpen = expanded.has(cmd.id);
            const stdout = resultStr(cmd.result, "stdout");
            const stderr = resultStr(cmd.result, "stderr");
            const exit = resultExit(cmd.result);
            const hasDetail = Boolean(stdout || stderr || cmd.error_message);
            return (
              <div className="cmd-item" key={cmd.id}>
                <button
                  type="button"
                  className="cmd-item-head"
                  onClick={() => hasDetail && toggle(cmd.id)}
                  disabled={!hasDetail}
                >
                  {hasDetail ? (
                    isOpen ? <ChevronDown size={13} className="ico" /> : <ChevronRight size={13} className="ico" />
                  ) : (
                    <Terminal size={13} className="ico" />
                  )}
                  <span className="cmd-text mono">{cmd.command === "shell" ? (cmd.payload.text as string) : `claude: ${cmd.payload.text as string}`}</span>
                  <StatusBadge status={cmd.status} />
                  {exit !== null ? <span className="cmd-exit mono">exit {exit}</span> : null}
                  <span className="cmd-time">{fmtDateTime(cmd.created_at)}</span>
                </button>
                {isOpen && hasDetail ? (
                  <div className="cmd-detail">
                    {cmd.error_message ? (
                      <pre className="cmd-out cmd-out-err">{cmd.error_message}</pre>
                    ) : null}
                    {stdout ? (
                      <pre className="cmd-out">{stdout}</pre>
                    ) : null}
                    {stderr ? (
                      <pre className="cmd-out cmd-out-err">{stderr}</pre>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
