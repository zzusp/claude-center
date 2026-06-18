# 对话历史首屏渲染加速

> 需求来源：用户反馈「打开历史对话渲染速度慢」。讨论过程中考虑过 relay 落本地 jsonl、jsonl 从 DB 迁出、SSE 推增量等架构层改造，**均与「DB 唯一权威 + relay 无状态薄中转」核心约束冲突或代价远超收益**。本方案聚焦前端渲染层 + 缓存层，不动数据架构。

## 1. 现状（瓶颈拆解）

### 1.1 链路与耗时分布

打开 / 切换会话时 `ChatThread`（`apps/console/app/ui/chat-thread.tsx`）走的完整链路：

```
点会话 → useEffect([id]) 清空 jsonl/loaded/pending/worker (chat-thread.tsx:44)
       → usePolling 立即跑首次 (use-polling.ts:62)
       → fetch GET /api/conversations/[id]/session
       → 后端 SELECT jsonl FROM conversation_sessions (queries.ts:2098)
       → res.json() + setJsonl
       → useMemo parseTranscript(jsonl) 同步解析 (chat-thread.tsx:98)
       → TranscriptView 全量挂载（ReactMarkdown × N 块）
       → paint + 滚动到底
```

经验耗时分布（500+ 块的长对话）：

| 段 | 占比 | 说明 |
| --- | --- | --- |
| ① 网络 + 后端 SELECT + 大字符串传输 | ~20% | `conversation_sessions` 1:1 侧表 SELECT 本身快，瓶颈在 jsonl 体积（可达 MB 级） |
| ② res.json() 反序列化 | ~5% | |
| ③ parseTranscript（split + 每行 JSON.parse） | ~10% | 同步 |
| ④ TranscriptView 全量挂载 + ReactMarkdown × N | **~60%** | 同步阻塞主线程，长对话首屏阻塞主因 |
| ⑤ paint + 滚动 | ~5% | |

### 1.2 加重感知卡顿的两个细节

- **切换会话即清空**：`chat-thread.tsx:44-50` 把 `jsonl/loaded/worker` 全置空，用户看到空白等待。
- **3s 周期轮询全量重渲染**：进行中对话每 3s 拉一次完整 jsonl，`res.json()` 每次返回新字符串引用 → `useMemo` 必然重算 → `TranscriptView` 整棵 reconcile 一遍。

### 1.3 不在本方案处理的耗时

- 后端 `SELECT jsonl` 本身：1:1 侧表单行查，约 5–20ms 量级，不是瓶颈。
- relay / SSE 协议：现状仅作"叫醒重拉"信号（`use-polling.ts:75`），不在首屏关键路径上。

## 2. 目标

| 场景 | 现状 | 目标 |
| --- | --- | --- |
| 首次打开 500+ 块长对话 | ~800–1200ms | ~150–250ms |
| 反复切换同一会话 | ~600–1000ms | <50ms |
| 已结束对话再次打开 | 同上 | <50ms（304 短路） |
| 进行中对话 3s 轮询触发的重渲染 | 每次全量 | jsonl 未变即跳过 |

不破坏的约束：

- DB 唯一权威、relay 无状态薄中转、SSE 写路径先落库再 publish（CLAUDE.md / `docs/spec/sse-relay-service.md` 已明定）
- 不动 worker / relay / DB schema / SSE 协议

## 3. 方案与改动清单（三件套）

三件套对应三段瓶颈：① 砍 ④（短文本跳 markdown）② 砍 ④ 剩余（首屏分批挂载）③ 砍 ① + 切换体验（缓存 + 304）。

### 3.1 短文本跳过 ReactMarkdown（前端，纯渲染）

**位置**：`apps/console/app/ui/transcript.tsx:152` 的 `BlockView` 中 `block.kind === "text"` 分支。

**改动**：

```ts
function hasMarkdownFeatures(text: string): boolean {
  // 代码/标题/强调/列表/引用/表格/链接/段落分隔等 markdown 特征
  return /[`#*_~]|\[[^\]]+\]\(|^\s*[->]|^\s*\d+\.\s|\n\n|^\s*\|/m.test(text);
}

// BlockView 中：
if (block.kind === "text") {
  return (
    <div className="tx-text">
      {hasMarkdownFeatures(block.text)
        ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.text}</ReactMarkdown>
        : <span style={{ whiteSpace: "pre-wrap" }}>{block.text}</span>}
    </div>
  );
}
```

**覆盖率预估**：用户消息 ≈100% 走 fast path；助手简短回复 ≈60–70% 走 fast path。整体 60–80% 的 text 块免去 markdown 解析。

**风险**：误判（如内嵌反引号被识别为代码）→ 安全的方向（多走一次 markdown）。无功能性破坏。

### 3.2 首屏分批挂载（前端，React 18 原生）

**位置**：`apps/console/app/ui/transcript.tsx:117` 的 `TranscriptView`。

**改动**：

```tsx
const FIRST_BATCH = 30;

