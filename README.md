# ClaudeCenter

ClaudeCenter 是一个 AI 编码协作中央控制台：一个 Next.js Web Console 加多个 Electron Desktop Worker，所有节点通过同一个 PostgreSQL 数据库协同；可选叠加一个 SSE 中转服务作低延迟实时线。

## 组件

- `apps/console`：Web 中控台，负责项目管理、任务发布、Worker/任务监控和定向指令。
- `apps/worker`：桌面端 Worker，负责心跳、项目本地路径关联、任务领取、Claude Code 执行和 GitHub PR 创建。
- `apps/relay`：可选的 SSE 中转服务，为 Console↔Worker 提供低延迟实时推送（不可用时自动退回数据库轮询）。
- `packages/db`：PostgreSQL schema、迁移脚本和共享查询函数。
- `packages/relay-client`：中转服务的共享客户端（事件契约 + 发布/订阅/票据 helper）。

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

   首次打开会跳转到 `/login`。用引导管理员登录：**用户名 `admin` / 密码 `admin123`**（由 migration `008_auth_rbac.sql` 写入）。**首次登录后请立即在「用户权限」里重置密码。**

5. 启动 Worker：

   ```powershell
   npm run dev:worker
   ```

## SSE 中转服务（实时线，可选）

在「PostgreSQL 唯一权威 + 双向轮询」之上，可选叠加一条独立的 **SSE 中转服务**（`apps/relay`），让 Console 与 Worker 的通信在中转可用时走实时推送（亚秒级），不可用时自动退回数据库轮询（功能不降级）。完整设计见 `docs/spec/sse-relay-service.md`。

- **默认禁用**：`CLAUDE_CENTER_RELAY_URL` 为空时，Console 与 Worker 都不连中转、纯走数据库轮询（与启用前行为完全一致）。
- **启用**：在 `.env` 配齐 `CLAUDE_CENTER_RELAY_*`（基址 + 一组对称密钥/令牌，见 `.env.example`），然后起中转服务：

  ```powershell
  npm run dev:relay                          # 起中转服务（默认 127.0.0.1:8787）
  node apps/relay/dist/main.js --check       # 零副作用自检：只打印脱敏配置，不监听
  npm -w @claude-center/relay run selftest   # 自验证：投递/保活/Last-Event-ID/鉴权/ticket/healthz
  ```

- **承载**：传全量消息负载，但**消息一律先落库再发布**（DB 仍是唯一权威与持久备份）；中转只搬运已落库的事件，丢事件靠订阅端重连后的数据库轮询自愈。
- **可靠性**：保活心跳、断线检测、自动重连（指数退避+抖动）、`Last-Event-ID` 短重放；浏览器用原生 `EventSource` + 短时效票据（按项目 RBAC 限定可订阅频道），Worker 用共享令牌订阅 `worker:<id>` + 本机 `project:<id>` 频道。
- **本期（Phase 1）= SSE 转发 + 消息落库**；DB 轮询「双线择优降级」（中转健康时慢化轮询、断时恢复）列为 Phase 2 TODO——现有轮询天然作隐式兜底。

## 登录鉴权与权限（RBAC）

Console 现在需要登录。鉴权与项目隔离只作用于 Console（Web UI + API），**Worker 直连数据库、不受影响**。方案详见 `docs/spec/auth-rbac.md`。

四个固定角色（权限写死在 `packages/db/src/rbac.ts`）：

| 角色 | 能力 |
| --- | --- |
| 只读 `viewer` | 仅查看分配给自己的项目及其任务 |
| 任务对话 `commenter` | 上 + 在任务「对话」里回复 Worker 提问 |
| 发布执行 `publisher` | 上 + 创建 / 发布任务 |
| 管理员 `admin` | 全部：定向指挥、建项目、用户管理；且看全部项目 |

- **项目隔离**：非 admin 用户只能看到 / 操作管理员分配给自己的项目；admin 看全部。
- **用户管理**：admin 在「用户权限」页创建 / 编辑 / 停用 / 删除用户，分配角色与项目，重置密码。
- 密码散列与会话 token 全部由 PostgreSQL pgcrypto 完成（`crypt` + `gen_salt('bf')` + `gen_random_bytes`），无额外依赖、无需配置密钥。

