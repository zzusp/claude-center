import { redirect } from "next/navigation";
import { getCurrentUser } from "../../lib/session";
import ProjectsClient from "./projects-client";

export const dynamic = "force-dynamic";

export default async function Page() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  return <ProjectsClient canManageProjects={user.permissions.includes("project.create")} />;
}
