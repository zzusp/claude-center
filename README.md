# ClaudeCenter

ClaudeCenter 是一个 AI 编码协作中央控制台：一个 Next.js Web Console 加多个 Electron Desktop Worker，所有节点通过同一个 PostgreSQL 数据库协同。

## 组件

- `apps/console`：Web 中控台，负责项目管理、任务发布、Worker/任务监控和定向指令。
- `apps/worker`：桌面端 Worker，负责心跳、项目本地路径关联、任务领取、Claude Code 执行和 GitHub PR 创建。
- `packages/db`：PostgreSQL schema、迁移脚本和共享查询函数。

## 快速开始

1. 安装依赖：

   ```powershell
   npm install
   ```

2. 创建本地环境变量文件：

   ```powershell
   Copy-Item .env.example .env
   ```

   将 `.env` 中的 `DATABASE_URL` 改为实际 PostgreSQL 连接串。不要提交 `.env`。

   `db:migrate`、`dev:console`、`verify:console` 和 Worker 都会自动加载仓库根目录的 `.env`。已经在 shell 里设置的变量（如 `$env:DATABASE_URL`）优先级更高，`.env` 只补齐缺失项，因此两种方式可混用。

3. 初始化数据库：

   ```powershell
   npm run db:migrate
   ```

4. 启动 Web Console：

   ```powershell
   npm run dev:console
   ```

   默认监听 `http://127.0.0.1:3000`。需要调整时设置 `CONSOLE_HOST` 或 `CONSOLE_PORT`。

5. 启动 Worker：

   ```powershell
   npm run dev:worker
   ```

## 本地验证

```powershell
npm run typecheck
npm run build
npm run verify:console
```

`verify:console` 会临时启动 Console，检查首页和 `/api/overview`，然后自动关闭服务。

## Worker 前置依赖

Worker 机器需要能在命令行访问：

- `git`
- `claude`，可用 `CLAUDE_CODE_COMMAND` 覆盖
- `gh`，可用 `GH_COMMAND` 覆盖

`CLAUDE_CENTER_PROJECTS` 是 Worker 负责的本地项目子集，格式如下：

```json
[
  {
    "projectName": "Example",
    "repoUrl": "https://github.com/acme/example.git",
    "localPath": "D:\\src\\example"
  }
]
```

Worker 启动后会用 `projectName` 或 `repoUrl` 匹配 Console 中已创建的项目，并只领取这些项目的任务。

## 执行 Claude Code 前的前置命令（代理 / VPN）

Worker 调用 `claude` 前可以先跑一段前置命令，常用于设置代理或拉起 VPN。通过 `CLAUDE_CENTER_CLAUDE_PRE_COMMAND` 配置一段 PowerShell 脚本：

```powershell
CLAUDE_CENTER_CLAUDE_PRE_COMMAND='$env:HTTP_PROXY = "http://127.0.0.1:10808"; $env:HTTPS_PROXY = "http://127.0.0.1:10808"'
```

前置命令与 `claude` 在**同一个 PowerShell 会话**里执行，所以它设置的环境变量（如代理）会被 `claude` 进程继承；prompt 通过环境变量传递、不进命令行，含空格 / 引号 / 换行也不会被破坏。该前置命令同样作用于「定向指挥」里的 `claude_prompt` 指令。未设置时 `claude` 直接调用，行为不变。

前置命令只包裹 `claude`，不影响 `git` / `gh`。如果这些命令也要走代理，直接在启动 Worker 的环境里设置 `HTTP_PROXY` / `HTTPS_PROXY`——Worker 会把自身环境透传给所有子进程。

## 任务执行中途确认（评论 ↔ 回复 ↔ 续接）

Worker 执行任务时，若 Claude 需要先与用户确认才能安全推进，会在任务下方留一条提问评论并把任务置为「等待回复」；用户在 Web Console 任务详情的「对话」tab 看到提问并回复后，Worker 下一轮 tick 会**续接同一个 Claude 会话**继续执行，直到完成或再次提问。详见 `docs/spec/task-comment-confirm.md`。

实现要点：

- Worker 用 `claude -p <prompt> --output-format json` 调用，记录返回的 `session_id`；续接时用 `claude -p <回复> --resume <session_id> --output-format json`，且始终在该任务绑定的同一 `localPath` 下执行（Claude 会话按工作目录持久化在 `~/.claude/projects/`）。
- 约定哨兵串 `<<CLAUDE_CENTER_NEEDS_INPUT>>`：Claude 需要确认时在回复末尾输出该串 + 问题后停止，Worker 解析后落为评论并转入等待。
- 续接路径不重建分支，保留上一轮工作树改动；同一 Worker 同一项目在有等待中任务时不再领取该项目的新任务，避免 `git checkout` 清掉未提交改动。
- 该能力依赖数据库迁移 `002_task_comments.sql`（新增 `task_comments` 表、`tasks.claude_session_id` 列、`waiting` 状态）。升级后务必先跑 `npm run db:migrate`。

## 人工验收 + 任务前置依赖

任务执行完成（`success`）后不再是终态，而是「待验收」：用户在 Web Console 任务详情对其**人工验收**——

- **验收通过** → 终态 `accepted`。
- **打回**（需填打回意见）→ `rejected`，Worker 下一轮 tick 会 `checkout` 回该任务分支、带着打回意见**续接同一 Claude 会话重跑**，修订后更新原 PR、再次进入「待验收」，形成「执行 → 验收 → 打回 → 重跑」闭环。

任务之间可声明**前置依赖**（仅限同项目，建任务时多选）：某任务任一前置未达 `accepted` 时，Worker **不会领取**该任务（保持 `pending`，详情页标「阻塞中」）。前置全部验收通过后自动解除。

实现要点：

- 数据库迁移 `004_task_acceptance_dependencies.sql`：`tasks.status` 增加 `accepted` / `rejected`；新增 `task_dependencies` 多对多表。升级后先跑 `npm run db:migrate`。
- 领取门控在 `claimNextTask`：候选须不存在「状态非 `accepted` 的前置」。
- 验收入口 `POST /api/tasks/[id]/review`（`accept` / `reject`，各在事务内完成）；打回意见落为 user 评论供 Worker 续接读取。
- 打回重跑（`rerunRejectedTask`）先 `checkout work_branch` 再续接（不同于等待续接的不重建分支），`finalizeTask` 在 PR 已存在时跳过 `gh pr create`、复用原 PR。
