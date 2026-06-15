import { redirect } from "next/navigation";
import { getCurrentUser, toCurrentUser } from "../../lib/session";
import WorkersClient from "./workers-client";

export const dynamic = "force-dynamic";

export default async function Page() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  const current = toCurrentUser(user);
  return <WorkersClient canCommand={current.permissions.includes("command.create")} />;
}
