import { createSession, getPool, touchUserLogin, verifyUserCredentials } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, SESSION_TTL_DAYS } from "../../../lib/session";
import { errorResponse, badRequest } from "../../../lib/api";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { username?: string; password?: string };
    if (!body.username?.trim() || !body.password) {
      return badRequest("用户名和密码必填");
    }

    const pool = getPool();
    const user = await verifyUserCredentials(pool, body.username.trim(), body.password);
    if (!user) {
      return NextResponse.json({ error: "用户名或密码错误" }, { status: 401 });
    }
    if (user.disabled) {
      return NextResponse.json({ error: "账号已停用" }, { status: 403 });
    }

    const token = await createSession(pool, user.id, SESSION_TTL_DAYS);
    await touchUserLogin(pool, user.id);

    const response = NextResponse.json({
      user: { id: user.id, username: user.username, displayName: user.display_name, role: user.role }
    });
    // Secure cookie 在 HTTP 下会被浏览器丢弃 → 登录后 cookie 不落地、回不到中控台。
    // 跟随请求实际协议：HTTPS（含反代时的 x-forwarded-proto）开 Secure，HTTP 直接暴露时放宽。
    const xfProto = request.headers.get("x-forwarded-proto");
    const isHttps = xfProto ? xfProto.split(",")[0]?.trim() === "https" : new URL(request.url).protocol === "https:";
    response.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: isHttps,
      path: "/",
      maxAge: SESSION_TTL_DAYS * 24 * 60 * 60
    });
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
