# 新建任务表单 / 编辑任务表单统一

## 需求

新建任务表单（`ComposeTaskForm`）与编辑任务表单（`TaskEditForm`）应一致：
1. 表单项位置（顺序 / 分栏）统一。
2. 补齐编辑表单缺失的表单项。
3. 只要任务未发布（草稿 / 定时态），所有表单项都应可修改。

## 现状差异（核验后）

| 维度 | 新建 `ComposeTaskForm` | 编辑 `TaskEditForm`（改前） |
| --- | --- | --- |
| 附件上传 | 基本信息区有 `AttachmentUploader` | **完全缺失**（且后端 update 不支持） |
| 目标 textarea | rows=6 + 附件提示 | rows=4，无提示 |
| 执行选项顺序 | 行1 自动合并 / 自动回复；行2 模型 / 动态工作流 | 行1 自动合并 / **模型**；行2 **自动回复** / 动态工作流 |
| 分支提示 / datalist | PR 目标分支「留空同签出分支」、工作分支「留空自动生成」、远程分支 datalist | 均无 |
| 自动合并 / 自动回复 / 模型 提示 | 有 | 无 |
| 定时发布提示 | 「留空即建为草稿…到点自动进入待处理队列」 | 「留空则为草稿」 |

> 唯一应保留的差异：编辑表单不含「项目」选择——任务项目不可迁移。

## 方案与改动

### 后端：支持编辑附件（新接的数据契约）
- `packages/db/src/queries.ts` 新增 `syncTaskAttachments(client, taskId, desiredIds, ownerUserId)`：
  - `desiredIds` 为「保留 + 新增」期望全集；新增项（未绑定 + 归属本人/admin）复用 `bindAttachmentsToTask` 绑定；
  - 移除项（当前绑定本任务但不在 desiredIds 内）`DELETE`（FK CASCADE 连带删 blob）；保留项不动。在调用方事务内执行。
- `apps/console/app/api/tasks/[id]/route.ts` action=update：body 加 `attachmentIds?`，
  显式数组才在同事务内 `syncTaskAttachments`（`undefined` 保持原附件不动，兼容旧前端）；带数量上限校验。

### 前端：编辑表单逐项对齐新建表单
- `apps/console/app/ui/task-detail-edit-form.tsx`：
  - 基本信息区加 `AttachmentUploader`（预填 `task.attachments`，列表页 task 不带时由 `/api/tasks/{id}` effect 回补）；
    提交时 `attachmentIds: attachments.map(a=>a.id)` 整批下发。
  - 目标 textarea rows 4→6 + 附件提示。
  - 执行选项顺序调成与新建一致（自动回复升到行1、模型降到行2）。
  - 补分支 datalist（新增分支拉取 effect）+ PR 目标分支 / 工作分支提示 + 自动合并 / 自动回复 / 模型 / 定时发布提示。

## 验证

- `npm run typecheck`（5 包）✓ ；`npm run build`（含 next webpack build）✓
- `scripts/e2e-edit-task-attachments.mjs`：临时库 + 起 console + 真实路由全链路，
  附件「新建带 2 个 / 编辑保留+新增+移除 / 清空 / 不带字段保持原样」5 项 PASS（见 `report.md`、`matrix.csv`）。

## 决策记录（不扩大解读）

- 不抽共享表单组件：两表单提交机制不同（新建 FormData 非受控 + 父 onSubmit / 编辑受控 + PATCH，且按钮集、项目选择不同），
  抽取需大量分叉 props，属过度设计；改为逐项对齐字段/顺序/提示，保留各自机制。
- 移除的已绑附件采用「删除」而非「解绑留孤儿」：用户在编辑表单主动移除即意图删除，直接删更干净（孤儿仅靠 cron 兜底）。
- 「未发布可改」本就由编辑入口 `canEdit = draft|scheduled` 把关、字段仅 `disabled={busy}`；本次补齐的附件字段同样仅 busy 时禁用，
  故未发布前全字段可改的需求随附件补齐即满足。
