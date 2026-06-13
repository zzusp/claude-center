# 桌面端任务执行内核：远程全权接管设计

> 目标：让远程 Web 端尽量无人值守地全权接管任务执行——桌面端 Worker 自主跑到底，只在 Claude 真正卡住时才把决策点转给远程用户回答、再续接。
>
> 本文是**开工前快照**（方案 + 实测依据 + 实施计划），不回头维护；落地后行为变更同步进 README / 各 `<service>/CLAUDE.md`。

## 1. 背景与现状

ClaudeCenter = Web Console（任务发布/监控）+ 桌面 Worker（领任务、跑 Claude Code、建 PR）+ 共享 Postgres。

当前执行内核（`apps/worker/src/executor.ts`）：

- 调用方式：`claude -p <prompt> --output-format json`，续接用 `--resume <session_id>`（executor.ts:35-66）。
- 「需要确认」靠**哨兵串** `<<CLAUDE_CENTER_NEEDS_INPUT>>`：让 Claude 自己决定停下来、把问题打印在回复末尾、退出；Worker 解析后落评论 + 转 `waiting`（executor.ts:27, 80-87, 179-185）。
- git 签出**直接在项目共享工作树**上 `checkout -B work_branch`（executor.ts:314-319）。
- 收尾 commit/push、`gh pr create`、合并轮询清理都已实现且稳（executor.ts:205-295, 421-469）。
- 没有传 `--permission-mode`，权限姿态是**隐性依赖机器上的 `~/.claude/settings.json`**。

五个待设计好的底层细节（用户提出）：worktree 工作分支签出 / 实施中确认的拦截转发 / PR 提交与成功检查 / 任务发起 / 前置提示词（约束规则）。用户主张「脚本 + hook 相结合」，确保远程 Web 端能全权接管。

## 2. 核心决策与实测依据

围绕「如何实现『卡住才介入』」做了取舍。关键事实**全部在本机实测**（`claude` v2.1.177，探针脚本见 §9 验证项），不靠记忆：

| 机制 | headless `-p` 实测行为 | 结论 |
| --- | --- | --- |
| `/goal <完成条件>` | `-p` 下可用，设完成条件、每轮末自核对、未达成则继续 | ✅ 采用：自驱到底，减少无谓停顿 |
| `--permission-mode bypassPermissions` | 不再为权限停；且 `deny`/`ask` 规则**在 bypass 下仍硬生效**（官方 permission-modes 文档 + 探针） | ✅ 采用：自主跑 + 仍可用 `deny` 守边界 |
| `SendUserMessage`（`--brief`） | 模型回 `NO_SUCH_TOOL`，init 工具清单里**没有它**（gated behind Agent Teams flag） | ❌ 弃用：该模式不存在 |
| `AskUserQuestion`（原生、清单里有） | tool_use 触发，但 tool_result `is_error:true`，模型随即 `NO_ANSWER` 收尾——**不阻塞、拿不到答案** | ⚠️ 纯 `-p` 不可用；要可答必须开双向 `--input-format stream-json` 控制协议（≈ 重写 SDK） |

**核心结论**：headless CLI 里**没有**「提问 → 阻塞 → 真人答 → 同进程继续」的现成轻量工具。「卡住才介入」只有两种真实形态：

- **形态一（采用）**：停下来 + `--resume`。Claude 靠 `/goal` + bypassPermissions 自主跑；真需决策时**结束本轮**（发哨兵 + 问题），Worker 落评论转 `waiting`，用户回复后 `--resume` 续接。代价是每轮重启进程，但会话持久化在磁盘、续接无损。残留「卡住」本就稀，重启成本可接受。
- **形态二（不采用）**：双向 stream-json 实时接管，不重启进程，但复杂度 ≈ 自己重写 Agent SDK 的控制协议，与「不上 SDK / 尽量少介入」的取向矛盾。

**已决策**：走形态一。`/goal` + bypassPermissions + `deny` 护栏；`SendUserMessage` 弃用；澄清继续走现有「评论↔回复↔resume」环，只是触发得更少。

**明确非目标**：形态二双向控制协议、迁移到 Agent SDK、`SendUserMessage`、PreToolUse 实时权限转发 hook——本轮全部排除。

## 3. 总体架构（形态一）