## 本地验证

```powershell
npm run typecheck
npm run build
npm run db:migrate      # 应用 008，写入引导管理员
npm run verify:console
```

`verify:console` 会临时启动 Console，依次断言：未登录访问 `/api/overview` 返回 401 → 用引导管理员登录拿到会话 cookie → 带 cookie 访问 `/api/overview` 与首页均 200，然后自动关闭服务。运行前需先 `db:migrate`（否则没有 `admin` 账号）。

## Worker 前置依赖

Worker 机器需要能在命令行访问：

- `git`
- `claude`，可用 `CLAUDE_CODE_COMMAND` 覆盖
- `gh`，可用 `GH_COMMAND` 覆盖

Worker **启动时自检**这三个命令（各跑一次 `--version`），把可用性 + 版本写入 `workers.capabilities` 上报给 Console，并在桌面窗口「能力自检」区以红/绿点展示。`claude` 缺失时窗口日志会显著告警，且后续任务会在跑 Claude 前以「claude CLI not found …」清晰失败，而非以晦涩的 spawn 错误跑挂。

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

除环境变量外，也可**在 Worker 桌面窗口的「关联项目」区可视化管理**：从云端项目下拉里选目标、点「选择文件夹」选本地路径、点「添加」即关联（无需手写 JSON）。桌面端添加的关联持久化在 `~/.claude-center/worker.json`（`source=local`，可在窗口里删除），与 `CLAUDE_CENTER_PROJECTS`（`source=env`，只读）合并去重后一并注册到 `worker_project_links`。

## 运行终端 + 执行 Claude Code 前的前置命令（代理 / VPN / 登录）

Worker 调用 `claude` 前可以先在某个终端里跑一段前置命令，常用于设置代理、拉起 VPN 或账号登录。**运行终端**与**前置命令**都可在 Worker 桌面窗口的「运行终端」卡片可视化配置：

- **运行终端**：下拉列出本机检测到的终端（Windows：Windows PowerShell / PowerShell 7 / cmd / Git Bash / WSL；其余平台：bash/zsh/fish/sh），或选「手动输入路径…」填任意终端可执行文件全路径。留空 = 默认（Windows 用 `powershell`；无终端且无前置命令时直接 spawn `claude`，行为与旧版一致）。
- **前置命令**：文本框自填，按**所选终端的语法**书写。例如 PowerShell：`$env:HTTPS_PROXY = "http://127.0.0.1:10808"`；Git Bash：`export HTTPS_PROXY=http://127.0.0.1:10808`。

也可用环境变量配置（桌面端持久化值优先于 env）：

```powershell
CLAUDE_CENTER_TERMINAL='C:\Program Files\Git\bin\bash.exe'         # 运行终端（空=默认 powershell）
CLAUDE_CENTER_CLAUDE_PRE_COMMAND='export HTTPS_PROXY=http://127.0.0.1:10808'
```

前置命令与 `claude` 在**同一个终端会话**里顺序执行，所以它设置的环境变量（如代理）会被 `claude` 进程继承；`claude` 的 prompt / 各路径通过环境变量传递、不进命令行，并按所选终端家族安全引用（PowerShell `$env:X`、bash `"$X"`、cmd `%X%`），含空格 / 引号 / 换行也不会被破坏。该配置同样作用于「定向指挥」里的 `claude_prompt` 指令。

> WSL 属 best-effort：会通过 `WSLENV` 转发所需变量，但 `claude` 与各路径需为 WSL-native 才能跑通。前置命令只包裹 `claude`，不影响 `git` / `gh`；如果这些命令也要走代理，直接在启动 Worker 的环境里设置 `HTTP_PROXY` / `HTTPS_PROXY`——Worker 会把自身环境透传给所有子进程。桌面窗口顶部还会显示 worker 机器的**操作系统**，套餐账号的「套餐用量」卡片显示 5 小时 / 7 天窗口的**已用百分比 + 重置倒计时**。

## 任务执行的安全姿态（bypassPermissions + deny 护栏）