export function TranscriptView({ items }: { items: TItem[] }) {
  const results = /* 既有 tool_use_id → ToolResult 配对 */;
  const [revealed, setRevealed] = useState(() => Math.min(FIRST_BATCH, items.length));

  useEffect(() => {
    if (revealed >= items.length) return;
    const ric = (window as any).requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 16));
    const cic = (window as any).cancelIdleCallback ?? clearTimeout;
    const h = ric(() => setRevealed(items.length));
    return () => cic(h);
  }, [items.length, revealed]);

  // items 已经按时间正序；末尾 revealed 条挂上，前面延后
  const start = Math.max(0, items.length - revealed);
  const visible = items.slice(start);

  return (
    <div className="tx">
      {visible.map((item, i) => {
        const renderable = item.blocks.filter(b => b.kind !== "tool_result");
        if (!renderable.length) return null;
        return <MessageRow key={start + i} role={item.role} blocks={renderable} results={results} />;
      })}
    </div>
  );
}
```

**效果**：首次 paint 时只挂末尾 30 条（视口内 + 一屏缓冲），剩下在浏览器 idle 时一次性挂上。用户感知"秒出"；往上滚有极短挂载延迟，绝大多数场景无感。

**风险**：`requestIdleCallback` 在 Safari < 15.4 / 旧版 Firefox 不支持 → 已 fallback 到 `setTimeout(16)`。无功能性破坏。

### 3.3 会话缓存 + ETag/304（前端 + 后端）

#### 3.3.a 后端：session route 加 ETag

**位置**：`apps/console/app/api/conversations/[id]/session/route.ts:30-31`。

**改动**：

```ts
const session = await getConversationSession(getPool(), id);
if (!session) {
  return NextResponse.json({ jsonl: null, syncedAt: null });
}
// ETag 用 synced_at + jsonl 长度组合：synced_at 单调递增 + length 防同秒不同内容
const etag = `"${new Date(session.synced_at).getTime()}-${session.jsonl.length}"`;
if (request.headers.get("if-none-match") === etag) {
  return new NextResponse(null, { status: 304 });
}
return NextResponse.json(
  { jsonl: session.jsonl, syncedAt: session.synced_at },
  { headers: { ETag: etag } }
);
```

注意：`route.ts:11` 现有签名 `_request: NextRequest` 要改成 `request: NextRequest` 才能拿 header。

#### 3.3.b 前端：内存缓存 + 条件请求 + 引用保持

**位置**：`apps/console/app/ui/chat-thread.tsx:73-90` 的 session 轮询。

**改动**：

```ts
// 模块顶层（不要放 useState，跨 ChatThread 卸载也要保留）
const jsonlCache = new Map<string, { jsonl: string | null; etag: string | null }>();

// 切换会话时（chat-thread.tsx:44 的 useEffect）先从缓存预填，避免空白：
useEffect(() => {
  const cached = jsonlCache.get(id);
  setJsonl(cached?.jsonl ?? null);
  setLoaded(cached !== undefined);    // 有缓存即视作已加载，UI 立即显示
  setPending([]);
  setWorker(null);
  doneRef.current = false;
}, [id]);

