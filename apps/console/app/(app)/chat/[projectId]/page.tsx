import { redirect } from "next/navigation";
import { getCurrentUser } from "../../../lib/session";
import ChatShellClient from "../chat-shell-client";

export const dynamic = "force-dynamic";

// 实时对话工作台（指定项目）：与首页共用 ChatShell，只是把 projectId 作为初始展开项 + 可带 ?c=<convId> 定位会话。
export default async function Page({
  params,
  searchParams
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ c?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  const { projectId } = await params;
  const { c } = await searchParams;
  return (
    <ChatShellClient
      initialProjectId={projectId}
      initialConversationId={c ?? null}
      canCommand={user.permissions.includes("command.create")}
    />
  );
}
