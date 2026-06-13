import { redirect } from "next/navigation";
import { getCurrentUser, toCurrentUser } from "./lib/session";
import Dashboard from "./ui/dashboard";

export const dynamic = "force-dynamic";

export default async function Page() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  return <Dashboard currentUser={toCurrentUser(user)} />;
}
