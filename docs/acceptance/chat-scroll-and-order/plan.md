# 实时对话页面：粘底滚动 + 历史报错按时间排序

## 反馈

> 1. 实时对话页面的对话内容，不在回复中也会自动滚动到最下方。
> 2. 「claude-center 发版」展示内容时，历史的报错信息显示串位，是不是没有按时间排。

## 根因

### ① 总是回底
`apps/console/app/ui/chat-thread.tsx:201-203` 旧实现：

```ts
useEffect(() => {
  scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
}, [items, pending, dbExtras]);
```

每 3s 的轮询会 `setDbMessages(all)` 生成新数组引用 → 派生 `dbExtras` 引用变 → 即便内容没改也触发滚动。用户向上翻看历史会被规律性地拽回底部。

### ② 历史报错串位
旧渲染顺序固定：

```jsx
<TranscriptView items={items} />          {/* jsonl 解析的全部消息 */}
{dbExtras.map(...)}                       {/* 失败 assistant + 兜底 user，全部追加在末尾 */}
{pending.map(...)}
```

多轮里只要有失败的 assistant，DB 兜底的报错条统统堆在 jsonl 之后；如果用户在失败后又发新消息、并由 Worker 成功应答，这条历史报错就出现在最新成功回答的「后面」，与实际发生时间倒挂。

## 修复

- `transcript-parse.ts`：`TItem` 增加 `ts: string | null`（来自 jsonl 行的 `timestamp` 字段）。
- `transcript.tsx`：`TranscriptView` 接受可选 `failures: { id; error; ts }[]`，按 ts 与 items 合并成时间序列后再渲染；失败行复用 `.chat-msg-failed` 样式。
- `chat-thread.tsx`：
  - `dbExtras` 拆成 `userExtras`（jsonl 未收录的 user 消息，追加末尾）+ `failureExtras`（失败 assistant，带 `created_at`，传给 `TranscriptView` 让其按时间插）。
  - 粘底滚动：新增 `atBottomRef` + `onScroll` 处理，距离底部 < 64px 才认为「贴底」；切换会话 / 首次加载 / 主动发送时强制回底。

## 验证

- 单测：`docs/acceptance/chat-scroll-and-order/scripts/verify-merge.mjs`（parseTranscript ts 提取 + mergeEntries 合并顺序）。
- e2e：`docs/acceptance/chat-scroll-and-order/scripts/verify-e2e.mjs`（ephemeral 库 + 真 Console + Playwright，渲染 3 轮含失败的对话，断言 6 行 `.tx-row` 顺序 + 滚到顶后等 4.5s 不被拽回）。
- typecheck 全绿。