```
claimNextTask ──► 建 worktree(脚本) ──► 组装提示词(系统层约束 + /goal + 任务) ──► claude -p --resume? --permission-mode bypassPermissions --settings(deny) --append-system-prompt-file(协议)
                                                                                              │
                                          ┌───────────────────────────────────────────────────┤
                                          ▼ 回复含哨兵                                          ▼ 无哨兵且改动完成
                                  落评论 + 转 waiting(转 Web)                            finalize(脚本): commit/push/PR
                                          │                                                     │
                                  用户在 Web 回复 ──► resumeTask(--resume 续接)            success ──► 合并轮询清理 ──► merged
```

一句话：**脚本管 Claude 跑之外的确定性生命周期（worktree / git / PR），系统层配置（bypass + deny + append-system-prompt + /goal）管 Claude 跑之内的边界与自驱，哨兵 + resume 管稀有的人工介入。**

## 4. 五个关注点的设计

### 4.1 worktree 工作分支签出（脚本）

**现状/问题**：`executeTask` 在共享工作树上 `checkout -B work_branch`（executor.ts:314-319）。后果：
- 同项目只能串行；等待中的工作类任务持有未提交改动，新任务会 `checkout` 清掉它——故在 `claimNextTask` 加了互斥（queries.ts:391-401：本 worker 在该项目有 `waiting` 工作类任务时不领新任务）。
- 打回重跑要先 `checkout work_branch` 恢复（executor.ts:394）。

**方案**：每个**工作类**任务用独立 worktree（问答类只读、不碰 git，保持在共享 localPath 跑，不变）：

```
git -C <localPath> fetch origin
git -C <localPath> worktree add <worktreePath> -B <work_branch> origin/<base_branch>
# claude 的 cwd = <worktreePath>
```

- `<worktreePath>` 由 `CLAUDE_CENTER_WORKTREE_DIR`（默认 `<dataDir>/worktrees`）+ `<projectId>/<taskId>` 确定性派生。
- Claude 会话按 cwd 持久化在 `~/.claude/projects/`，每个 worktree 天然隔离一个会话，正好契合 `--resume`。
- **生命周期**：
  - execute：从 `origin/<base_branch>` 建 worktree。
  - resume：worktree 持续存在（未到终态不清理），直接以 `cwd=<worktreePath>` 续接、不碰 git（保留上轮改动）。
  - rerun（打回）：worktree 仍在则 cd 进续接；若缺失（worker 重启/外部清理）则从远端 `origin/<work_branch>` 重建——比现状 `checkout work_branch` 更稳。
  - cleanup（merged）：`git -C <localPath> worktree remove <worktreePath> --force` + 删本地/远端 work 分支。
- **放开互斥**：worktree 隔离后，等待任务的改动在自己的 worktree 里、不会被新任务清掉，故 `claimNextTask` 的 `waiting` 互斥（queries.ts:394-401）可删除——一个项目可同时推进等待任务与其他任务。
- **孤儿清理**：失败/取消的任务也要清 worktree；加一个启动时 `git worktree prune` + 扫描无主 worktree 的兜底。

**注**：Worker tick 仍是「一轮一任务」串行，worktree 的直接收益是**隔离 + 解除工作树锁**（不再冻结项目任务流转），而非同 tick 并行。

### 4.2 实施中确认的拦截/转发（停 + resume + 哨兵）

**诚实定性**：形态一**没有实时拦截**。介入发生在**轮边界**——Claude 停下并提问，Worker 转发，用户回答，`--resume` 续接。

- 保留现有哨兵 `<<CLAUDE_CENTER_NEEDS_INPUT>>` 机制（探针证明它是该平台约束下的正解，非将就）。
- 改动仅两点叠加：① claude 调用加 `--permission-mode bypassPermissions`（不再因权限失败/停顿）；② 任务用 `/goal` 自驱（见 4.4）。
- **哨兵指令迁出**到系统层（见 4.5），不再每个任务提示词重复。

### 4.3 PR 提交与成功检查（脚本 + deny 护栏）

**现状已稳**，保留 `finalizeTask`（commit/push/`gh pr create`/URL 正则提取，executor.ts:205-295）与 `cleanupMergedTask`（`gh pr view --json state` 合并轮询，executor.ts:421-469）。

