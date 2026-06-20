# 新建任务弹窗恢复原样式 + 表单优化

## 需求（4 项）

1. 新建任务弹窗恢复「原表单样式」——与编辑任务表单一致（单列分区，不再宽弹窗左右分栏）。
2. 优化「前置任务」UI，专业一点。
3. 「定时发布」时间选择器里小时 / 分钟的下拉框改自定义样式，不用浏览器原生 `<select>`。
4. 编辑任务表单字段不全，参考新建表单补全——补「前置任务」字段。

## 方案与改动

### 1. 新建弹窗单列化（`apps/console/app/ui/tasks-compose.tsx` + `globals.css`）
- `ComposeTaskForm` 去掉 `compose-cols` / `compose-col` 左右分栏，改为单列堆叠
  `基本信息 → 分支配置 → 执行选项 → 调度 → 子仓配置`，与 `TaskEditForm` 同序同 `className="form"`。
- `TaskComposeModal` 弹窗尺寸 `xl`(1040) → 默认 `lg`(720)，与编辑弹窗一致。
- 删除已无用的 `.compose-cols` / `.compose-col` 及其 820px 媒体查询。

### 2. 前置任务专业化（`tasks-compose.tsx` 新增 `DependencyPicker` + `globals.css` `.dep-picker*`）
- 替换原生 `<select multiple>` 为带边框可滚动列表：每行「勾选态 + 状态徽标(StatusBadge) + 标题」，整行可点，
  底部「已选 N 个」。受控 `value`(id 列表) + `onChange`；带 `name` 时为每个选中项渲染隐藏 `input`，
  保持新建表单 `FormData.getAll("dependsOn")` 取值路径不变。

### 3. 时间下拉自定义化（`apps/console/app/ui/controls.tsx` + `globals.css`）
- `DateTimePicker` 时间行的小时 / 分钟由原生 `<select>` 改用既有自定义 `Select`（cc-select）。
- 给 `Select` 增 `direction?: "down" | "up"`：时间行贴近面板底部，用 `direction="up"` 向上展开避免被弹窗滚动区裁切。
- 紧凑样式 `.dt-time-row .dt-time-cc *`（58px 宽、等宽数字、隐藏勾选图标）。
- 删除已无用的 `.dt-time-select`。

### 4. 编辑表单补「前置任务」（`task-detail-edit-form.tsx` + 后端）
- 编辑表单「调度」区在「定时发布」下新增「前置任务」，复用 `DependencyPicker`。
- 候选任务（同项目、排除自身 / 已取消）+ 当前依赖按需拉取（`task.depends_on` 优先，列表页 task 无该字段时回退
  `GET /api/tasks/{id}`）；`depsReady && candidatesLoaded` 双就绪后才渲染，避免「未加载完即保存」误清空。
- 后端 `PATCH /api/tasks/[id]` action=update 支持 `dependsOn`：显式数组才整批替换，`undefined` 保持原依赖不变。
  新增 `setTaskDependencies()`（DELETE 旧 + 复用 `addTaskDependencies` 校验插新），在 update 同事务内执行。

## 验证

- `npm run typecheck`（5 包）✓ ；`npm run build`（含 next webpack build）✓
- `node scripts/ephemeral-db.mjs --verify`：一次性干净库 401→200 + `scheduler.ok:true` ✓
- `scripts/verify-deps.mjs`（本目录）：依赖编辑后端闭环 10/10 PASS（见 `report.md`）。

## 决策记录（不扩大解读）

- 第 4 项只补「前置任务」：它是与新建表单同区段、唯一缺失的可编辑字段。附件编辑后端 update 不支持、子仓编辑
  现有设计刻意「编辑表单不带多仓 UI、taskRepos=undefined 时保留子仓配置」，两者均属独立特性，不在本次「补字段」范围。
