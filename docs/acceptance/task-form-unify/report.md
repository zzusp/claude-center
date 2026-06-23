# 验收报告：新建/编辑任务表单统一

全绿。详见 `matrix.csv`、方案 `plan.md`。

## 验证命令与结果

```
npm run typecheck      # db/relay-client/console/worker/relay 五包 → 全过
npm run build          # 五包构建（含 next webpack build，/tasks、/tasks/[id] 正常产出）→ 全过
node docs/acceptance/task-form-unify/scripts/e2e-edit-task-attachments.mjs
  ✓ 新建任务带 2 附件，详情正确返回 task.attachments
  ✓ 编辑表单 保留+新增+移除 → task.attachments 同步正确
  ✓ 被移除的附件行真被删除（二进制 404）
  ✓ 编辑清空附件 → 全部移除并删除
  ✓ 不带 attachmentIds 的编辑保持原附件不动（兼容旧前端）
  ALL E2E CHECKS PASSED
```

## 结论

- 后端 `syncTaskAttachments` + PATCH action=update 的 `attachmentIds` 契约经真实路由全链路验证：增 / 删 / 保留 / 缺省四态均正确。
- 前端编辑表单字段位置 / 提示 / datalist / 附件上传与新建表单逐项对齐（结构改动由 typecheck + next build 兜底）。
- 「未发布前所有表单项可改」随附件字段补齐而满足（编辑入口已由 `canEdit=draft|scheduled` 把关）。

## UI 对齐项（结构改动，build 绿覆盖；未单独截图）

- 基本信息：目标 textarea rows=6 + 附件提示 + `AttachmentUploader`。
- 分支配置：远程分支 datalist + PR 目标分支「留空同签出分支」+ 工作分支「留空自动生成」。
- 执行选项顺序：行1 自动合并 / 自动回复；行2 模型 / 动态工作流（与新建一致）。
- 自动合并 / 自动回复 / 模型 / 定时发布 提示文案与新建一致。