为了让桌面端尽量无人值守地自主执行任务，Worker 调用 `claude` 跑任务时统一附带三项配置（远程接管整体设计见 `docs/spec/worker-remote-takeover.md`）：

- **`--permission-mode bypassPermissions`**：headless 下不为权限询问停顿，自主跑到底。
- **`--settings <claude-settings.json>`**：注入一组 `deny` 规则，把**写类 git**（`git add` / `commit` / `push` / `checkout` / `switch` / `branch` / `reset` / `merge` / `rebase` / `worktree`）交还 Worker 处理；只读 git（`status` / `diff` / `log` / `show`）放行。`deny` 规则在 `bypassPermissions` 下仍硬生效，是 bypass 姿态下的安全护栏。
- **`--append-system-prompt-file <center-rules.md>`**：注入中控协议规则（headless 上下文 + git 归 Worker），不再每个任务提示词里重复。

默认规则 / 配置文件随 Worker 应用分发（`apps/worker/prompts/center-rules.md`、`apps/worker/config/claude-settings.json`），可经环境变量覆盖：

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `CLAUDE_CENTER_PERMISSION_MODE` | `bypassPermissions` | 任务执行的 `--permission-mode` |
| `CLAUDE_CENTER_CLAUDE_SETTINGS` | 随应用分发的 `claude-settings.json` | `--settings` 的来源（deny 护栏） |
| `CLAUDE_CENTER_CLAUDE_RULES` | 随应用分发的 `center-rules.md` | `--append-system-prompt-file` 的来源 |

> 注意：`bypassPermissions` 会绕过所有权限询问（`claude --help` 建议仅用于隔离沙箱），这是 Worker 自主执行的设计姿态。爆炸半径靠任务工作树隔离 + `deny` 护栏 + 项目 `localPath` 须是可信仓库共同约束；`deny` 是护栏不是硬沙箱（复合命令可能绕过），真正的安全边界是 Worker 独占 git 收尾。本姿态仅作用于**任务执行**，不影响「定向指挥」的 `claude_prompt`。

## 工作状态门控（在线 ≠ 接任务）

Worker 在线（有心跳）**不等于**会领任务。Worker 有独立的「工作状态」：

- **空闲（idle）**：默认态。在线、上报心跳与信息，但**不领取任何任务**（在途任务继续跑完）。
- **工作（working）**：领取并执行任务。

切换工作态有两个入口：

1. **Worker 桌面窗口**的「工作状态」开关（本地，始终可用）。
2. **Web Console** 执行机群 → worker 详情里的「切到工作 / 切到空闲」按钮（远程），需 `command.create`（admin）权限，且**仅当该 Worker 开启了「允许 web 端远程开关」**时生效——这是客户端侧策略，由 Worker 窗口的第二个开关 / `CLAUDE_CENTER_ALLOW_REMOTE_CONTROL` 控制，关闭时远程切换被服务端拒绝（403）。

工作态以 DB 为准（`POST /api/workers/[id]/working-state`、`workers.working_state`），Worker 每个 tick 读它决定是否认领；新 Worker 默认 idle，重启保留上次状态。

Worker 桌面窗口除两个开关外，还提供**并发上限**数字输入（即时改 `workers.max_parallel`，下一轮 tick 生效）。「允许 web 端远程开关」「并发上限」连同上面的本地项目关联都持久化在 `~/.claude-center/worker.json`，跨重启保留；其初值在文件缺失时回退到对应环境变量（`CLAUDE_CENTER_ALLOW_REMOTE_CONTROL` / `CLAUDE_CENTER_MAX_PARALLEL`）。

## 真并发执行（git worktree 隔离）

Worker 可**同时执行多个任务**，上限由 `CLAUDE_CENTER_MAX_PARALLEL`（默认 1）控制。每个任务在**独立的 git worktree**（项目主仓内 `<localPath>/.claude/worktrees/worktree-<taskId>`，从 `origin/<base>` 起工作分支）里跑，互不踩主仓与彼此，故**同项目也能并发**。worktree 建在项目目录内（与 Claude Code 原生 `.claude/worktrees/` 约定一致）而非全局数据目录——cwd 落在项目路径前缀下，Claude Code 的 session 记录因而紧邻项目普通 session；主仓由本地 `.git/info/exclude` 忽略该目录保持干净。worktree 生命周期跨 waiting/resume/rejected 持有，进终态（merged/failed）即拆；启动时 GC 仅清理 `worktree-<UUID>` 任务树（不碰同目录下 Claude Code dev 树）。实现见 `apps/worker/src/worktree.ts`、`runner.ts`。

