import type { Role } from "./types.js";

// 能力（permission）枚举。读取无独立能力：凡登录用户即可读（按项目范围过滤）。
export type Permission =
  | "task.comment" // 在任务「对话」里回复 Worker 提问
  | "task.create" // 创建 / 发布任务
  | "command.create" // 向 Worker 下发定向指挥（shell / claude_prompt）
  | "project.create" // 新建代码项目
  | "user.manage"; // 用户 / 角色 / 项目分配管理

// 四个固定角色的权限矩阵（写死，不做可配置）。admin 拥有全部能力，且不受项目范围约束。
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  viewer: [],
  commenter: ["task.comment"],
  publisher: ["task.comment", "task.create"],
  admin: ["task.comment", "task.create", "command.create", "project.create", "user.manage"]
};

export const ROLE_LABELS: Record<Role, string> = {
  admin: "管理员",
  publisher: "发布执行",
  commenter: "任务对话",
  viewer: "只读"
};

export const ROLES: Role[] = ["admin", "publisher", "commenter", "viewer"];

export function permissionsForRole(role: Role): Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return permissionsForRole(role).includes(permission);
}
