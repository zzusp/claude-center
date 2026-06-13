# 任务分支配置 + 提交模式

## 需求

任务发布时支持：

1. **签出分支**（checkout / base）：Worker 从哪个分支拉取并切出工作分支。
2. **PR 目标分支**（target）：PR 合并目标；分支列表可根据项目仓库地址远程拉取后搜索。
3. **提交模式**（submit mode）：
   - `pr`：推送工作分支并用 `gh` 创建 PR（目标为「PR 目标分支」）。
   - `push`：在工作分支完成改动后，直接把改动推送到「目标分支」，不创建 PR。

## 现状

`tasks.base_branch` 一身二职：既是 `git checkout` 的签出分支，又是 `gh pr create --base` 的 PR 目标。`work_branch` 是工作分支。executor 固定走 PR 流程。

## 方案

### 数据模型（迁移 `003_task_target_branch.sql`）

- `base_branch` 语义收敛为「签出分支」（工作起点），列名不变。
- 新增 `target_branch text NOT NULL DEFAULT 'main'`：PR 模式下是 PR base，push 模式下是直接推送目标。存量行回填为各自的 `base_branch`，保持旧行为。
- 新增 `submit_mode text NOT NULL DEFAULT 'pr' CHECK (submit_mode IN ('pr','push'))`。

### 类型 / 查询 / API

- `Task` 增加 `target_branch`、`submit_mode`；新增 `TaskSubmitMode` 类型。
- `createTask` 增加 `targetBranch`、`submitMode` 入参。
- `POST /api/tasks`：`targetBranch` 缺省回退到 `baseBranch`，`submitMode` 缺省 `pr`、非法值回退 `pr`。

### 分支远程拉取

- 新增 `GET /api/projects/[id]/branches`：后端 `git ls-remote --heads <repo_url>` 解析 `refs/heads/*`，返回分支名数组（默认分支置顶）。
- private 仓库需要 Console 机器具备 git 凭据；失败返回 502 + 错误信息，前端降级为手动输入。

### 执行（executor）

签出与建工作分支不变：`fetch` → `checkout base_branch` → `pull --ff-only base_branch` → `checkout -B work_branch` → Claude 执行。

收尾按 `submit_mode` 分流：

- `pr`：`add` → `commit` → `push -u origin work_branch` → `gh pr create --base target_branch --head work_branch`，记录 PR URL。
- `push`：`add` → `commit` → `git push origin <work_branch>:<target_branch>`（工作分支提交直推目标分支），不开 PR，`pr_url = null`。

两种模式都先在 `work_branch` 上工作（隔离，不污染本地 base/target 分支跟踪），区别只在收尾推送目标与是否开 PR。

### UI（发布任务表单）

- 「签出分支」「PR 目标分支」改为 `<input list>` + `<datalist>`，选项来自 `/api/projects/[id]/branches`（选定项目后拉取），原生输入即搜索；拉取失败仍可手填。
- 新增「提交模式」下拉（PR / 直接提交推送）。
- 任务详情展示签出分支、目标分支、提交模式。

## 验证

- `npm run typecheck` + `npm run build` 全绿。
- `git ls-remote` 解析逻辑：对本仓库 URL 返回非空分支列表、默认分支置顶。