任务执行期间，Worker 周期性（约 20s）把当前任务对应的 Claude Code session transcript（`.jsonl` 全文）同步到 `task_sessions` 表，进终态（成功/失败/超时/取消）再强制同步一次；Console 任务详情页「执行会话」区读取解析后回放整段会话。实现见 `apps/worker/src/session.ts`、`apps/console/app/ui/task-detail.tsx`。

## 取消在途任务

在途任务（`claimed` / `running` / `waiting`）可被取消，让 Worker **真正中断正在跑的 Claude 进程**：

- **入口**：Console 任务详情页在途态显示「取消任务」按钮（`PATCH /api/tasks/[id]` + `{action:"cancel"}`，需 `task.create` 权限）；Worker 桌面窗口「任务」面板「进行中」分组里每条任务也有「取消」按钮。
- **机制**：取消请求落 `tasks.cancel_requested_at` 时间戳（迁移 `015`，`cancelled` 状态自始合法故无需改约束）。Worker 每 3s 扫描自己名下被请求取消的在途任务，**先把任务抢占为 `cancelled` 终态**（守卫住执行链 catch 里的 `markTaskFailed`，使其不会把 `cancelled` 覆盖回 `failed`），**再杀掉 Claude 进程树**（win32 `taskkill /PID <pid> /T /F`）；进程被杀导致执行链 reject，worktree 由其 catch 清理。
- **best-effort**：只中断长时的 Claude 轮；若取消恰好落在 git 收尾的秒级窗口（任务即将完成），任务可能已成功落终态，取消即成 no-op。

## Worker 详情（执行机群卡片）

Console 执行机群点 worker 卡片展开详情，除在线状态/主机/心跳外，还展示 Worker 周期采集（默认 60s，`CLAUDE_CENTER_INFO_INTERVAL_MS`）并上报的信息：

- **Claude Code 版本**（`claude --version`）。
- **订阅类型**：套餐（Max/Pro/…，读 `~/.claude/.credentials.json` 的 `claudeAiOauth.subscriptionType`）或 API 计费（`ANTHROPIC_API_KEY`）。
- **套餐用量**（仅套餐账号）：5 小时窗口与 7 天窗口的「已用率 + 重置剩余」，数据来自 `https://api.anthropic.com/api/oauth/usage`（用 access token，经 `CLAUDE_CENTER_USAGE_PROXY` / `HTTPS_PROXY` 代理）。该接口给的是利用率百分比，无绝对额度，故以「已用 X%」表达。这条远程请求**独立于上面的 60s 刷新、按 `CLAUDE_CENTER_USAGE_INTERVAL_MS`（默认 300000，即 5 分钟）慢拉**——用量窗口缓变，高频拉取只会触发该接口限流（`rate_limit_error`）。某轮拉取因限流/网络失败时**沿用上一轮已知好数据**（不清空、不报红），仅在 worker 日志轻提示本轮失败原因。
  > **受限网络必看**：这条 usage 请求走的是 `CLAUDE_CENTER_USAGE_PROXY`（缺省回退 worker 进程环境里的 `HTTPS_PROXY`/`HTTP_PROXY`），**与 `CLAUDE_CENTER_CLAUDE_PRE_COMMAND` 的代理是两套出口**——只在 pre-command 里设代理，usage 请求仍直连 `api.anthropic.com`、被挡后返回 `{"error":{"type":"forbidden"}}`，于是套餐账号也采不到用量。国内务必显式配 `CLAUDE_CENTER_USAGE_PROXY`。采集失败时不再静默：worker 日志打印失败原因，Console 详情抽屉的「套餐用量」直接显示「用量采集失败：<原因>」而非空白（仅当从未采到过窗口时）。
- **并行处理**：当前在途任务列表 + 并行上限。

## 任务执行中途确认（评论 ↔ 回复 ↔ 续接）

