# 验收报告 — 任务详情页重新设计（四 Tab → 状态总览 + 双栏）

状态：**全绿**（matrix.csv 13/13 PASS，round-1）。

## 改了什么
仅 2 个文件，无后端 / 数据 / 接口变更，逻辑全部沿用。
- `apps/console/app/ui/task-detail.tsx`：去掉「概览/对话/时间线/日志」四 Tab；新增顶部 **状态总览 Hero**（横向生命周期 stepper + 关键动作：发布 / 验收 / 打回）；主体改 **双栏**（左：描述 / 对话 / 活动事件 / 日志；右：元信息 + 前置任务）。新增 `Section` 区块组件；前置任务改为带状态徽章、可点击跳转的列表。
- `apps/console/app/globals.css`：新增 `.detail-hero`、`.lifecycle-bar/.lc-step/.lc-node`、`.detail-grid/.detail-main/.detail-side`、`.detail-section/.section-head/.section-body`、`.dep-list/.dep-item` 等；`.detail-page-body` 宽度 880→1180px、改 flex 列布局；删除废弃 `.detail-card`；<900px 双栏堆叠。延续 Claude Light AI 灰阶克制风格。

## 设计要点
- **状态优先**：进度条高亮当前阶段（active 节点呼吸动画）、各阶段时间随节点显示，「现在发生什么」一眼可读。
- **信息不藏 Tab**：描述 / 对话 / 活动 / 日志全部铺开为区块卡片；元信息从平铺 KV 收进右侧栏，主次分明。
- **动作前置**：发布 / 验收 / 打回从「概览 Tab 顶部」提到 Hero 动作区，按状态条件出现。

## 验证证据
见 `round-1.md`、`matrix.csv`。typecheck + build 双过；13 个用例（6 真实 work 形态 + draft/scheduled/qa 临时形态 + 404 + 验收区 + 旧 tab 移除）round-1 全 PASS。复跑脚本：
- `node docs/acceptance/task-detail-redesign/scripts/verify-detail-render.mjs`
- `node docs/acceptance/task-detail-redesign/scripts/verify-detail-states.mjs`（自建自清，无残留）

## 残留 / 建议
- 像素级视觉未截图（无头环境），建议本地 `npm run dev:console` 终检。
- 旁路修复：dev 库缺 migration 014 的 `auto_merge_pr` 列，已 `npm run db:migrate` 对齐到 main 基线（非本特性改动）。
