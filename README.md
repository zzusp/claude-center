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
- 续接路径不重建分支，保留上一轮工作树改动；同一 Worker 同一项目在有等待中**工作类**任务时不再领取该项目的新任务，避免 `git checkout` 清掉未提交改动。
- 该能力依赖数据库迁移 `002_task_comments.sql`（新增 `task_comments` 表、`tasks.claude_session_id` 列、`waiting` 状态）。升级后务必先跑 `npm run db:migrate`。

## 任务发布门禁（草稿 → 待处理）

新建任务的初始状态是 `draft`（草稿），**Worker 不会认领草稿任务**。需要在 Web Console 任务详情点「发布」把任务切到 `pending`，它才进入可认领队列。这给了发布前复核标题、目标、分支的机会。

此外，Worker 只能认领**本机已关联项目**（`worker_project_links`，来自 `CLAUDE_CENTER_PROJECTS`）下的任务；项目没有任何 Worker 关联时，任务会一直停在 `pending` 队列无人领取。

实现要点：

- 状态生命周期：`draft → pending → claimed → running →（waiting）→ success/failed/cancelled`。
- 发布走 `PATCH /api/tasks/:id { action: "publish" }`，DB 侧 `UPDATE ... SET status='pending' WHERE id=$1 AND status='draft'`——只有草稿可发布，对已认领/运行中/完成的任务幂等无副作用。
- 认领约束未变：`claimNextTask` 仍只捞 `pending`，并 `JOIN worker_project_links` 过滤本机关联项目。
- 该能力依赖数据库迁移 `003_task_draft_status.sql`（放开 `status` CHECK 增加 `draft`、列默认值改为 `draft`）。升级后务必先跑 `npm run db:migrate`。详见 `docs/spec/task-draft-gating.md`。

## 任务分支与提交模式

发布任务时可以分别设置三个分支与提交方式，详见 `docs/spec/task-branch-submit-mode.md`：

- **签出分支**（`base_branch`）：Worker 从这个分支拉取并切出工作分支作为工作起点。
- **PR 目标分支**（`target_branch`）：PR 模式下是 PR 的合并目标；留空时默认与签出分支相同。
- **工作分支**（`work_branch`）：Worker 实际提交改动的分支，留空自动生成 `cc/...`。
- **提交模式**（`submit_mode`）：
  - `pr`（默认）：推送工作分支并用 `gh` 创建 PR，目标为「PR 目标分支」。
  - `push`：在工作分支完成改动后，直接 `git push origin <work_branch>:<target_branch>` 推送到目标分支，不创建 PR。

发布表单里「签出分支 / PR 目标分支」是带远程分支候选的可搜索输入框：选定项目后，Console 后端用 `git ls-remote --heads <repo_url>` 拉取该仓库的远程分支供选择（默认分支置顶），拉取失败时仍可手动输入。private 仓库需要运行 Console 的机器具备 git 访问凭据。

该能力依赖数据库迁移 `004_task_target_branch.sql`（新增 `tasks.target_branch`、`tasks.submit_mode` 列）。升级后务必先跑 `npm run db:migrate`。

## 任务分类（工作类 vs 问答类）

发布任务时可选两种类型，按是否产出代码改动区分流程：

- **工作类（work，默认）**：需要开发、改文件，最终 commit / push / 开 PR（或按提交模式直推）。即上文的建分支 → Claude → 收尾全流程，行为不变。
- **问答类（qa）**：纯对话问答，**不碰 git**（不建分支 / 不 commit / 不开 PR）。Worker 在项目本地目录里只读地跑 Claude 回答，答案落成任务评论；用户在「对话」tab 继续追问、Claude 续接同一会话回答，满意后点「结束对话」把任务标记完成。详见 `docs/spec/task-types.md`。

实现要点：

