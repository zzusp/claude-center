import { notFound, redirect } from "next/navigation";
import { getCurrentUser, toCurrentUser } from "../../lib/session";
import UsersClient from "./users-client";

export const dynamic = "force-dynamic";

export default async function Page() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  // 服务端权限门：无 user.manage 直接当作不存在，不暴露用户管理界面。
  if (!user.permissions.includes("user.manage")) {
    notFound();
  }
  return <UsersClient currentUser={toCurrentUser(user)} />;
}
