# Console + Relay 更新日志

> 跟随 `cc-vX.Y.Z` tag。两个服务（`apps/console` + `apps/relay`）整体发版，避免 SSE 事件契约分裂。
> 格式遵循 [Keep a Changelog](https://keepachangelog.com/) + 语义版本（SemVer）。

新版本节由开发者**手工填写**：CI 在打 `cc-vX.Y.Z` tag 时校验 `## [X.Y.Z]` 节存在且非空，缺则 fail。
抽取脚本：`node scripts/extract-changelog.mjs CHANGELOG-console.md X.Y.Z --check`。

## [Unreleased]

## [0.2.16] - 2026-06-29

### Fixed

- 实时对话页面在未处于回复状态时也会自动滚动到最新消息，避免切回页面或轮询刷新后停在旧位置。

### Changed

- 任务多轮续跑（继续 / 打回重跑）时 PR body、执行结果展示、历史 PR 列表均累计保留每一轮记录，不再只保留最新一轮。

## [0.2.15] - 2026-06-27

### Changed

- 实时对话页重设计：`/chat` 改为项目网格首页（cowork 风格），点项目卡进 `/chat/[projectId]` 项目工作台；左侧会话列表精简为 Claude 网页版风格，每条只展示标题 + 右侧三点菜单（重命名 / 对话设置 / 删除对话）。原 `/chat` 顶部「按项目筛选」下拉去掉（已经按项目锁定）。
- 「结束对话」概念整体下线：`apps/console/app/api/conversations/[id]/close/route.ts` 端点与 `packages/db/src/queries.ts:closeConversation` 删除；`POST /api/conversations/:id/messages` 不再做 `status='active'` 校验；`chat-thread` 头部菜单的「结束对话」替换为「删除对话」（沿用既有 `DELETE /api/conversations/:id` + `useConfirm`）。
- 实时对话左侧项目树加载优化：`GET /api/projects?include=conversations` 一次性取齐所有项目的会话清单（限 1000 条，按 `updated_at DESC`），展开项目树即显、去掉首次展开时的「加载中…」闪烁；`ChatShellClient` 用 `useMemo` 从 projects 载荷里剥离 `conversations` 字段、按 projectId 建索引传给 `ChatView`，下游 `Project` 类型不感知多余字段。

## [0.2.14] - 2026-06-27

### Added

- 已完成任务（success / merged）支持「继续这个任务」：终态任务详情顶栏新增按钮，弹 FormModal 收集补充反馈，PATCH `action='continue'` 原子翻 `claimed` + 落 user 评论 + 触发 `continuation_requested` 事件；Worker 复用原 Claude 会话（`--resume`）再执行一轮——PR 未合则在原 work_branch 上追加 commit、PR 已合则切 `-cont-N` 分支重建 worktree + 新 PR。任务时间线新增 `continuation_requested` / `continuation_started` / `continuation_branch_rotated` 三个事件标签。配套 DB 迁移 `038_task_continuation.sql`（`tasks.continuation_count` + `tasks.continuation_requested_at`，复用现有状态机不重建 check 约束）。
- 实时对话 SessionMetaBar 显示后台进程指示：解析 jsonl 中 `Bash run_in_background:true` 派发与 `attachment.queued_command` 完成回执，主对话有未结束的后台进程时标「后台 N」chip + 悬浮提示——claude 表面停下但实际还在等后台进程时一眼可见。

### Changed

- 实时对话 `chat-composer` 三按钮整改：定时 / 附件 / 发送统一为右下角圆形按钮（34×34），附件 chips 与定时 chip 上移到 textarea 上方的「草稿带」。`AttachmentUploader` 加 `compact` prop（仅渲染 Paperclip 圆形按钮，chips 由父组件接管）、`DateTimePicker` 加 `compact` prop（trigger 改为 CalendarClock 圆形按钮，已选时 `.is-active` 蓝底）。布局重心从左侧迁到右下，整体更紧凑。
- 实时对话详情接口轮询节奏 15s → 3s：原 15s 在 jsonl 尚未收录新 user 消息时窗口被拉长（切回页面 / claude 失败时无气泡可显）；同节奏 3s 避免「pending 清掉了、DB 还没来」的空白窗，worker 套餐用量随之同节奏刷新。

### Fixed

- 实时对话过滤伪 user 气泡：`parseTranscript` 跳过 `isMeta` 与首段为 `<command-name>` / `<local-command-*>` / `<system-reminder>` 的 jsonl user 记录，避免 load skill 时 Claude 内部回灌的 skill 文档全文以「用户消息」形式渲染。桌面端 worker 会话面板与 `extractFinalAssistantText` 同步该过滤。
- 实时对话定时消息走错 session：`findSessionFile` 增加 `sinceMs` 时间窗 + `preferSessionId` 快路径——到点发送时不再被先前其它终端的旧 session jsonl 抢锚；`conversation.claude_session_id` 与本次 claude 启动时间端到端贯穿到同步与收尾。
- 实时对话执行失败时用户消息消失：失败 / jsonl 未收录窗口里 UI 以 DB 全量消息（`refreshMeta` 拉来）兜底渲染用户气泡 + 失败态，切页面回来或 pending 已清后消息不再消失；乐观消息清理改为 jsonl 或 DB 任一收录即清。

## [0.2.13] - 2026-06-24

### Changed

- CI 发布包（release bundle）排除 `docs/`：deploy 的跨境上传（scp tarball 到国内服务器）是头号瓶颈，docs 不参与 docker build / 运行时，从 bundle 整目录排除——git 跟踪的 docs 7.84MB 砍掉，跨境传输量大减（本地实测 tar 从 ~20MB → ~0.5MB）。纯部署流程优化，不影响 console / relay 运行时行为。

## [0.2.12] - 2026-06-24

### Fixed

- console 镜像装 git 改走阿里云 apk 源：cc-v0.2.11 在国内生产服务器 `apk add git` 走 alpine 默认源 `dl-cdn.alpinelinux.org` 跨境拉包 >500s 超时、SSH `Broken pipe` 致 deploy 失败（`docker build` 在 `set -e` 下退出、未执行到 `up`，线上旧版 0.2.10 未受影响）；Dockerfile 先 `sed` 把 apk 源换成 `mirrors.aliyun.com` 再 `apk add git`，本地实测装 git 13.8s、最终镜像 `git 2.54.0` 可用。

## [0.2.11] - 2026-06-24

### Changed

- relay（SSE 中转，可选实时线）退出 `cc-vX.Y.Z` tag 的自动部署：归入 docker compose `relay` profile，主部署（CI + `deploy-on-server.sh`）只 build/up `console`；relay 发布频率低，需要时手动发 `docker compose --profile relay up -d --build relay`。console 不再 `depends_on` relay（避免隐式拉起 profile 服务），relay 不在线时自动回退 DB 轮询、功能不降级；CI 也不再 smoke 编译 relay 包。

### Fixed

- console 容器镜像补装 `git`：服务端拉取远程分支（`git ls-remote`）与任务合并检测（`git merge-base --is-ancestor`）依赖 `git`，但 `node:alpine` 基镜像不含，线上这两条路径会失败；Dockerfile run 阶段 `apk add --no-cache git` 修复（实测最终镜像内 `git 2.54.0` 可用）。

## [0.2.10] - 2026-06-23

### Added

- 支持非 Git 管理的项目：新建项目可选「版本管理」为 git（默认，行为不变）或非 git 本地目录（`vcs='none'`）。非 git 项目不要求填仓库地址，任务 / 对话表单隐藏分支、提交模式与 PR 选项；Worker 直接在项目目录里就地跑 Claude（不建 worktree、不 fetch、不 commit/push/PR），改完即 `success`、无 PR。项目列表对非 git 项目加徽标，任务详情对非 git 任务显示「就地修改」而非空分支行。
- 实时对话支持定时发送消息 + 会话级自动回复：「新建对话」与「对话中」都能设置——「定时发送消息」把消息排定到未来某时刻、由 Console 调度器到点发送（复用任务表单的时间控件）；「自动回复」与任务表单同设计（off/on `Select` + 决策预案 `textarea`），开启后 Worker 执行对话轮时按预案自主决策、不停下来问。
- 编辑任务表单支持填写子项目（子仓）信息：任务详情的编辑表单新增「子仓配置」段（复用新建任务表单的同款组件），项目含子仓时可逐仓启用并配置 base/work/target 分支，保存随任务更新整批替换 `task_repos`；此前仅新建任务表单支持，编辑表单缺这段 UI。

### Changed

- 新建实时对话弹窗加宽 + 双列表单：弹窗宽度 420→560px，短字段（项目+分支、Worker+模型）两两并排、长字段（标题 / 自动回复 / 决策预案 / 首条消息 / 定时发送）整行铺满；窄屏（≤560px）回落单列，兼顾手机端。仅作用于「新建对话」弹窗，对话设置弹窗不受影响。

### Fixed

- 失败任务可带补充信息重新执行：失败任务（执行未产出会话）的任务详情回复框不再显示「任务非在途」被禁用；现在允许发送补充信息触发「带补充的全新执行」，占位文案按是否有会话区分「续接同一会话」/「带补充重新执行」。

## [0.2.9] - 2026-06-22

### Added

- 任务列表新增「Token」用量列：展示每个任务累计消耗的 token 量（紧凑缩写 1.2k / 3.4M，0 或缺失显示「—」）；表头可点击，按 Token 用量或创建时间升/降序排序（默认创建时间降序）。
- 总览页「定时调度器」卡片改为三段子状态：拆成「定时任务检查 / PR 合并检查 / Worker 离线扫描」三行，每行显示状态点 + 周期 + 上次运行时间，异常时下方补一行 lastError；整卡仅让「已启动」段参与健康判定，兼容 dev Fast Refresh 与 prod 滚动升级的过渡态。
- 顶栏铃铛消息中心新增「PR 待人工确认」通知（`task_review_required`）：聚合类型从 9 类扩到 10 类，配 Gavel 图标与 waiting 色，并纳入声音提醒（与任务完成 / 失败 / 等待回复同列）。
- 任务详情时间线新增事件标签：「已认领续接」「PR 不可合并·跳过自动合并」「Test Plan 未全通过·待人工确认」，配合 PR test-plan 合并门控展示真实流转。

### Changed

- 用户新增 / 编辑弹窗的项目多选改为按钮卡片样式（`dep-picker`）：与前置任务选择器一致的勾选标记 + 已选数量提示，替换原 checkbox 列表。
- 新建 / 发布任务表单字段顺序与文案微调：「自动回复（兜底）」上移与「自动合并 PR」同行、「执行模型」下移；自动回复 hint 文案精简。

## [0.2.8] - 2026-06-21

### Added

- 实时对话支持发送附件：消息输入框新增附件上传，可随消息（或仅附件、空文本）一并发送；图片走 vision、其它文件落到只读 worktree 供 Claude 读取。消息与附件绑定在同一事务内原子写入（绑定失败回滚消息，避免出现空消息 + 孤儿附件），乐观气泡即时显示已发文本与附件。
- Web 端任务声音通知：任务完成 / 失败 / 等待回复（`task_success` / `task_failed` / `task_waiting`）出现新通知时，播放一段 Web Audio 现场合成的轻短「叮咚」提示音（不引入二进制音频资源）。过程性通知（worker 上下线 / PR 已建 / 任务被领取等）不响铃；首次拉取只播种已读集合、不为页面加载前的旧通知补响；浏览器无用户手势授权时静默跳过，红点与下拉列表仍为权威。

### Changed

- 右上角通知铃铛优化：有未读时铃铛 icon 周期性摆动（前 0.8s 摆动、其后约 1.2s 静止再循环，不持续抖动扰人），引导用户注意；遵循 `prefers-reduced-motion`，用户开启「减少动态」时不摆动。

### Fixed

- 任务编辑表单的前置任务候选筛选：候选项排除已完成（`success`）/ 已合并（`merged`）任务（这两态已等同完成、加为前置只是干扰），与新建任务表单逻辑一致。
- 新建实时对话表单分支选择：分支输入由 `select` 改为 `input` + `datalist`——远程分支列表拉取失败时仍可手动输入分支名（成功时给出远程分支下拉建议）；拉取失败时回退到项目默认分支作为初值。与发布任务表单的分支输入保持一致。

## [0.2.7] - 2026-06-20

### Changed

- 实时对话页面移动端全面适配：header 收紧内补白并隐藏子信息行、内容区撑满可视区域（100dvh）、重命名/结束等操作收入 `···` 下拉菜单（点外自动关闭）、标题单行省略、消息输入框随内容自动增高（最高 160px）。
- 实时对话消息内容区移动端显示优化：修复内容在不同手机屏幕宽度（360/390/414px）下的布局与排版问题。

## [0.2.6] - 2026-06-20

### Added

- 手机端页面：新增移动端适配，支持在手机浏览器访问中控台。

### Changed

- 手机端 UI 效果调整：优化移动端整体视觉效果与交互体验。
- 手机端 UI 顶部 header 优化：改善移动端顶栏布局与显示。
- 新建任务弹窗恢复原样式：还原任务创建弹窗的默认样式，修正样式回退问题。
- 手机端 UI 显示优化：进一步完善移动端各页面的细节展示。

## [0.2.5] - 2026-06-19

### Fixed

- 任务第二轮成功时 PR 信息未保存到任务：修复 PR 创建/合并结果在第二轮及以后不写入任务记录的问题。

### Changed

- 任务详情时间线 tab 显示优化：改善时间线事件的展示样式与可读性。
- 执行机群 Worker 详情页优化（web 端）：改善 Worker 详情页面的信息展示与交互。
- console 顶栏 brand 区版本号优化为可点击链接：点击跳转 GitHub 版本发布页（发布版直达 `releases/tag/cc-vX.Y.Z` 对应发布说明，本地 dev 退回 `releases` 列表页），带外链图标 + hover 高亮提示可点击。

## [0.2.4] - 2026-06-19

### Added

- 新增可选环境变量 `CLAUDE_CENTER_RELAY_INTERNAL_URL`：console 服务端 publish + `/api/relay/connections` 代理时优先读这个，未配则回退 `CLAUDE_CENTER_RELAY_URL`。典型用法：docker compose 内 console 容器配 `http://relay:8787`（service name DNS 直连 relay 容器），省去出公网回环；浏览器/Worker 仍走 `RELAY_URL` 公网地址。

## [0.2.3] - 2026-06-19

### Internal

- CI release job 改用 `permissions: write-all`：cc-v0.2.1/0.2.2 时 `permissions: contents: write` 在 private repo 上仍 403（同 yaml 在 cc-v0.2.0 时成功），改为 write-all 兜底全 scope。无运行时改动。

## [0.2.2] - 2026-06-19

### Internal

- CI 验证版本：跑一次完整 `deploy-web` 流水线，验证 (a) repo Workflow permissions 改为 write 后 release job 不再 403、(b) build job 新增的 `apps/console/.next/cache` 缓存步骤首次落盘可用。无运行时改动。

## [0.2.1] - 2026-06-19

### Fixed

- 登录 cookie 在 HTTP 部署下被浏览器丢弃导致登录后回不到中控台：`/api/auth/login` 设置 `cc_session` cookie 时 `secure` 标志改为跟随请求实际协议判定（反代时优先看 `x-forwarded-proto`，否则看请求 URL protocol），HTTPS 仍开 Secure、HTTP 直接暴露时放宽。

## [0.2.0] - 2026-06-19

### Added

- 部署流水线：`cc-v*` tag 触发 GitHub Actions，自动 build + SSH 部署到生产服务器，docker compose 起 console/relay。
- console 顶栏 brand 区显示当前版本号（CI build 时注入 `NEXT_PUBLIC_APP_VERSION`）。
- `apps/console/Dockerfile`（Next standalone 多阶段）+ `apps/relay/Dockerfile`（精简 alpine runtime）+ `docker-compose.yml`（host-gateway 走宿主机 pg）。
- `scripts/deploy-on-server.sh` / `server-bootstrap.sh` / `deploy-web-trigger.mjs` / `extract-changelog.mjs`：服务器部署与本地发版自检脚本。
- `CHANGELOG-console.md` / `CHANGELOG-worker.md`：发版硬约束（缺 `## [X.Y.Z]` 节 CI 校验红）。
- 完整方案 `docs/spec/deployment-pipeline.md`。

### Changed

- `apps/console/next.config.mjs` 启用 `output: "standalone"` + `outputFileTracingRoot`，适配 monorepo workspace。
- 部署架构：CI runner 在境外 checkout tag → `tar czf` → scp 到服务器 `/tmp/` → 解压 rsync 覆盖 `/opt/claude-center/`（保留 `.env`）。服务器**不再 git fetch**——国内服务器对 `github.com:443` 普遍不通。

### Fixed

- _（首版部署流水线，无 fix）_

## [0.1.0] - 2026-06-19

### Added

- 初始 MVP：任务调度、Worker 心跳、Claude Code 执行、PR 创建。
- SSE 中转服务（可选），与数据库轮询双线择优。
- 完整说明见 `docs/spec/claude-center-mvp.md`。
