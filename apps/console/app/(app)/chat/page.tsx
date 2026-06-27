import { redirect } from "next/navigation";
import { getCurrentUser } from "../../lib/session";
import ChatProjectsClient from "./chat-projects-client";

export const dynamic = "force-dynamic";

// 实时对话首页：项目网格。点击项目卡进入 /chat/[projectId] 的会话工作台。
export default async function Page() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  return <ChatProjectsClient canCommand={user.permissions.includes("command.create")} />;
}
