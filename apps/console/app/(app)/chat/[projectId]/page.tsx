import { redirect } from "next/navigation";
import { getCurrentUser } from "../../../lib/session";
import ChatProjectClient from "./chat-client";

export const dynamic = "force-dynamic";

// 项目对话工作台：左侧该项目的会话列表（Claude 网页版风格，仅标题 + 三点菜单）、右侧消息线。
export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  const { projectId } = await params;
  return <ChatProjectClient projectId={projectId} canCommand={user.permissions.includes("command.create")} />;
}
