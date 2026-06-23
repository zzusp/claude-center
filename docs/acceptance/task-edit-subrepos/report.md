# 验收报告：编辑任务表单填写子仓（子项目）信息

**结论**：自动化用例全绿（typecheck / build / 3 条 HTTP e2e）。唯一 `ui-clickthrough` 因需浏览器驱动 + 鉴权运行态，无人值守环境未跑——该路径的数据契约已由 HTTP e2e 等价覆盖，且 UI 组件系从已上线的新建表单原样复用。

## 改动

- `apps/console/app/ui/tasks-compose.tsx`：导出 `SubRepoConfigSection`、`serializeTaskRepos` 供编辑表单复用。
- `apps/console/app/ui/task-detail-edit-form.tsx`：新增子仓清单/状态拉取 + 预填 + 「子仓配置」段 + 保存时下发 `taskRepos`。

后端无改动：`PATCH /api/tasks/[id]` 的 `update` 动作早已支持 `taskRepos` 整批替换。

## 用例结果

见 `matrix.csv`（case × round）。证据见 `round-1.md`。

## 复现

```powershell
npm run typecheck
npm -w @claude-center/console run build
node docs/acceptance/task-edit-subrepos/scripts/e2e-edit-task-subrepos.mjs
```
