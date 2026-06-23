# round-1

## 环境

- worktree 内验证，临时库零污染（建库→全量迁移→DROP WITH FORCE）。
- console 起在空闲端口（freePort），不撞主检出/兄弟 worktree。

## typecheck / build

```
npm run typecheck   # db / relay-client / console / worker / relay 五包 → 全绿
npm run clean:next && npm -w @claude-center/console run build   # 通过；/tasks/[id] 路由编译成功
```

## HTTP e2e（真实路由）

`node docs/acceptance/task-edit-subrepos/scripts/e2e-edit-task-subrepos.mjs`

实跑输出：

```
✓ created cc_e2e_editsub_1782180287995
✓ migrations applied
✓ console ready on http://127.0.0.1:57285
✓ logged in
✓ project + sub repo created (subId=0476a2ef-6909-4465-a0c9-9be91339c808)
✓ 新建任务默认子仓 skipped（未启用）
✓ 编辑表单启用子仓 + 自定义分支 → task_repos 正确落库
✓ 编辑表单取消勾选子仓 → task_repos 回到 skipped
ALL E2E CHECKS PASSED
✓ dropped cc_e2e_editsub_1782180287995
```

断言点：
- 新建任务（POST /api/tasks 不带 taskRepos）→ 子仓 `task_repos.sub_status='skipped'`。
- PATCH `action=update` 带 `taskRepos:[{projectRepoId, baseBranch:'dev', workBranch:'cc/widgets-x', targetBranch:'release', enabled:true}]`（编辑表单 `serializeTaskRepos` 产出的形状）→ 子仓 `sub_status!=='skipped'` 且 `base_branch=dev / work_branch=cc/widgets-x / target_branch=release`。
- PATCH `action=update` 带 `taskRepos:[]` → 子仓回到 `sub_status='skipped'`。

## 未跑

- `ui-clickthrough`：浏览器实点编辑弹窗（勾选子仓 / 改分支 / 保存 / 复核回填）需带鉴权运行态 + 浏览器驱动；本无人值守环境未跑。子仓配置组件（`SubRepoConfigSection`）系从已上线的新建表单原样复用，数据契约已由上面 HTTP e2e 覆盖。
