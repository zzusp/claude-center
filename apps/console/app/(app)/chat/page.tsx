import { redirect } from "next/navigation";
import { getCurrentUser } from "../../lib/session";
import ChatClient from "./chat-client";

export const dynamic = "force-dynamic";

export default async function Page() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  return <ChatClient canCommand={user.permissions.includes("command.create")} />;
}
