import { getPool, getWorker } from "@claude-center/db";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser, toCurrentUser } from "../../../lib/session";
import WorkerDetailPage from "../../../ui/worker-detail";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  const { id } = await params;

  const worker = await getWorker(getPool(), id);
  if (!worker) {
    notFound();
  }

  const current = toCurrentUser(user);
  return (
    <WorkerDetailPage
      initialWorker={worker}
      canCommand={current.permissions.includes("command.create")}
    />
  );
}
