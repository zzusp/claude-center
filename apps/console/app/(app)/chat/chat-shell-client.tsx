"use client";

import type { Conversation, Project, Worker } from "@claude-center/db";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChatView } from "../../ui/chat";
import { registerRelayListener } from "../../lib/use-relay";

type ProjectWithConversations = Project & { conversations?: Conversation[] };

// 实时对话总外壳（/chat 与 /chat/[projectId] 共用）：进页面一次性拉 projects(+conversations) + workers，
// 然后把项目树 + 会话历史 + 消息线交给 ChatView 渲染。
// URL ↔ 内部态：组件不持有 expanded/active，而是用 `history.replaceState` 把它们静默映射到 URL（不触发 Next
// 路由跳转），刷新 / 分享仍能还原；切项目时本组件不重挂、不重新发请求。ChatView 内部只复用一份 React 态。
//
// 刷新策略：① mount 拉一次 ② onRequestRefresh（增删改）触发一次 ③ relay 事件 200ms 合并触发一次。
// 不挂周期定时器，避免每 3s 全量重拉；relay 关闭时仍可通过用户操作触发。
export default function ChatShellClient({
  initialProjectId,
  initialConversationId,
  canCommand
}: {
  initialProjectId: string | null;
  initialConversationId: string | null;
  canCommand: boolean;
}) {
  const [projects, setProjects] = useState<ProjectWithConversations[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [pr, wr] = await Promise.all([
        fetch("/api/projects?include=conversations", { cache: "no-store" }),
        fetch("/api/workers", { cache: "no-store" })
      ]);
      if (pr.ok) {
        setProjects(((await pr.json()) as { projects: ProjectWithConversations[] }).projects);
      }
      if (wr.ok) setWorkers(((await wr.json()) as { workers: Worker[] }).workers);
    } catch {
      // 单次失败忽略，下次用户操作或下一个 relay 事件会再触发一次。
    }
  }, []);

  // 项目附带的 conversations 字段提取出来按 projectId 索引，喂给 ChatView 做「展开即显」。
  // 字段从展示 Project 里剥离（避免污染下游消费 Project 的组件）。
  const { sanitizedProjects, conversationsByProject } = useMemo(() => {
    const byProject: Record<string, Conversation[]> = {};
    const cleaned: Project[] = projects.map((p) => {
      const { conversations, ...rest } = p;
      if (conversations) byProject[p.id] = conversations;
      return rest as Project;
    });
    return { sanitizedProjects: cleaned, conversationsByProject: byProject };
  }, [projects]);

  // mount 拉一次 + 订阅 relay 事件即时刷新（200ms 合并窗：爆发事件并为 1 次）。
  // 不挂 setInterval：用户已选择「仅事件触发」，避免周期全量重拉。
  useEffect(() => {
    let active = true;
    let inflight = false;
    let pending = false;
    let coalesceTimer: number | null = null;
    const run = async (): Promise<void> => {
      if (!active) return;
      if (inflight) {
        pending = true;
        return;
      }
      inflight = true;
      try {
        await refresh();
      } finally {
        inflight = false;
        if (active && pending) {
          pending = false;
          void run();
        }
      }
    };
    void run().finally(() => {
      if (active) setLoaded(true);
    });
    const unregister = registerRelayListener(() => {
      if (!active || coalesceTimer !== null) return;
      coalesceTimer = window.setTimeout(() => {
        coalesceTimer = null;
        void run();
      }, 200);
    });
    return () => {
      active = false;
      if (coalesceTimer !== null) window.clearTimeout(coalesceTimer);
      unregister();
    };
  }, [refresh]);

  // URL 静默同步（不触发 Next 路由切换，避免 ChatShellClient 重挂导致整页重拉）。
  // history.replaceState 不会被 Next 拦截，刷新页面仍能从 URL 还原 initialProjectId/initialConversationId。
  function handleProjectChange(projectId: string | null): void {
    const url = projectId ? `/chat/${projectId}` : "/chat";
    window.history.replaceState(null, "", url);
  }

  function handleConversationChange(projectId: string, conversationId: string | null): void {
    const url = conversationId
      ? `/chat/${projectId}?c=${conversationId}`
      : `/chat/${projectId}`;
    window.history.replaceState(null, "", url);
  }

  return (
    <ChatView
      initialProjectId={initialProjectId}
      initialConversationId={initialConversationId}
      projects={sanitizedProjects}
      conversationsByProject={conversationsByProject}
      workers={workers}
      loaded={loaded}
      canCommand={canCommand}
      onRequestRefresh={refresh}
      onProjectChange={handleProjectChange}
      onConversationChange={handleConversationChange}
    />
  );
}
