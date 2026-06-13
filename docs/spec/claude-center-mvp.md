# ClaudeCenter MVP 方案

## 目标

ClaudeCenter 是一个 AI 编码协作中央控制台，由一个 Next.js Web Console 和多个 Electron Desktop Worker 组成。所有节点只通过同一个 PostgreSQL 实例协同，第一版目标是做到：

- Web Console 可管理项目、发布任务、查看任务/Worker 全局状态。
- Worker 可注册心跳、按本机关联项目领取任务、调用本地 Git / Claude Code / GitHub CLI 执行编码流程并回写 PR 结果。
- Web Console 可向指定在线 Worker 下发定向指令，绕过任务队列执行并反馈。
- 数据库 schema 覆盖任务完整生命周期、错误记录、结果承载和事件追踪。

## 架构

```
Next.js Console  <---- PostgreSQL ---->  Electron Worker A
       |                                   Electron Worker B
       |                                   Electron Worker N
   API + UI
```

PostgreSQL 是唯一协调中心。Console 和 Worker 都使用 `packages/db` 中的共享查询函数访问数据库。

## 核心表

- `projects`：云端项目定义，保存项目名、Git 仓库地址、默认分支。
- `workers`：桌面端实例，保存机器名、心跳、状态、能力和元数据。
- `worker_project_links`：Worker 到项目的一对多本地关联，保存本地路径和是否启用。
- `tasks`：任务队列，包含项目、分支、描述、目标文件、状态、错误、结果、PR URL。
- `task_events`：任务状态变更和执行日志摘要。
- `direct_commands`：定向指令队列，只由指定 Worker 领取。

任务状态使用以下生命周期：

- `pending`：Web 端入队，尚未领取。
- `claimed`：Worker 原子领取成功，尚未开始执行。
- `running`：Worker 正在执行 Git / Claude Code / PR 流程。
- `waiting`：Claude 需用户确认，挂起等待回复（见 `task-comment-confirm.md`），收到回复后回到 `running`。
- `success`：PR 模式下 PR 已创建待合并，或任务无改动直接完成。
- `merged`：PR 已合并并完成本地清理，或直推模式已落地到基准分支（见 `task-cleanup-merge.md`）。
- `failed`：任务失败，`error_message` 与 `result` 记录原因。
- `cancelled`：预留给人工取消。

任务投递模式 `delivery_mode`：`pr`（默认，开 PR 等合并后清理）/ `direct`（直接 commit+push 到基准分支）。

定向指令状态与任务保持一致（不含 `merged`），但只面向单个 Worker。

## Worker 执行路径

1. 启动后读取本地配置或环境变量，注册/刷新 `workers`。
2. 根据 `CLAUDE_CENTER_PROJECTS` 中的项目名或仓库地址匹配 `projects`，写入 `worker_project_links`。
3. 定时心跳，默认 15 秒。
4. 每轮 tick 依次：领取定向指令 → 续接收到回复的 `waiting` 任务 → 领取本机项目子集中的 `pending` 任务 →
   （都没有时）轮转检查一个已建 PR 的 `success` 任务是否已合并并清理。
5. 任务执行：
   - `git fetch origin`、`checkout` + `pull --ff-only` 基准分支
   - `pr` 模式从 `base_branch` 切出 `work_branch`；`direct` 模式直接在基准分支上工作
   - 调用 `claude -p <prompt>`；若配置了 `CLAUDE_CENTER_CLAUDE_PRE_COMMAND`，则在同一 PowerShell 会话内先执行该前置命令（代理 / VPN 设置等）再调用 `claude`，prompt 经环境变量传入以避免转义问题
   - 若产生改动：`pr` 模式提交、推送 `work_branch` 并 `gh pr create`，回写 `success` + `pr_url`；
     `direct` 模式提交并 `push` 回基准分支，回写 `merged`
   - 无改动回写 `success`；异常回写 `failed`
6. 完成后清理（仅 `pr` 模式）：`gh pr view` 检测到 PR 已合并后，把本地仓库切回基准分支并 `pull`、
   删除本地与远端 `work_branch`，回写终态 `merged`。

环境变量加载：`db:migrate`、Console 脚本和 Worker 启动时会向上查找并加载仓库根 `.env`，且不覆盖 shell 中已存在的变量（shell 优先，`.env` 补齐）。前置命令只包裹 `claude`；`git` / `gh` 如需代理，在 Worker 进程环境里设置 `HTTP_PROXY` / `HTTPS_PROXY` 即可被透传。

## 本版边界

- 不引入消息队列、Redis、WebSocket；Console 通过短轮询获得准实时状态。
- 不把真实 `DATABASE_URL` 写入仓库，只提供 `.env.example`。
- Worker 明确依赖本机已安装 `git`、`claude`、`gh`，缺失时任务失败并记录错误。
- 认证与权限不是本版目标；后续可在 Next.js API 层补充登录和项目权限。

## 验证

- `npm install`
- `npm run typecheck`
- `npm run db:migrate`
- `npm run dev:console`
- Worker 本地配置好 `DATABASE_URL`、`CLAUDE_CENTER_PROJECTS` 后运行 `npm run dev:worker`
