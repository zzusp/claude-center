# CLAUDE.md — ClaudeCenter

> AI 编码协作中控台：Next.js Web Console（`apps/console`）+ Electron 桌面 Worker（`apps/worker`），共享一个 PostgreSQL（`packages/db`）协同。完整设计见 `docs/spec/claude-center-mvp.md` 与 `README.md`。

## 本地验证（顺序固定）

```powershell
npm run typecheck          # db / console / worker 三包
npm run build              # 三包构建（含 next build）
npm run db:migrate         # 应用迁移到 DATABASE_URL 指向的库
npm run verify:console     # 起 console，断言 401→登录→200，自动关
```

- **build 绿 ≠ dev 绿**：`instrumentation.ts` / edge runtime 的问题只在 dev 暴露（见下「Next.js / webpack 坑」）。改 instrumentation / 中间件 / 服务端入口后，必须 `verify:console` 看到 `401→200` 才算验证过，光 `build` 绿是假信号。
- `verify:console` 默认起在 `3000`；撞端口用 `$env:CONSOLE_PORT="<空闲口>"`。

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

worktree 不继承主检出的 `node_modules` / `.env`（均 gitignore）。一条命令准备：

```powershell
node scripts/setup-worktree.mjs            # 装依赖(暖缓存) + 从主检出复制 .env + 清 .next
node scripts/setup-worktree.mjs --check    # 只看计划
```

- **不要整体 junction / symlink 主检出的 `node_modules`**：本仓是 npm workspaces，`node_modules/@claude-center/{console,db,worker}` 是指回 `apps/`、`packages/` 源码的 junction；整体复用会让 worktree 编译到**主检出的源码**而非本分支改动。用 `npm install --prefer-offline`（暖缓存，约 1 分钟）。
- `next build` 与 dev server 同写 `apps/console/.next` 会在 "Collecting page data" 阶段假报错；build 前用 `npm run clean:next` 或 setup 脚本清。

## UI（`apps/console/app/ui`）

- 展示原子 / 格式化工具（`StatusBadge`、`KvRow`、`fmtDateTime`、`Tone`、`STATUS_META` …）统一放 `shared.tsx`，`dashboard.tsx` 与各视图 `import` 复用，不要各写一份。
