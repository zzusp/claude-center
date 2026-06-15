import { redirect } from "next/navigation";
import { getCurrentUser } from "../lib/session";
import DashboardClient from "./dashboard-client";

export const dynamic = "force-dynamic";

export default async function Page() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  return <DashboardClient />;
}