- Console 发布表单选「问答类」时隐藏 分支 / 提交模式 / 目标文件 字段；问答类任务的 `base_branch` / `work_branch` / `target_branch` 存空、`target_files` 为空、`submit_mode` 取默认。
- Worker `executeTask` / `resumeTask` 按 `task_type` 分叉：问答类跳过所有 git 分支操作，`runClaudeJson(qaPrompt)` → 回答落评论 + 转「等待回复」，恒定多轮（不用哨兵、不收尾 git）。续接走同一 `--resume <session_id>` 机制。
- 工作树互斥只对「等待中的工作类任务」生效（它持有未提交改动）；问答类是只读对话、不锁工作树，不会冻结项目的任务流转。
- 用户「结束对话」经 `PATCH /api/tasks/:id { action: "complete" }` 把问答类任务置为 `success`（与「发布」共用同一状态切换端点）。
- 该能力依赖数据库迁移 `005_task_types.sql`（新增 `tasks.task_type` 列，默认 `work`）。升级后务必先跑 `npm run db:migrate`。

## 任务完成后清理（merged 终态）

工作类任务收尾后，Worker 的 periodic tick 还会把任务推进到终态 `merged`：

- **`submit_mode='pr'`**：完成后建 PR、标 `success`。此后每轮 tick 会**轮转检查该 PR 是否已合并**（`gh pr view --json state`，每 tick 至多查一个、按 `merge_checked_at` 轮转节流）。一旦合并：把本地仓库切回签出分支并 `pull` 拉进改动、删除本地与远端工作分支，任务转入 `merged`。
- **`submit_mode='push'`**：直推目标分支即落地，收尾时直接标 `merged`（无 PR、无需轮询）。

Console 看板用不同徽章区分「已完成（PR 已建待合并）」`success` 与「已合并」`merged`；状态筛选、状态分布环图、详情时间线均已覆盖 `merged`。无改动的任务仍标 `success`（无 PR、无落地、无需清理）。

该能力依赖数据库迁移 `006_task_cleanup.sql`（新增 `tasks.merge_checked_at` 列、`merged` 状态、清理候选索引）。升级后务必先跑 `npm run db:migrate`。详见 `docs/spec/task-cleanup-merge.md`。

## 人工验收 + 任务前置依赖

工作类任务执行完成（`success`，PR 已建待验收）后不再是终态，用户可在 Web Console 任务详情对其**人工验收**——

- **验收通过** → 终态 `accepted`。
- **打回**（需填打回意见）→ `rejected`，Worker 下一轮 tick 会 `checkout` 回该任务分支、带着打回意见**续接同一 Claude 会话重跑**，修订后更新原 PR、再次进入「待验收」，形成「执行 → 验收 → 打回 → 重跑」闭环。

任务之间可声明**前置依赖**（仅限同项目，建任务时多选）：某任务任一前置未到达「已完成」终态（`accepted` 人工验收通过，或 `merged` PR 已合并 / 直推已落地）时，Worker **不会领取**该任务（保持 `pending`，详情页标「阻塞中」）。前置全部完成后自动解除。

实现要点：

- 数据库迁移 `007_task_acceptance_dependencies.sql`：`tasks.status` 增加 `accepted` / `rejected`（约束重建时列全集，含并行迁移引入的 `draft` / `merged`）；新增 `task_dependencies` 多对多表。升级后先跑 `npm run db:migrate`。
- 领取门控在 `claimNextTask`：候选须不存在「状态不在 (`accepted`, `merged`) 的前置」。
- 验收入口 `POST /api/tasks/[id]/review`（`accept` / `reject`，各在事务内完成）；打回意见落为 user 评论供 Worker 续接读取。
- 打回重跑（`rerunRejectedTask`）先 `checkout work_branch` 再续接（不同于等待续接的不重建分支），`finalizeTask` 在 PR 已存在时跳过 `gh pr create`、复用原 PR。详见 `docs/spec/task-acceptance-dependencies.md`。
