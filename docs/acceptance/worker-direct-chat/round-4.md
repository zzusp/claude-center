# Round 4 — 对话改名 + 回复中可见性 + Worker 端对话回显

> 在已合入的实时直连对话（P0–P3）之上的三项体验增强。日期：2026-06-14。

## 范围

1. **会话改名**：Web Console 对话标题内联编辑（铅笔 → 输入 → 保存）。
2. **「回复中」可见性**：
   - 会话列表对有在途 assistant 轮（pending/streaming）的会话显示「回复中」标。
   - 消息线在「已发出但 Worker 尚未吐首字」（git fetch / 建只读 worktree 中）期补一个思考气泡（动画三点），让等待全程可见——补上了原本只有首 token 后才有打字机、之前一片空白的盲区。
3. **Worker 端对话回显**：远程对话实际跑在 Worker，桌面端新增（只读）「对话」面板，列本机承接的会话，展开见消息线；流式中的 assistant 从 `conversation_message_chunks` 拼实时增量（轮询 1.5s）。

## 改动点

| 层 | 文件 | 改动 |
|----|------|------|
| DB | `packages/db/src/queries.ts` | 新增 `renameConversation`、`listWorkerConversations`；`listConversations` 加 `generating` 派生（EXISTS pending/streaming assistant） |
| DB | `packages/db/src/types.ts` | `Conversation` 加可选派生字段 `generating` |
| Console API | `apps/console/app/api/conversations/[id]/route.ts` | 新增 `PATCH`（改名，复用 `command.create` + 项目可见性） |
| Console UI | `apps/console/app/ui/chat.tsx` | 标题内联改名；`awaitingReply` 思考气泡；列表 `generating` → 「回复中」标；`Bubble` 支持 `thinking` 态 |
| Console CSS | `apps/console/app/globals.css` | `.chat-tag.live` / `.bubble-dots`(cc-dot) / 标题编辑态 / `.chat-li-tags` |
| Worker | `apps/worker/src/runner.ts` | 新增 `listMyConversations` / `getConversationDetail`（streaming 从 chunks 拼实时增量） |
| Worker | `apps/worker/src/main.ts` + `preload.cjs` | 新 IPC `listMyConversations`/`getConversationDetail`；右栏「对话」卡 + 渲染/轮询 JS + 气泡 CSS |
| Docs | `README.md` / `docs/spec/worker-direct-chat.md` | 同步新 API（PATCH）与三项能力 |

## 验证证据

### 数据层（干净临时库，零污染）

脚本 `scripts/verify-rename-worker-view.mts`：建库 → 全量 17 迁移 → seed(project/workerA/workerB/user) → 断言 → `DROP WITH (FORCE)`。

```
node --import tsx docs/acceptance/worker-direct-chat/scripts/verify-rename-worker-view.mts
```

实跑结果（2026-06-14，全 PASS，库用后已 drop）：

```
✓ created cc_dchat_rwv_<ts>
✓ applied 17 migrations
✓ seeded project / workerA / workerB / user
  PASS  renameConversation → 标题改为「新标题」
  PASS  renameConversation('') → 可清空标题（前端回显「未命名对话」）
  PASS  listConversations: 有 streaming assistant 的会话 generating=true
  PASS  listConversations: 已答完会话 generating=false
  PASS  listWorkerConversations(workerA) → 仅 workerA 的 2 条（不含 workerB）
  PASS  listWorkerConversations(workerA) → 不含 workerB 的 conv3
  PASS  listWorkerConversations: conv1 generating=true
  PASS  listWorkerConversations → last_message_at 均有值
  PASS  listWorkerConversations → join 出 project_name/worker_name
  PASS  listWorkerConversations(workerB) → 仅 conv3
  PASS  getConversationDetail(流式中) → assistant 实时增量拼为「abcdef」
  PASS  getConversationDetail(已答完) → assistant 取最终 body
✓ dropped cc_dchat_rwv_<ts>
ALL PASS
```

> `getConversationDetail` 的实时拼装逻辑（streaming 的 assistant body 尚空 → 从 `getConversationChunks` 拼）由脚本里 `assembleDetail` 镜像断言；runner 方法是同一逻辑的薄封装（`listConversationMessages` + `getConversationChunks`）。

### 构建 / 类型 / 启动

- `npm run typecheck`：db / console / worker 三包全绿。
- `npm run build`：三包构建绿（含 `next build`；`/api/conversations/[id]` 路由含新 PATCH 已编译）。
- `npm run verify:console`（`CONSOLE_PORT=3987`）：`unauthOverviewStatus=401, loginStatus=200, pageStatus=200`，退出码 0。

## 未自动化 / 盲点（MANUAL）

- **UI-04**：Worker 桌面端（Electron data:URL HTML）「对话」面板的实际渲染、以及 Web 端与 Worker 端流式同步可见，需 GUI + 真 claude 手测（headless 驱动不了 Electron 渲染进程）。面板 JS 沿用既有「任务」面板同款字符串拼接 + IPC 模式，TS 侧（runner/IPC/preload）已被 typecheck 覆盖；HTML/JS 字符串本身未被类型检查，列为手测项。