// usePolling 轮询回调（chat-thread.tsx:73）：
usePolling(
  async (isActive) => {
    if (doneRef.current) return;
    try {
      const cached = jsonlCache.get(id);
      const r = await fetch(`/api/conversations/${id}/session`, {
        cache: "no-store",
        headers: cached?.etag ? { "If-None-Match": cached.etag } : {}
      });
      if (!isActive()) return;
      if (r.status === 304) {
        if (closed) doneRef.current = true;
        return;                                // 短路：不重置 state、不触发 useMemo
      }
      if (!r.ok) return;
      const etag = r.headers.get("ETag");
      const d = (await r.json()) as { jsonl: string | null };
      if (!isActive()) return;
      // 字符串相等：保留旧引用，setJsonl 不调用 → useMemo(parseTranscript) 命中、TranscriptView 跳过 reconcile
      if (cached && cached.jsonl === d.jsonl) {
        jsonlCache.set(id, { jsonl: cached.jsonl, etag });   // 仅更新 etag
        if (closed) doneRef.current = true;
        return;
      }
      jsonlCache.set(id, { jsonl: d.jsonl, etag });
      setJsonl(d.jsonl);
      setLoaded(true);
      if (closed) doneRef.current = true;
    } catch {
      /* 轮询失败静默，下次重试 */
    }
  },
  [id, closed],
  3000
);
```

**关键点**：

1. `jsonlCache` 是模块级（不是 component state），跨 `ChatThread` 卸载也保留。
2. 切换会话时先 `setJsonl(cached?.jsonl)` 让 UI 立即出内容，再异步刷新（302 / 304 不动 UI）。
3. fetch 拿回字符串和缓存相等时，**不要调 setJsonl**——保留旧引用让 `useMemo([jsonl])` 命中。
4. 内存缓存进程内有效，刷新页面会重建（不引入 sessionStorage，避免大 jsonl 撑爆配额）。
5. 不限制缓存条数（典型一天打开 < 50 个会话，单进程 MB 级可接受）。如未来确实膨胀，再加 LRU。

## 4. 不做的（明确边界）

| 方向 | 不做理由 |
| --- | --- |
| relay 落本地 jsonl 副本 | 破坏 DB 唯一权威，引入双副本一致性问题 |
| jsonl 从 DB 挪到 relay 文件系统 | 把 relay 升格为数据库，违反"无状态薄中转"，失去 PG 事务/外键/CASCADE/备份 |
| SSE 推增量 + 前端 append（消除 jsonl 全量轮询） | 需要 worker 端推 jsonl 行增量、改 relay event schema、前端 buffer/seq 对齐——独立改造，留待下一阶段 |
| "先订阅后拉 + buffer + seq 去重"对齐快照-流窗口 | 同上，需要业务 seq + 客户端状态机；当前 3s 轮询天然兜底，丢窗口实际影响 ≤ 3s |
| 虚拟列表（react-virtuoso 等） | markdown 块高度不定，dynamic size 维护成本高；等 ①+② 落地量化效果后再决定 |
| messages 表分页（末尾 N 条 + 上滑加载更早） | 动数据形态，要解决 jsonl 行粒度 vs message 行粒度的对齐；留作下一阶段 |
| 服务端预渲染 transcript HTML（RSC） | 改动面大、与流式态冲突；非首选 |

## 5. 落地节奏（三个独立 commit）

每 commit 独立可验证、可 ship、可回滚。

1. **commit 1**：`transcript.tsx` 渲染优化（§3.1 + §3.2 合并提交）。纯前端、无 schema 变化、无后端依赖。
2. **commit 2**：`session/route.ts` ETag 返回 + 前端 `If-None-Match`（§3.3.a + §3.3.b 中条件请求与短路部分）。后端 1 处 + 前端 1 处。
3. **commit 3**：前端 `jsonlCache` Map 与切换瞬时显示（§3.3.b 中 cache 与 useEffect 预填部分）。纯前端。

commit 2 与 commit 3 顺序可换；commit 1 独立。

## 6. 验证（先论后证）

### 6.1 自动验证

```powershell
npm run typecheck                 # 五包 typecheck
npm run build                     # 五包构建（含 next build）
npm run verify:console            # 起 console，401→200 + scheduler.ok 不破坏
```

### 6.2 手动量化（每个 commit 落地后跑）

- **Chrome DevTools Performance**：
  - 录制首次打开 500+ 块长对话
  - 看 Main thread 中 Long Tasks（>50ms）的总时长：commit 1 后 < 200ms
  - 看 `Scripting` 阶段耗时：commit 1 应较基线下降 50%+
- **Network 面板**：
  - 反复切换同一会话 10 次
  - `/session` 接口的 `304` 比例：commit 2 后应 > 80%
  - 第二次起切换：Network 几乎无下载量（仅 ~0 KB 304 响应头）
- **掐表**：典型 50 条 / 500 条对话各打开 5 次，记录"点会话 → 首屏内容可见"的时间，对照 §2 目标。

### 6.3 回归

- 已结束对话：拉一次后不再轮询（`doneRef.current = true` 行为不变）
- 进行中对话：jsonl 更新时 ETag 变 → 200 + 新内容、UI 正常增量
- 切换会话：缓存命中时立即出内容，期间后台 304 / 200 不影响 UI
- 多用户 / 多 tab：jsonlCache 是 tab 内进程级、不持久化，无跨 tab 一致性问题

## 7. 后续可选方向（不在本方案）

落地并量化后，如仍不达预期，再按以下顺序评估：

1. **SSE 真正承担实时数据线**：worker 推 jsonl 行增量、relay event schema 扩展、前端"先订阅后拉 + buffer + seq 去重"对齐。彻底消除轮询 + 丢消息窗口。
2. **messages 表分页**：首屏只拉末尾 N 条，上滑加载历史。彻底常数化首屏负载。
3. **虚拟列表**：1000+ 块超长对话场景。
4. **服务端预渲染 transcript HTML**：把 markdown 渲染 + JSX diff 搬到 server side cache。

这些是大改、需要单独 spec 评估，不在本方案的"低风险高 ROI"范围内。
