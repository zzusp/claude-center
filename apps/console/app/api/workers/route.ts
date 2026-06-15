import { getPool, listWorkers } from "@claude-center/db";
import { NextResponse } from "next/server";
import { requireUser } from "../../lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireUser();
  if (gate instanceof NextResponse) {
    return gate;
  }
  try {
    const workers = await listWorkers(getPool());
    return NextResponse.json({ workers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
