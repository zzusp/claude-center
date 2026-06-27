import { redirect } from "next/navigation";
import { getCurrentUser } from "../../lib/session";
import ChatShellClient from "./chat-shell-client";

export const dynamic = "force-dynamic";

// 实时对话首页：项目树侧栏（无项目展开）+ 右侧空态。
export default async function Page() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  return (
    <ChatShellClient
      initialProjectId={null}
      initialConversationId={null}
      canCommand={user.permissions.includes("command.create")}
    />
  );
}
