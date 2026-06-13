import { deleteSession, getPool } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "../../../lib/session";

export async function POST(request: NextRequest) {
  try {
    const token = request.cookies.get(SESSION_COOKIE)?.value;
    if (token) {
      await deleteSession(getPool(), token);
    }
    const response = NextResponse.json({ ok: true });
    response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
    return response;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
