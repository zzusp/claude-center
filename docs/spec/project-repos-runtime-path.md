# 子仓 `relative_path` 改 worker 运行时派生

> 2026-06-16。本 spec 是 `docs/spec/task-multi-repo.md` 的增量补丁，针对「同一份 `project_repos` 配置要在多个 worker 上落地，但本机文件夹名可能不一致」的痛点改造数据模型与 worker 派生流程。读 task-multi-repo.md 时遇到 `project_repos.relative_path` / `display_name` 字段，以本 spec 为准。

## 背景与动机

迁移 023 设计时把 `project_repos.relative_path`（子仓相对主仓的 POSIX 路径）与 `display_name`（UI 展示名）放在 console 端中心化维护，假设所有 worker 把同一子仓 clone 到主仓内同名子目录下（如 `packages/widgets-lib`）。

实际部署遇到的事实：

- worker A 上 clone 落在 `packages/widgets-lib`；worker B 历史上 clone 时手动改名成 `vendor/widgets`；worker C 用默认 `widgets-lib`
- 中心化的 `relative_path` 只能贴近某一个 worker 的本机布局，其他 worker 上对不齐 → 子仓 worktree 嫁接、`.gitignore` 校验、commit/PR 标签都崩

设计修正：**Console 端只维护项目名 / Git 仓库地址 / 默认分支 / 描述四项；子仓在 worker 上的本机相对路径 / 目录名由 worker 运行时派生。**

## 数据模型变更（迁移 `027_project_repos_runtime_path.sql`）

`project_repos` 表：

| 列 | 023 中 | 027 后 |
|---|---|---|
| `relative_path text NOT NULL` | 子仓 POSIX 路径，UNIQUE(project_id, relative_path) | 删 |
| `display_name text NOT NULL` | UI 展示名 | 删 |
| `name text NOT NULL DEFAULT ''` | — | 新增；主仓行镜像 projects.name，子仓行用户填，UI 展示用 |
| `description text NOT NULL DEFAULT ''` | — | 新增；可选描述 |
| `UNIQUE(project_id, relative_path)` | 有 | 删 |
| `UNIQUE(project_id, repo_url)` | — | 新增；同项目不能挂同一仓两次 |
| 旧两条匿名 CHECK（路径 POSIX + role/path 一致） | 有 | 删 |
| `CHECK (role IN ('main','sub'))` 命名约束 | 由匿名 CHECK 提供 | 命名重建 |
| `project_repos_main_uniq` partial unique index | 有 | 保留（不依赖被删列） |

迁移时 name 回填：`UPDATE ... SET name = COALESCE(NULLIF(display_name, ''), relative_path)`。

`task_repos.relative_path` **列保留**，语义变化：

- 不再来自 `project_repos.relative_path`（已删）
- 主仓行恒 `'.'`
- 子仓行在 task 创建时由 console 写占位 **`*-<projectRepoId>`** —— 形式带 projectRepoId 后缀，保证 `UNIQUE(task_id, relative_path)` 在创建期不撞
- worker prepare 阶段检测到占位 → 调用 `resolveSubRepoRelativePath` 派生本机路径 → `UPDATE task_repos SET relative_path = $1`
- 派生后若两个子仓 resolve 到同名目录，`UNIQUE(task_id, relative_path)` 会拒绝——这是真实冲突应该报错

## Worker 运行时派生流程

新增 `apps/worker/src/worktree.ts::resolveSubRepoRelativePath(mainLocal, repoUrl)`：

1. **扫主仓本地下子目录**（深度 ≤ 3 层，跳过 `node_modules` / `.git` / `.next` / `.claude` 等噪声）：对每个有 `.git` 的目录跑 `git -C <dir> config --get remote.origin.url`，与 `repoUrl` 做归一化比较（忽略尾 `.git`、协议差异 https/git/ssh、user@host、端口）；命中即返回该目录相对 `mainLocal` 的 POSIX 路径
2. **未命中** → 用 `basename(repoUrl)`（去尾 `.git`）作目录名；若该路径已存在但 `.git` 不存在或 remote 不匹配 → 抛错（让任务 failed），不自动改名
3. **进程级缓存**：`Map<key, Promise<string>>`，key = `${mainLocal}::${normalizedRepoUrl}`，同 worker 多任务复用；失败不缓存允许重试

调用点在 `apps/worker/src/executor.ts::prepareRepoWorktree`：占位检测 → resolve → `updateTaskRepoRelativePath` → 回写 `ctx.relative_path`。后续 `ensureSubRepoCloned`、`assertSubRepoPathIgnoredInMain`、worktree 嫁接、commit message、事件日志逻辑零改动。

## Console 端变化

- **`apps/console/app/api/projects/[id]/repos/route.ts` PUT**：入参 `subs[i]` 字段 `relativePath` / `displayName` → `name` / `description`；校验改为 `repoUrl` 去重 + 非空
- **`apps/console/app/lib/task-repos-input.ts`**：
  - `buildTaskRepoInputs` 子仓行 `relativePath: \`*-\${repo.id}\`` 作占位
  - `subWorkBranchFor` 改吃 `ProjectRepo` 对象，按 `slugify(repo.name) || repo.id.slice(0,8)` 派生分支名后缀；**旧任务 `task_repos.work_branch` 已固化入库不重算**，规则变化仅作用于新任务
- **`apps/console/app/ui/projects.tsx`**：`ProjectSubReposEditor` 表单只露 4 个字段（项目名 / Git 仓库地址 / 默认分支 / 描述）；`SubReposInlineList` 列表列同步
- **`apps/console/app/ui/tasks-compose.tsx`** / **`task-detail-overview.tsx`**：子仓标签源 `display_name`/`relative_path` → `repo.name`（兜底 `basenameFromRepoUrl(repo.repo_url)`）；task-detail 表里子仓占位（`*-*`）时显示「子仓（待 worker 派生路径）」
- **shared 工具**：`shared.tsx::basenameFromRepoUrl` / `isPendingSubRepoPath` 统一放共享层

## 风险 / 边界

- **basename 冲突**：worker 端 basename 路径被无关内容占用 → 抛错让任务 failed，用户在 worker 本机手动处理。不自动改名避免误伤
- **`subWorkBranchFor` 派生规则变化**：旧任务保持旧分支名运行（写库的字段不重算）；新任务用 `slugify(repo.name)`。可接受
- **远程共享 dev 库**：禁止在共享 dev 库上验证迁移 027（`schema_migrations` 错位）；用 `npm run db:ephemeral`（CLAUDE.md 已有规范）
- **本期不入库 worker 本机映射表**：自动扫描 + basename 兜底已能应对绝大多数场景；如后续需要「worker UI 手动校准 relative_path」，再加 `worker_repos` 表 + 接口（Phase 2）

## 验证

- 五包 typecheck / build 绿
- `npm run db:ephemeral` 跑 023 → 027 ok；`project_repos` 列符合预期；现有 `display_name` 数据被 COALESCE 到 `name`
- Console UI 手测：新建项目 + 加 2 个子仓（4 字段表单）→ DB 看 project_repos；建多仓任务 → DB 看 `task_repos.relative_path = '*-<projectRepoId>'`
- Worker 集成（headless）：
  - prepare 后查 `task_repos.relative_path` 被改写为派生值
  - 故意改本机子仓目录名 → 重起任务，断言 worker 复用而非重新 clone
  - 故意把 basename 路径占成不相干仓 → 任务 failed + event 有错
- 回归：单仓项目跑全流程，main 行 `relative_path` 恒 `'.'`、无副作用
