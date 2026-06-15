import { redirect } from "next/navigation";
import { getCurrentUser, toCurrentUser } from "../lib/session";
import Shell from "../ui/shell";

export const dynamic = "force-dynamic";

// 控制台外壳布局：未登录统一跳登录页；登录后侧边栏/topbar 由 Shell 承载，各菜单页作为 children。
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  return <Shell currentUser={toCurrentUser(user)}>{children}</Shell>;
}
