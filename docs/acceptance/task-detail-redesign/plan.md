# 任务详情页重新设计：四 Tab → 状态总览 + 双栏

## 需求
重新设计 `/tasks/[id]` 任务详情页的展示。现状是「单卡片 + 四 Tab（概览/对话/时间线/日志）」，问题：
- **状态不可一眼读**：当前没有醒目的「现在发生什么」，生命周期进度被塞进「时间线」Tab 需点击才见。
- **信息被 Tab 切碎**：概览是纯 KV 平铺所有字段、主次不分；验收动作藏在概览 Tab 顶部。
- **版面利用低**：880px 单栏，未用双栏分主次。

目标（延续现有 Claude Light AI 灰阶克制风格，只改信息组织与布局）：
1. 顶部状态总览：标题 + 状态标签 + **横向生命周期进度条** + 关键动作（发布 / 验收 / 打回）一眼可见可操作。
2. 主体双栏：左主栏铺开「描述 / 对话 / 活动事件 / 日志」，右侧栏常驻「元信息 + 前置任务」。
3. 去掉 Tab 切换，信息不再藏。

## 方案（仅改 2 个文件，无后端 / 数据变更）
1. `apps/console/app/ui/task-detail.tsx`
   - 删除 `DetailTab` 状态与 Tab 渲染分支。
   - 顶栏 `header` 保留：返回 + 标题 + badges（状态 / 阻塞 / 类型 / 分支 / 提交模式 / PR）。
   - 新增 **Hero 区**（`.detail-hero`）：横向生命周期 stepper（`.lifecycle-bar`，复用 `lifecycle` 数组）+ 动作区（draft/scheduled→发布；success→`TaskReviewActions` 验收/打回）。
   - 主体 `.detail-grid` 双栏：
     - 左 `.detail-main`：描述区、对话区（`TaskConversation`）、活动事件区（真实 `task_events`，与 Hero 的阶段 stepper 互补不重复）、日志区（`logText`）。
     - 右 `.detail-side`（sticky）：元信息 `.kv`（项目/类型/分支×3/提交模式/自动合并/模型/Session/定时/创建/更新/PR）、前置任务卡片。
   - 保留全部既有逻辑：两路轮询、`publish`、`handleBack`、`TaskReviewActions`、`TaskConversation`（回复/结束对话/权限）。
2. `apps/console/app/globals.css`
   - 新增 `.detail-hero`、`.lifecycle-bar` / `.lc-step` / `.lc-node` / `.lc-line`、`.detail-grid` / `.detail-main` / `.detail-side`、`.detail-section`（区块卡片标题）等。
   - 复用既有 `.card / .kv / .chat / .timeline / .logs / .badge / .tag / .review-actions`。
   - 窄屏（<900px）双栏堆叠为单栏。
   - 移除/保留旧 `.detail-card`（不再使用，删除）。

## 验证（npm workspaces）
- `npm -w @claude-center/console run typecheck` 通过。
- `npm -w @claude-center/console run build` 通过（含路由 `/tasks/[id]`）。
- 本地 `npm run dev:console` 实跑多形态：work 任务（running/success/merged/failed）、qa 任务（waiting/success）、draft、有前置/有 PR/有定时；逐项肉眼核对：进度条高亮当前阶段、动作按钮按状态出现、双栏布局、窄屏堆叠、对话回复与验收/打回可用。