Worker 执行任务时，若 Claude 需要先与用户确认才能安全推进，会在任务下方留一条提问评论并把任务置为「等待回复」；用户在 Web Console 任务详情的「对话」tab 看到提问并回复后，Worker 下一轮 tick 会**续接同一个 Claude 会话**继续执行，直到完成或再次提问。详见 `docs/spec/task-comment-confirm.md`。

实现要点：

- Worker 用 `claude -p <prompt> --output-format json` 调用，记录返回的 `session_id`；续接时用 `claude -p <回复> --resume <session_id> --output-format json`，且始终在该任务专属的 git worktree 下执行（见「真并发执行」一节；Claude 会话按工作目录持久化在 `~/.claude/projects/`）。
- 约定哨兵串 `<<CLAUDE_CENTER_NEEDS_INPUT>>`：Claude 需要确认时在回复末尾输出该串 + 问题后停止，Worker 解析后落为评论并转入等待。
- 续接路径不重建工作树，复用上一轮该任务 worktree 里的未提交改动；每任务独立 worktree 隔离后，等待中任务不再阻止同项目其它任务被领取（旧的「同项目有等待任务则停领」护栏已移除）。
- 该能力依赖数据库迁移 `002_task_comments.sql`（新增 `task_comments` 表、`tasks.claude_session_id` 列、`waiting` 状态）。升级后务必先跑 `npm run db:migrate`。

## Worker 桌面端任务面板（本机视角）

Worker 桌面窗口的「任务」面板汇总**本机**（`claimed_by` = 本 Worker）认领过的全部任务，按状态分组：**需输入 / 待审 / 进行中 / 已完成**。每行显示状态、标题、`项目·分支`、时长与 PR 标签；点开任一行 peek 其评论与事件流（`waiting` 任务置顶显示待答问题）。与 Web Console 的分工：Console 管多 Worker 协同与远程下发，桌面面板给本机一眼可见 + 就地处理。

就地处理（与 Console 走同一 DB 路径，状态机一致）：

- **回复**：对 `waiting` 任务在 peek 里直接回复 → 落 `user` 评论，Worker 下一轮续接同一会话（同上「中途确认」机制）。
- **打回**：对 `success` 任务填意见打回 → 翻 `rejected`，Worker 续接重跑（复用 Console 验收的 `rejectTask`）。
- **验收通过**：对 `success` 任务一键 `accept` → 终态 `accepted`。
- **取消**：`claimed` / `running` 任务就地取消（同「取消在途任务」机制）。

面板只读取 / 操作本机任务，无新建 / 下发（那是 Console 职责）。设计详见 `docs/spec/worker-agent-view-panel.md`。

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

## 实时直连对话（Worker Direct Chat）

独立于任务流的问答通道：**独立菜单「对话」、独立数据模型、与任务同款的 session jsonl 富展示**。在 Console 选**指定项目（分支）+ 指定 Worker** 直接多轮对话；助手回复以 Claude Code 完整执行会话（工具调用 / 思考 / diff 等）富展示，按 jsonl 周期轮询刷新。与「问答类任务」不同——后者走任务认领队列、不能指定 Worker；本通道定向某个 Worker。完整设计见 `docs/spec/worker-direct-chat.md`（首版）+ `docs/spec/conversation-session-jsonl.md`（jsonl 富展示改造），验收见 `docs/acceptance/`。

实现要点：

