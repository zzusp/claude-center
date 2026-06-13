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

## 任务投递模式与完成后清理

任务有两种投递模式（发布任务时在「投递模式」选择，默认 `pr`）：

- **`pr`（默认）**：Worker 从基准分支切出工作分支执行，完成后 push 工作分支并 `gh pr create`，任务标
  `success`。此后 Worker 的 periodic tick 会**轮转检查该 PR 是否已合并**（`gh pr view --json state`），
  一旦合并就把本地仓库切回基准分支并 `pull` 拉进改动、删除本地与远端工作分支，任务转入终态 `merged`。
- **`direct`（直推）**：Worker 直接在基准分支上执行并把提交 `push` 回基准分支（不开 PR），推送成功即落地，
  任务直接转入 `merged`。适合不需要 PR 评审的小改动。

两种模式下 Claude 若无改动，都直接标 `success`（无 PR、无落地、无需清理）。

任务状态机：`pending → claimed → running →`（`waiting ⇄ running` 可循环）`→ success`（PR 模式中间态）`→ merged`；
直推模式与无改动直接到达 `success`/`merged`，失败到 `failed`。Console 看板用不同徽章区分「已完成（PR 已建待合并）」
与「已合并」。

该能力依赖数据库迁移 `003_task_cleanup.sql`（新增 `tasks.delivery_mode`、`tasks.merge_checked_at` 列、`merged`
状态、清理候选索引）。升级后务必先跑 `npm run db:migrate`。
