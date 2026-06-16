// API route handler 公共件:统一的错误 / 校验响应,取代各 handler 里复制粘贴的样板。
import { NextResponse } from "next/server";

// 统一 500:把异常转成 { error } 响应。取代每个 catch 里重复的 `error instanceof Error ? ...` 三元。
// 用法:catch (error) { return errorResponse(error); }
export function errorResponse(error: unknown): NextResponse {
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "Unknown error" },
    { status: 500 }
  );
}

// 统一 400:入参校验失败。
export function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

// 必填非空字符串校验:trim 后非空返回 trim 值,否则返回 null(调用方据此回 badRequest)。
export function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