- **数据模型**：`conversations`（项目 + 分支 + worker + 模型 + claude 会话，迁移 `017`）、`conversation_messages`（user/assistant，seq 排序）、`conversation_sessions`（Claude Code session `.jsonl` 全文，1:1 侧表，迁移 `019`，与任务 `task_sessions` 同构）。会话记录不自动清理，仅项目 / 会话删除时 `ON DELETE CASCADE`。
- **派发**：照搬 `direct_commands` 的「按 `worker_id` 领专属队列」。Worker tick 里独立一支 `claimNextConversationTurn`——**不受工作态门控、不占任务并发槽、≤1 轮在途**（idle 也应答，用户显式点名了这个 Worker）。
- **执行 + 记录**：Worker 用 `runClaudeJson`（`claude -p ... --output-format json`，与任务同款）在 `origin/<branch>` 的**只读 worktree**里跑（全程不 commit / 不 PR）；执行期间 `startConversationSessionSync` 周期 3s + 终态强制把该会话 session `.jsonl` 全文同步到 `conversation_sessions`，收尾把权威全文落 `conversation_messages.body` + 写回 `claude_session_id`（多轮 `--resume` 续接同一 session）。Console 按需轮询 `GET /api/conversations/:id/session` 取 jsonl，解析为富展示（与任务详情共用 `app/ui/transcript.tsx`：工具折叠 / diff 着色 / markdown / thinking）。
- **代理/环境**：claude 调用走桌面端「终端 / 前置命令」形态（与任务一致），对话所需代理按 Worker 的 `claudePreCommand` / 进程 env 配置即可。
- **权限**：创建 / 发消息复用 `command.create`（与定向指挥同级，仅 admin）；列表 / 查看登录即可、按项目范围过滤。会话改名（`PATCH /api/conversations/:id`）同样复用 `command.create`。
- **会话改名**：Console 对话标题处内联编辑（铅笔 → 输入 → 保存），`renameConversation` 仅改标题不 bump `updated_at`（不打乱列表按活跃排序）。
- **「回复中」可见性**：会话列表对有在途 assistant 轮（pending/streaming）的会话显示「回复中」标（`listConversations` 派生 `generating`）；消息线在「已发出但 jsonl 尚未收录该轮」期用本地乐观气泡 + 思考点，让等待可见。
- **Worker 端对话回显**：桌面端「对话」面板（只读）按 `listWorkerConversations` 列本机承接的会话，展开见消息线（完成的消息见 body 全文，回复中显示状态）。
- 升级后先跑 `npm run db:migrate` 应用 `017` + `019`（`019` 同时删除弃用的 `conversation_message_chunks`）。

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

## Console 定时合并检查 + 自动验收

在 Worker 侧 `merged` 清理之外，**Console 后台定时器**也会独立检查「待验收任务的开发分支是否已并入目标分支」，
合并即**自动验收**——这样即便 Worker 离线，已合并的任务也能自动收口。

- **新增「合并状态」字段** `tasks.merge_status`：`unknown` 未检查 / `unmerged` 未合并 / `merged` 已合并。
  任务流列表新增「合并状态」筛选器与「合并」展示列。
- **检测方式**（`apps/console/app/lib/merge-check.ts`）：gh 优先 + git 祖先回退——有 `pr_url` 用
  `gh pr view --json state` 判 `MERGED`（覆盖 squash/rebase）；gh 不可用（Console 未登录 gh）或无 PR 时，
  回退到远程 git 祖先判定（临时 bare 仓 fetch 两分支 + `merge-base --is-ancestor`）。
- **调度器**（`apps/console/instrumentation.ts`）：在定时发布提升之外新增独立的合并检查循环，每轮取一个
  `success` 待验收工作任务（按 `merge_status_checked_at` 轮转），检测到合并即把任务转 `accepted`、`merge_status='merged'`。
  默认每 60s 一次，可经 `CLAUDE_CENTER_MERGE_CHECK_INTERVAL_MS` 覆盖；刻意慢于 Worker 轮询，让在线 Worker 优先
  完成 `merged` + 分支清理，Console 仅兜底离线场景（两侧都以 `status='success'` 为门，谁先翻态另一侧自动落空）。
- 依赖数据库迁移 `011_task_merge_status.sql`（新增 `merge_status` / `merge_status_checked_at` 列与轮转索引）。
  升级后先跑 `npm run db:migrate`。详见 `docs/spec/task-merge-status-check.md`。

## 定时任务（到点自动进入待处理队列）

新建任务时可在发布表单填一个**定时发布**时间（留空则照旧建为 `draft` 草稿、需人工发布）。填了时间的任务落初始态 `scheduled`（定时待发），到点后由 Console 后台调度器自动转为 `pending`，进入可认领队列供在线 Worker 领取——不用人工到点手动点「发布」。

状态生命周期新增一条入口分支：

