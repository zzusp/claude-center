# CLAUDE.md — ClaudeCenter

> AI 编码协作中控台：Next.js Web Console（`apps/console`）+ Electron 桌面 Worker（`apps/worker`），共享一个 PostgreSQL（`packages/db`）协同；可选叠加 SSE 中转服务（`apps/relay`）作低延迟实时线（`packages/relay-client` 为共享客户端）。完整设计见 `docs/spec/claude-center-mvp.md`、`docs/spec/sse-relay-service.md` 与 `README.md`。

## 本地验证（顺序固定）

```powershell
npm run typecheck          # db / relay-client / console / worker / relay 五包
npm run build              # 五包构建（含 next build）
npm run db:migrate         # 应用迁移到 DATABASE_URL 指向的库
npm run verify:console     # 起 console，断言 401→登录→200，自动关
npm -w @claude-center/relay run selftest   # relay 自验证：投递/保活/Last-Event-ID/鉴权/ticket/healthz
```

- **build 绿 ≠ dev 绿**：`instrumentation.ts` / edge runtime 的问题只在 dev 暴露（见下「Next.js / webpack 坑」）。改 instrumentation / 中间件 / 服务端入口后，必须 `verify:console` 看到 `401→200` 才算验证过，光 `build` 绿是假信号。
- `verify:console` 默认起在 `3000`；撞端口用 `$env:CONSOLE_PORT="<空闲口>"`。

## SSE 中转服务（`apps/relay`，可选实时线）

- 在「DB 唯一权威 + 双向轮询」之上叠加一条低延迟 SSE 线：可用时优先走中转（亚秒级），不可用时退回数据库轮询（功能不降级）。完整方案见 `docs/spec/sse-relay-service.md`。
- **默认禁用**：`CLAUDE_CENTER_RELAY_URL` 为空时 Console/Worker 都不连中转、纯轮询（与改动前行为一致）。配齐 `CLAUDE_CENTER_RELAY_*`（见 `.env.example`）后启用。
- 起服务：`npm run dev:relay`（或 `node apps/relay/dist/main.js`）；`node apps/relay/dist/main.js --check` 是零副作用自检（只打印脱敏配置、不监听）。
- **写路径硬约束**：所有消息/状态**先落库再 publish**（best-effort，失败不阻塞、靠轮询兜底）。改了发布点要确保在落库成功之后调用 `publishRelay` / `relay.publish`。
- **不要把 `relay-publish` / `relay-client` 引进 `instrumentation.ts` 或 edge**：它们用 `node:` 内置（http/crypto），只在 nodejs runtime 的 route handler 里 import（与 `pg` 同理）。
- Phase 2（TODO）：DB 轮询双线择优（relay 健康时慢化轮询、断时恢复）、reconnect→DB 对账、多 relay 实例广播背板——本期未做，现有轮询天然作隐式兜底。

## 数据库

- `.env` 的 `DATABASE_URL` 指向**远程共享 dev 库**（多分支 / 多 worktree 共用）。`.env` 不入库、只在主检出。
- **别拿共享库验证迁移 / 鉴权**：共享库的 `schema_migrations` 常停在某兄弟分支状态、缺列会 500。用一次性干净库（脚本零污染：建库→跑全量迁移→`DROP ... WITH (FORCE)`）：

  ```powershell
  npm run db:ephemeral                     # 建临时库 → 跑全量迁移 → DROP
  node scripts/ephemeral-db.mjs --verify   # 顺带对临时库跑 verify:console
  node scripts/ephemeral-db.mjs --check    # 只打印计划，不连库（零副作用自检）
  ```

  > 带 flag 时直接 `node scripts/...`：PowerShell 会把 `npm run ... -- --flag` 里的 `--` 当作自己的「参数结束」标记吃掉，flag 传不进脚本（结果会按默认全流程跑真库，所幸临时库零污染）。

## 迁移（`packages/db/migrations`，`00N_*.sql`）

- 迁移按**文件名排序**、整体在一个事务里应用。新增取**未被占用的下一个编号**：先 `git fetch`，看 `origin/main` 与各 `worktree-*` 已占用的号，避免撞号被后跑者覆盖。
- 每次重建 `tasks_status_check` 等约束都要**列当前全部合法状态（全集）**，否则会废掉并行分支加的状态。
- 改名迁移文件后，删 `schema_migrations` 里的孤儿记录（`DELETE ... WHERE id='旧文件名'`）。

## Next.js / webpack 坑（`apps/console`）

`instrumentation.ts` 会被 Next 为 **nodejs + edge 两个 runtime** 分别编译。在它（或其**静态依赖**）里引 `pg` 或 `node:` scheme 内置模块，edge 编译会炸 → **dev/build 全站 500**（普通 route handler import 不受影响）：

- 引 `@claude-center/db`(经 pg 触发 `Can't resolve 'fs'`)：在 nodejs guard 内 `await import(/* webpackIgnore: true */ "@claude-center/db")`（db 有 dist 产物，运行时由 Node 从 node_modules 解析）。
- 引**本地 TS 模块**（无构建产物，**不能**用 webpackIgnore，相对路径运行时解析不到）：在 `next.config.mjs` 的 webpack 钩子里**仅对 `nextRuntime === "edge"`** 把 `node:` 前缀模块标 external（本应用无 edge runtime、受 nodejs guard 保护永不执行，只为让编译过）。

## worktree 验证准备

worktree 是全新检出，不带主检出的 `node_modules` / `.env`（均 gitignore）。

**`.env` 等 gitignore 配置**：Claude Code 建 worktree 时（`claude --worktree` / `EnterWorktree` / 子代理 / 桌面端）会按项目根 **`.worktreeinclude`**（.gitignore 语法）自动把「匹配且被忽略」的文件拷进去——本仓已配 `.env` / `.env.local`，无需手动复制。**例外**：手动 `git worktree add` 不走 `.worktreeinclude`，用下面的 setup 脚本补。

**依赖 + 构建缓存**（Claude Code 无原生自动装依赖，仍要自己来）：

```powershell
node scripts/setup-worktree.mjs            # 装依赖(暖缓存) + 复制 .env(仅手动建树时) + 清 .next
node scripts/setup-worktree.mjs --check    # 只看计划
```

- **不要整体 junction / symlink 主检出的 `node_modules`，也不要把 `node_modules` 写进 `.worktreeinclude`**：本仓是 npm workspaces，`node_modules/@claude-center/{console,db,worker}` 是指回 `apps/`、`packages/` 源码的 junction；整体复用会让 worktree 编译到**主检出的源码**而非本分支改动。用 `npm install --prefer-offline`（暖缓存，约 1 分钟）。
- `next build` 与 dev server 同写 `apps/console/.next` 会在 "Collecting page data" 阶段假报错；build 前用 `npm run clean:next` 或 setup 脚本清。
- worktree 基线默认 `origin/HEAD`（远程默认分支最新），与「起点要新」一致；如需基于本地未推送改动建树，在 `.claude/settings.json` 设 `worktree.baseRef: "head"`（仅 `"fresh"` / `"head"`）。

## UI（`apps/console/app/ui`）

- 展示原子 / 格式化工具（`StatusBadge`、`KvRow`、`fmtDateTime`、`Tone`、`STATUS_META` …）统一放 `shared.tsx`，`dashboard.tsx` 与各视图 `import` 复用，不要各写一份。