**新增护栏**：bypassPermissions 下 Claude 可自由跑 git，会与 Worker 拥有的 finalize 冲突（双方都 `git add/commit`）。用 `--settings` 注入 `deny` 把「写类 git」交还 Worker：

- deny：`Bash(git commit:*)`、`Bash(git push:*)`、`Bash(git checkout:*)`、`Bash(git reset:*)`、`Bash(git rebase:*)`、`Bash(git merge:*)`、`Bash(git branch:*)`、`Bash(git add:*)`、`Bash(git worktree:*)`。
- 放行只读：`git status/diff/log/show`（不进 deny）。
- **边界**：deny 是护栏不是硬沙箱——复合命令（`git add . && git commit`）可能绕过匹配；真正的安全靠 **worktree 隔离爆炸半径** + **Worker 独占 finalize**。deny 仅防 Claude「顺手把活干一半」打乱 Worker 的 git 流程。

### 4.4 任务发起（脚本编排 + /goal）

**现状**：`executeTask`/`resumeTask`/`rerunRejectedTask` 各自内联组装提示词、各自调 claude（executor.ts:298-407），重复多。

**方案**：
- 收敛成**一个 launch 包装**：入参 `{ cwd, prompt, resumeSessionId? }`，统一加 bypass/settings/append-system-prompt，三条路（execute/resume/rerun）复用。
- 用 `/goal` 框定「完成条件」让 Claude 自核对完成度。`/goal` 在 `-p` 下生效（已实测）。
- **待验证**（§9 P1/P2）：`/goal` 与任务详情在单次 `-p` 里如何组合（单条 `/goal` 命令 vs 提示词内含「Definition of Done」段 + `/goal` 自核对）；`--resume` 跨轮是否保留 goal。落地前用探针定，不在此臆断具体调用串。

### 4.5 前置提示词分层（约束/规则）

**现状**：`taskPrompt` 把任务 + 哨兵协议 + 工作守则全拼在一起，每个任务重复（executor.ts:89-104）。

**方案——三层解耦**：

| 层 | 内容 | 载体 |
| --- | --- | --- |
| 中控协议规则 | 「你在 ClaudeCenter headless 自主执行；不要跑写类 git，Worker 负责所有 git/PR；遇到无法安全决策的点，回复末尾输出哨兵 + 问题并停止」 | `--append-system-prompt-file <中控规则文件>`（一处，不再每任务重复） |
| 能力硬约束 | 写类 git 等 `deny` 规则 | `--settings <denyJson>`（中控注入，不依赖机器本地 settings） |
| 项目惯例 | 仓库自身规则 | repo `CLAUDE.md`（`-p` 自动加载；勿用 `--bare`） |
| 本任务 | 标题/描述/目标文件 + 完成条件 | user prompt（`/goal` 框定） |

中控规则文件随 worker 应用维护（如 `apps/worker/prompts/center-rules.md`）。

## 5. 脚本 vs hook 职责划分

用户初始设想「脚本 + hook 相结合」；调研后**hook 在形态一不再是承重件**——bypassPermissions 取代了「PreToolUse 实时权限转发」的需求，而 headless 又无法靠 hook 阻塞等真人答（§2）。如实记录：

- **脚本**（Worker 拥有、带 `--check` 自检）：worktree 签出/清理/孤儿 prune、git finalize（PR/push）、合并检查、launch 包装、claude 前置命令（代理/VPN，已有）。
- **系统层配置**（中控注入 flag）：`--permission-mode bypassPermissions`、`--settings`（deny）、`--append-system-prompt-file`、`/goal`。
- **hook**：形态一下**可选**，仅用于观测——若日后要远程实时看进度，再上 `--output-format stream-json --include-partial-messages --include-hook-events`。本轮不做。

## 6. 对现有代码的改动清单

| 文件 | 改动 |
| --- | --- |
| `apps/worker/src/executor.ts` | `runClaudeJson`/`runClaude` 增 `--permission-mode bypassPermissions`、`--settings <deny>`、`--append-system-prompt-file <规则>`；提示词构造把哨兵协议移到系统层、`taskPrompt` 聚焦任务 + `/goal`；`executeTask` 的 `checkout -B`（314-319）改 `git worktree add`；`resumeTask`/`rerunRejectedTask`/`cleanupMergedTask` 适配 worktree 路径与 `worktree remove` |
| `apps/worker/src/config.ts` | 新增 `CLAUDE_CENTER_WORKTREE_DIR`（默认 `<dataDir>/worktrees`）、中控规则文件路径、deny settings 来源 |
| `packages/db/src/queries.ts` | `claimNextTask` 删除 `waiting` 工作类互斥（394-401），由 worktree 隔离取代 |
| `apps/worker/prompts/center-rules.md`（新） | 中控协议规则正文（append-system-prompt 源） |
| 脚本（新，`scripts/` 或 worker 内） | worktree 签出/清理、deny settings 生成，均带 `--check` |
| `README.md` | 同步：bypassPermissions 姿态、`/goal`、worktree 目录、deny 护栏、新 env |

