# 用户 / 角色 / 权限 / 登录鉴权 / 项目隔离

## 目标

给 Console 加上一套登录鉴权 + 基于角色的访问控制（RBAC）+ 项目级数据隔离：

1. **登录鉴权**：访问 Console 必须先登录；未登录跳 `/login`，所有 `/api/*`（除登录本身）未登录返回 401。
2. **用户管理**：管理员可创建 / 编辑 / 停用 / 删除用户，分配角色，分配可访问项目，重置密码。
3. **四个固定角色**（写死权限矩阵，不做可配置）：
   - `viewer` 只读 —— 仅查看（受项目范围约束），无任何写操作。
   - `commenter` 任务对话 —— 在 viewer 基础上可在任务「对话」里回复 Worker 提问。
   - `publisher` 发布执行 —— 在 commenter 基础上可创建 / 发布任务。
   - `admin` 管理员 —— 全部权限：定向指挥、建项目、用户管理；且看全部项目（不受项目范围约束）。
4. **项目级隔离**：非 admin 用户只能看到 / 操作分配给自己的项目及其任务；admin 看全部。

## 边界与不做的事

- **Worker 不受影响**：`apps/worker` 直接连 Postgres（`@claude-center/db`），不经 Console API，是机器侧 actor。RBAC 纯粹是 Console（Web UI + API）的事。Worker 的认领 / 心跳 / 续接逻辑完全不动。
- **不做可配置权限矩阵**：四角色能力写死在 `packages/db/src/rbac.ts`，不建 permissions / role_permissions 表（用户需求即四个固定角色，避免过度设计）。
- **定向指挥仅 admin**：向 Worker 下发 shell / claude_prompt 风险高，只给 admin。
- **不引第三方鉴权 / 加密库**：密码散列与会话 token 全用已启用的 pgcrypto（`crypt()` + `gen_salt('bf')` + `gen_random_bytes()`），零新依赖。

## 权限矩阵（`packages/db/src/rbac.ts`，写死）

| 能力 \ 角色            | viewer | commenter | publisher | admin |
| --------------------- | :----: | :-------: | :-------: | :---: |
| 读取（范围内项目/任务）  |   ✓    |     ✓     |     ✓     |   ✓   |
| `task.comment` 回复对话 |        |     ✓     |     ✓     |   ✓   |
| `task.create` 建/发布任务|        |           |     ✓     |   ✓   |
| `command.create` 定向指挥|       |           |           |   ✓   |
| `project.create` 建项目 |        |           |           |   ✓   |
| `user.manage` 用户管理  |        |           |           |   ✓   |
| 项目范围               | 受限   |   受限    |   受限    | 全部  |

读取无独立 permission，凡登录用户即可读（按项目范围过滤）。

## 数据库（migration `006_auth_rbac.sql`）

```sql
CREATE TABLE users (
  id uuid PK default gen_random_uuid(),
  username text UNIQUE NOT NULL,
  password_hash text NOT NULL,            -- pgcrypto crypt(pwd, gen_salt('bf'))
  role text NOT NULL CHECK (role IN ('admin','publisher','commenter','viewer')),
  display_name text NOT NULL DEFAULT '',
  disabled boolean NOT NULL DEFAULT false,
  last_login_at timestamptz,
  created_at / updated_at timestamptz
);

CREATE TABLE user_project_links (
  user_id uuid REFERENCES users ON DELETE CASCADE,
  project_id uuid REFERENCES projects ON DELETE CASCADE,
  created_at timestamptz,
  PRIMARY KEY (user_id, project_id)
);

CREATE TABLE sessions (
  token text PK DEFAULT encode(gen_random_bytes(32),'hex'),
  user_id uuid REFERENCES users ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz NOT NULL          -- now() + 7 天
);
```

**引导管理员**（migration 末尾 `ON CONFLICT DO NOTHING`）：
`admin` / 密码 `admin123` / role=admin。首次登录后请在「用户权限」里重置密码。

## 鉴权机制

- 登录 `POST /api/auth/login {username,password}`：`verifyUserCredentials` 用 `crypt(input, password_hash)=password_hash` 校验 → 建 session → 把 token 写进 httpOnly cookie `cc_session`（sameSite lax，path=/，7 天）。停用账号返回 403。
- 登出 `POST /api/auth/logout`：删 session 行 + 清 cookie。
- 会话校验 `getCurrentUser()`（`apps/console/app/lib/session.ts`）：读 cookie → `getSessionUser`（join users，校验 expires_at 且账号未停用）→ 返回 `User + permissions[]`。每次请求实时查库，所以改角色 / 改项目 / 停用立即生效，无需重新登录。
- 路由门禁 `requireUser()` / `requirePermission(perm)`：返回 `AuthUser | NextResponse`，路由首行 `const gate = await requirePermission(...); if (gate instanceof NextResponse) return gate;`。

## API 改动（每条 route 加门禁）

| Route | 门禁 |
| --- | --- |
| `GET /api/overview` | requireUser；projects/tasks 按用户项目范围过滤；commands 仅 admin 返回 |
| `POST /api/projects` | `project.create` |
| `POST /api/tasks` | `task.create` + 目标项目在范围内 |
| `PATCH /api/tasks/[id]`（发布）| `task.create` + 任务项目在范围内 |
| `GET /api/tasks/[id]/comments` | requireUser + 任务项目在范围内 |
| `POST /api/tasks/[id]/comments` | `task.comment` + 任务项目在范围内 |
| `POST /api/direct-commands` | `command.create`（admin） |
| `GET/POST /api/users`、`PATCH/DELETE /api/users/[id]` | `user.manage`（admin） |

**防自锁**：不能删除 / 停用自己的账号；不能删除或降级「最后一个 admin」。

## 前端

- `app/page.tsx` 改服务端组件：`getCurrentUser()`，无 → `redirect('/login')`，有 → `<Dashboard currentUser={dto} />`。
- `app/login/page.tsx`（服务端，已登录则 redirect `/`）+ `login-form.tsx`（client 表单）。
- `dashboard.tsx` 收 `currentUser` prop，按 permissions 显隐：发布任务 / 发布按钮（task.create）、对话回复（task.comment）、定向指挥 + 回执（command.create）、新建项目（project.create）、「用户权限」导航 + UsersView（user.manage）；侧栏底部显示用户名 + 角色 + 登出。
- 新增 `UsersView`（admin）：用户列表 + 新建 + 编辑（角色/项目/停用/重置密码）+ 删除。

## 验证

- `npm run typecheck` / `npm run build` 全绿。
- `npm run db:migrate` 应用 006。
- `verify-console.mjs` 改造：断言未登录 `/api/overview` → 401；admin 登录拿 cookie → `/api/overview` → 200 且返回计数。
- 手验：admin 建各角色用户 + 分配项目；分别登录验证可见项目 / 按钮显隐 / 越权 API 返回 401/403。
</content>
</invoke>
