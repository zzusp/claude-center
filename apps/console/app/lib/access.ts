// 资源级项目隔离门禁:非 admin 用户只能访问分配给自己项目下的资源。
// 与 session.ts 的登录 / 权限门禁(requireUser / requirePermission)互补——
// 那边管「你登录了吗 / 有这个操作权吗」,这边管「这条资源所属的项目在你范围内吗」。
// 取代各 route handler 里重复 12+ 次的 `getTaskProjectId + userHasProject` 两步检查。
import { getPool, getTaskProjectId, userHasProject } from "@claude-center/db";
import { NextResponse } from "next/server";
import type { AuthUser } from "./session";

// 校验用户对某项目的访问范围。返回 null=放行,否则返回 403。admin 全通。
// 适用于已持有 project_id 的场景(如对话路由先取 conversation 再校验)。
export async function requireProjectScope(
  user: AuthUser,
  projectId: string,
  deniedMessage = "无权访问"
): Promise<NextResponse | null> {
  if (user.role === "admin") {
    return null;
  }
  if (!(await userHasProject(getPool(), user.id, projectId))) {
    return NextResponse.json({ error: deniedMessage }, { status: 403 });
  }
  return null;
}

// 校验用户对某任务所属项目的访问范围(内部先查任务的 project_id)。返回 null=放行,否则 403。
// 任务不存在时对非 admin 也返回 403(与原各 handler 行为一致:不泄露任务是否存在)。
export async function requireTaskAccess(
  user: AuthUser,
  taskId: string,
  deniedMessage = "无权访问该任务"
): Promise<NextResponse | null> {
  if (user.role === "admin") {
    return null;
  }
  const projectId = await getTaskProjectId(getPool(), taskId);
  if (!projectId || !(await userHasProject(getPool(), user.id, projectId))) {
    return NextResponse.json({ error: deniedMessage }, { status: 403 });
  }
  return null;
}