## 7. 数据库影响

无 schema 变更。仅删除 `claimNextTask` 的一段 `NOT EXISTS`（行为放宽，无迁移）。

## 8. 实施计划（分步，每步可独立 ship + 验证）

1. **前置约束分层 + bypass + deny 护栏**：executor 加 flag、建中控规则文件、生成 deny settings。先验 **P3**（deny 在 bypass 下真拦住、含复合命令边界）。风险最低，先落。
2. **/goal 框定 + 哨兵迁系统层**：提示词重构 + launch 包装收敛。先验 **P1**（/goal × 哨兵优先级）、**P2**（/goal 组合与跨 resume 保留）。
3. **worktree 签出/清理 + 放开互斥**：executor + config + 孤儿 prune + 删 `claimNextTask` 互斥。先验 **P4**（worktree 路径会话持久化跨 resume 无损）。改动较大，独立 PR。
4. （可选，后续）stream-json 观测层。

每步按 `项目产物归档规范`：改动涉代码即兑现 3 条 ship 硬线（本地实跑过 / push 前查 PR state / PR body 自包含）；worktree + 互斥这步属 risky（改领取逻辑），走 feature branch + PR + 验证证据链（`docs/acceptance/worker-remote-takeover/`）。

## 9. 待验证项（落地前用探针定，不臆断）

| ID | 验证什么 | 方法 |
| --- | --- | --- |
| P1 | `/goal`（自驱「没达成就继续」）与「遇真决策点发哨兵停下」叠加 bypass 时，Claude 是**倾向硬试**还是**会停下问** | 构造一个必须问用户才能定的小任务，`-p` + `/goal` + bypass 跑，看是否产出哨兵并停 |
| P2 | `/goal` 与任务详情在单次 `-p` 的组合方式；`--resume` 是否保留 goal | 对比「`/goal` 单命令」与「提示词含 DoD + `/goal`」两种，跑 execute→waiting→resume 全链 |
| P3 | `deny: Bash(git commit:*)` 等在 bypassPermissions 下真拦住；复合命令边界 | 让 Claude 尝试 `git commit` / `git add . && git commit`，看是否被 deny |
| P4 | worktree 路径的 Claude 会话持久化跨多次 `-p --resume` 无损 | execute 留哨兵 → resume，确认续接的是同一会话、上轮改动还在 |

> 探针沿用本设计期所用方式：prompt 走 stdin（避开 `Start-Process -ArgumentList` 引号损坏）、`--output-format stream-json --verbose`、`WaitForExit` 超时兜底、走本地代理 `127.0.0.1:10808`。

## 10. 风险与边界

- **bypassPermissions 是 Worker 的设计姿态**：`claude --help` 原话「Recommended only for sandboxes with no internet access」。Worker 跑在开发者真实机器、真实仓库、有网络——这是该姿态的高风险场景。缓解：worktree 隔离爆炸半径 + `deny` 护栏 + 项目 localPath 必须是可信仓库 + `rm -rf /`～ 类硬熔断仍在。需用户知情接受。
- **deny ≠ 硬沙箱**：复合命令可能绕过；真正安全靠 worktree 隔离 + Worker 独占 finalize。
- **形态一的重启成本**：每轮人工介入重启一次 claude 进程；因 `/goal` + bypass 让介入变稀，可接受。若日后介入变频繁或需「不重启实时接管」，再评估形态二（双向 stream-json，复杂度 ≈ SDK）。
- **`/goal` 行为未完全收敛**：P1/P2 未跑前，/goal 的承重程度是盲点；若 P1 显示 /goal 与哨兵冲突，退化为「不用 /goal、仅 bypass + 提示词内 DoD」也可独立成立。