```
draft     ──人工发布──────────────────▶ pending ──▶ claimed ──▶ ...
scheduled ──到点(自动) / 人工立即发布──▶ pending ──▶ claimed ──▶ ...
```

实现要点：

- **调度器在 Console**：`apps/console/instrumentation.ts` 在服务进程启动时（Next.js `register()`）起一个周期定时器，调 `promoteDueScheduledTasks`：`UPDATE tasks SET status='pending' WHERE status='scheduled' AND scheduled_at<=now()`，幂等、并逐条落 `scheduled_published` 审计事件。默认每 30s 检查一次，可经 `CLAUDE_CENTER_SCHEDULER_INTERVAL_MS` 覆盖。**Worker 零改动**，仍只认领 `pending`。
- 「定时」机制落在 web 端，状态翻转不依赖 Worker 是否在线，看板始终如实显示；前提是 Console 进程在跑（本就是该 web 特性的前提）。
- 建任务 `POST /api/tasks` 接受可选 `scheduledAt`（ISO 时间），校验为将来时间，落 `scheduled` 态；详情页「发布」按钮对 `scheduled` 任务即「立即发布」（到点前手动提前发布，覆盖定时，复用 `publishTask`，WHERE 放开为 `status IN ('draft','scheduled')`）。
- 该能力依赖数据库迁移 `009_task_scheduled.sql`（新增 `tasks.scheduled_at` 列、`status` CHECK 增加 `scheduled`、待发部分索引）。升级后务必先跑 `npm run db:migrate`。详见 `docs/spec/task-scheduled.md`。

## 移除任务字段：优先级 / 目标文件

任务模型去掉了 `priority`（优先级）和 `target_files`（目标文件）两个字段，发布表单、任务流列表、任务详情概览均不再展示；Claude code 的 `claude_session_id` 仍由 Worker 执行任务时写入，现已在任务详情概览以只读 Session ID 行展示。

实现要点：

- **认领队列改为 FIFO**：`claimNextTask` 原按 `priority DESC, created_at ASC` 取任务，移除 `priority` 后改为纯 `created_at ASC`（先入先领）；`tasks_queue_idx` 索引同步重建为 `(status, created_at)`。
- **Worker 提交全量改动**：`finalizeTask` 原按 `target_files` 限定 `git add` 范围，移除后恒定 `git add --all`；`taskPrompt` 不再输出「Target files」段。
- **任务流列表**：排序从工具栏下拉移到「更新」表头（点击切换 `updated_at` 升/降序，默认降序）；新增「项目」「类型」两列、去掉「优先级」列；「更新」列时间格式改为 `YYYY-MM-dd HH:mm:ss`。
- 该能力依赖数据库迁移 `010_task_drop_priority_target_files.sql`（`DROP COLUMN tasks.priority` / `tasks.target_files`、重建 `tasks_queue_idx`）。升级后务必先跑 `npm run db:migrate`。

## 系统运行状态总览

总览页在业务量卡片下新增「系统运行状态」区，三张健康卡：

- **数据库连接**：连接池 `total/idle/waiting`（上限 10）+ `SELECT 1` 往返延迟。
- **定时调度器**：检查周期、上次检查时间、`scheduled` 待发队列深度、累计提升数、最近错误（若有）。
- **实时同步**：客户端轮询节奏与上次同步时间。

实现要点：

- 这三样分属共享库 / Console 服务进程 / 浏览器三个上下文，**代码各自留在原处**（不强行合并），总览页只做统一的运行健康视图。
- 健康数据**搭 `/api/overview` 既有 3s 轮询返回**（新增 `health: { db, scheduler }` 块），不另开端点、不加定时器。`db` 走 `getPoolStats` + `pingDatabase`；`scheduler` 由 `apps/console/app/lib/scheduler-state.ts` 把调度器的启动 / tick 状态记在 `globalThis`（instrumentation 写、route 读）。
- 全站客户端轮询统一到 `apps/console/app/lib/use-polling.ts` 的 `POLL_INTERVAL_MS` 常量 + `usePolling` hook，取代散落的 `setInterval(…, 3000)`。
- 纯内存调度器状态在单 Console 进程下成立；多实例时为 per-instance 视图。详见 `docs/spec/runtime-health-overview.md`。
