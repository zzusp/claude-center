# Console + Relay 更新日志

> 跟随 `cc-vX.Y.Z` tag。两个服务（`apps/console` + `apps/relay`）整体发版，避免 SSE 事件契约分裂。
> 格式遵循 [Keep a Changelog](https://keepachangelog.com/) + 语义版本（SemVer）。

新版本节由开发者**手工填写**：CI 在打 `cc-vX.Y.Z` tag 时校验 `## [X.Y.Z]` 节存在且非空，缺则 fail。
抽取脚本：`node scripts/extract-changelog.mjs CHANGELOG-console.md X.Y.Z --check`。

## [Unreleased]

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
