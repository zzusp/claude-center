-- 026_table_column_comments.sql
-- 给所有现有表和字段补 PG COMMENT。纯元数据补全，无 schema 变化。
-- COMMENT ON 是覆盖语义、天然 idempotent，不需要 IF NOT EXISTS。
-- 后续新增表/字段同样要带 COMMENT ON（CLAUDE.md 「迁移」章节硬规范）。

-- ============================================================================
-- schema_migrations（001）
-- ============================================================================
COMMENT ON TABLE  schema_migrations            IS '迁移登记表：每应用一个 migrations/*.sql 文件写入一行。';
COMMENT ON COLUMN schema_migrations.id         IS '迁移文件名（不含扩展名，如 026_table_column_comments）。';
COMMENT ON COLUMN schema_migrations.applied_at IS '应用时间。';

-- ============================================================================
-- projects（001）
-- ============================================================================
COMMENT ON TABLE  projects                IS '项目：一个仓库组（主仓 + 可选子仓），任务/对话/Worker 绑定都基于它。';
COMMENT ON COLUMN projects.id             IS '项目 ID。';
COMMENT ON COLUMN projects.name           IS '项目展示名（唯一）。';
COMMENT ON COLUMN projects.repo_url       IS '主仓 Git URL；023 后多仓权威在 project_repos.role=''main'' 行，此列保留为旧路径镜像。';
COMMENT ON COLUMN projects.default_branch IS '主仓默认分支（与 project_repos 主仓行同步）。';
COMMENT ON COLUMN projects.description    IS '项目描述。';
COMMENT ON COLUMN projects.archived_at    IS '归档时间；非 NULL 表示项目已归档。';
COMMENT ON COLUMN projects.created_at     IS '创建时间。';
COMMENT ON COLUMN projects.updated_at     IS '最近更新时间。';

-- ============================================================================
-- workers（001 + 012 + 020）
-- ============================================================================
COMMENT ON TABLE  workers                       IS 'Worker 节点（Electron 桌面端实例）：执行任务 / 直连对话 / 直连命令的真身。';
COMMENT ON COLUMN workers.id                    IS 'Worker ID（由桌面端生成，注册时上送）。';
COMMENT ON COLUMN workers.name                  IS 'Worker 自称名（默认主机名）。';
COMMENT ON COLUMN workers.host_name             IS '所在主机名。';
COMMENT ON COLUMN workers.app_version           IS 'Worker 应用版本号。';
COMMENT ON COLUMN workers.status                IS '在线状态：online / offline，由心跳决定。';
COMMENT ON COLUMN workers.capabilities          IS 'Worker 能力声明（JSON）：可用模型 / 工具 / 路径白名单等。';
COMMENT ON COLUMN workers.metadata              IS '附加元数据（JSON）：OS / CPU / 内存等。';
COMMENT ON COLUMN workers.last_seen_at          IS '最近一次心跳时间。';
COMMENT ON COLUMN workers.created_at            IS '首次注册时间。';
COMMENT ON COLUMN workers.updated_at            IS '最近更新时间。';
COMMENT ON COLUMN workers.claude_version        IS 'Worker 机器上 `claude --version` 解析出的版本号。';
COMMENT ON COLUMN workers.subscription_type     IS '订阅类型：max/pro/team/enterprise(套餐) / api(按量) / unknown。';
COMMENT ON COLUMN workers.usage                 IS '套餐用量快照（JSON）：{five_hour:{utilization,resets_at}, seven_day:{utilization,resets_at}, fetched_at}。';
COMMENT ON COLUMN workers.working_state         IS '工作意愿：idle 不领新任务 / working 可领新任务。新 worker 默认 idle。';
COMMENT ON COLUMN workers.allow_remote_control  IS '是否允许 web 端远程切换 working_state（客户端策略）。';
COMMENT ON COLUMN workers.max_parallel          IS '同时执行任务的上限（真并发，工作树用 git worktree 隔离）。';
COMMENT ON COLUMN workers.terminal_command      IS '终端启动命令（桌面端设置，入库供 web 展示）。';
COMMENT ON COLUMN workers.claude_pre_command    IS 'Claude 启动前置命令（如 source ~/.bashrc）。';
COMMENT ON COLUMN workers.label                 IS '人类可读显示名（web 端设置）；NULL 时 UI 显示 name，重注册不覆盖。';

-- ============================================================================
-- worker_project_links（001）
-- ============================================================================
COMMENT ON TABLE  worker_project_links               IS 'Worker ↔ Project 本地绑定：声明 worker 可在哪些项目上工作以及本地路径。';
COMMENT ON COLUMN worker_project_links.id            IS '绑定 ID。';
COMMENT ON COLUMN worker_project_links.worker_id     IS '所属 Worker。';
COMMENT ON COLUMN worker_project_links.project_id    IS '所属项目。';
COMMENT ON COLUMN worker_project_links.local_path    IS 'Worker 主机上项目的本地绝对路径。';
COMMENT ON COLUMN worker_project_links.repo_identity IS '仓库身份指纹（同源识别，避免错绑）。';
COMMENT ON COLUMN worker_project_links.enabled       IS '是否启用：禁用后此 worker 不接该项目的任务。';
COMMENT ON COLUMN worker_project_links.created_at    IS '创建时间。';
COMMENT ON COLUMN worker_project_links.updated_at    IS '最近更新时间。';

-- ============================================================================
-- tasks（001 + 多次扩展；已删除字段 priority/target_files/task_type 不在此列）
-- ============================================================================
COMMENT ON TABLE  tasks                          IS '工作任务主表：draft/scheduled → pending → claimed → running → success/failed/cancelled 工作流。';
COMMENT ON COLUMN tasks.id                       IS '任务 ID。';
COMMENT ON COLUMN tasks.project_id               IS '所属项目。';
COMMENT ON COLUMN tasks.title                    IS '任务标题。';
COMMENT ON COLUMN tasks.description              IS '任务描述（给 Claude 的 prompt）。';
COMMENT ON COLUMN tasks.base_branch              IS '签出分支（工作起点）；多仓任务以 task_repos 单仓维度为准。';
COMMENT ON COLUMN tasks.work_branch              IS '工作分支名（Worker 在其上 commit）；多仓任务以 task_repos 为准。';
COMMENT ON COLUMN tasks.status                   IS '任务状态：draft/scheduled/pending/claimed/running/waiting/success/merged/accepted/rejected/failed/cancelled。';
COMMENT ON COLUMN tasks.claimed_by               IS '认领该任务的 Worker；释放后置 NULL。';
COMMENT ON COLUMN tasks.claimed_at               IS '认领时间。';
COMMENT ON COLUMN tasks.started_at               IS '开始执行时间。';
COMMENT ON COLUMN tasks.finished_at              IS '完成/失败/取消时间。';
COMMENT ON COLUMN tasks.error_message            IS '失败时的错误说明。';
COMMENT ON COLUMN tasks.result                   IS '执行结果摘要（JSON）：commit/PR/diff 概览等。';
COMMENT ON COLUMN tasks.pr_url                   IS '建出的 PR 链接（PR 模式）；多仓任务以 task_repos 为准。';
COMMENT ON COLUMN tasks.created_at               IS '创建时间。';
COMMENT ON COLUMN tasks.updated_at               IS '最近更新时间。';
COMMENT ON COLUMN tasks.claude_session_id        IS 'Claude Code session id：用于 `claude --resume` 续接同一会话。';
COMMENT ON COLUMN tasks.target_branch            IS 'PR base 分支（PR 模式）/ push 目标分支（push 模式）；多仓任务以 task_repos 为准。';
COMMENT ON COLUMN tasks.submit_mode              IS '提交模式：pr 推送工作分支并开 PR / push 直接 commit+push 到目标分支。';
COMMENT ON COLUMN tasks.merge_checked_at         IS 'Worker 侧 PR 合并状态轮询游标（NULL 优先）；与 merge_status_checked_at 互不干扰。';
COMMENT ON COLUMN tasks.scheduled_at             IS '定时发布时间：与 status=''scheduled'' 配套，调度器到点翻 pending。';
COMMENT ON COLUMN tasks.merge_status             IS '合并状态：unknown 未检查 / unmerged 未合 / merged 已合并。';
COMMENT ON COLUMN tasks.merge_status_checked_at  IS 'Console 侧合并检查游标（NULL 优先）；独立于 Worker 的 merge_checked_at。';
COMMENT ON COLUMN tasks.model                    IS '执行模型别名：default(不传)/opus/sonnet/haiku；映射为 `claude --model <alias>`。';
COMMENT ON COLUMN tasks.auto_merge_pr            IS '是否自动合并 PR：开启后 Worker 创建 PR 后调用 `gh pr merge`。';
COMMENT ON COLUMN tasks.cancel_requested_at      IS '取消请求时间戳：Console 打戳，Worker 周期扫描后翻 cancelled。';
COMMENT ON COLUMN tasks.auto_reply               IS '是否自动回复：哨兵命中且有改动时由 Worker 注入决策预案续跑。';
COMMENT ON COLUMN tasks.auto_decision_hints      IS '自动回复时注入的决策偏好（用户预先编码）。';
COMMENT ON COLUMN tasks.retry_requested_at       IS '续接重试请求时间戳：用户点重试触发，Worker 据此从 failed/cancelled 翻回 running。';

-- ============================================================================
-- task_events（001）
-- ============================================================================
COMMENT ON TABLE  task_events            IS '任务执行事件流：Worker 上报的进度/日志/状态变更，按时间顺序展示。';
COMMENT ON COLUMN task_events.id         IS '事件 ID。';
COMMENT ON COLUMN task_events.task_id    IS '所属任务。';
COMMENT ON COLUMN task_events.worker_id  IS '产生该事件的 Worker（可能为空：系统事件）。';
COMMENT ON COLUMN task_events.event_type IS '事件类型：progress/log/error/status_change/...';
COMMENT ON COLUMN task_events.message    IS '事件消息（人类可读）。';
COMMENT ON COLUMN task_events.payload    IS '附加结构化数据（JSON）。';
COMMENT ON COLUMN task_events.created_at IS '产生时间。';

-- ============================================================================
-- direct_commands（001）
-- ============================================================================
COMMENT ON TABLE  direct_commands               IS 'Worker 直连命令：绕过任务流，对指定 Worker 下发一次性 shell 或 Claude prompt 指令。';
COMMENT ON COLUMN direct_commands.id            IS '命令 ID。';
COMMENT ON COLUMN direct_commands.worker_id     IS '目标 Worker。';
COMMENT ON COLUMN direct_commands.command       IS '命令类型：shell 系统命令 / claude_prompt Claude 提示词。';
COMMENT ON COLUMN direct_commands.payload       IS '命令参数（JSON）：shell 携带 cmd/args/cwd，claude_prompt 携带 prompt/cwd/model。';
COMMENT ON COLUMN direct_commands.status        IS '执行状态：pending/claimed/running/success/failed/cancelled。';
COMMENT ON COLUMN direct_commands.claimed_at    IS '认领时间。';
COMMENT ON COLUMN direct_commands.started_at    IS '开始执行时间。';
COMMENT ON COLUMN direct_commands.finished_at   IS '结束时间。';
COMMENT ON COLUMN direct_commands.error_message IS '失败原因。';
COMMENT ON COLUMN direct_commands.result        IS '执行结果（JSON）：stdout/stderr/exit_code 等。';
COMMENT ON COLUMN direct_commands.created_at    IS '创建时间。';
COMMENT ON COLUMN direct_commands.updated_at    IS '最近更新时间。';

-- ============================================================================
-- task_comments（002）
-- ============================================================================
COMMENT ON TABLE  task_comments            IS '任务评论流：Worker 提问 + 用户回复，配合 status=waiting 实现执行中途确认。';
COMMENT ON COLUMN task_comments.id         IS '评论 ID。';
COMMENT ON COLUMN task_comments.task_id    IS '所属任务。';
COMMENT ON COLUMN task_comments.author     IS '作者：worker（Worker 提问）/ user（用户回复）。';
COMMENT ON COLUMN task_comments.worker_id  IS '作者为 worker 时的具体 Worker；user 时为 NULL。';
COMMENT ON COLUMN task_comments.body       IS '评论正文。';
COMMENT ON COLUMN task_comments.created_at IS '产生时间。';

-- ============================================================================
-- task_dependencies（007）
-- ============================================================================
COMMENT ON TABLE  task_dependencies                    IS '任务前置依赖（同项目内多对多）：depends_on_task 未完成时被依赖任务不可领。';
COMMENT ON COLUMN task_dependencies.task_id            IS '依赖方（被门控的任务）。';
COMMENT ON COLUMN task_dependencies.depends_on_task_id IS '前置任务（需先完成）。';
COMMENT ON COLUMN task_dependencies.created_at         IS '关系建立时间。';

-- ============================================================================
-- users（008）
-- ============================================================================
COMMENT ON TABLE  users               IS '登录用户：用户名 + bcrypt 散列密码 + 固定四角色 RBAC。';
COMMENT ON COLUMN users.id            IS '用户 ID。';
COMMENT ON COLUMN users.username      IS '登录用户名（唯一）。';
COMMENT ON COLUMN users.password_hash IS 'bcrypt 散列（pgcrypto crypt(_, gen_salt(''bf''))）。';
COMMENT ON COLUMN users.role          IS '角色：admin 全权 / publisher 发布 / commenter 评论 / viewer 只读。';
COMMENT ON COLUMN users.display_name  IS '显示名（前端展示）。';
COMMENT ON COLUMN users.disabled      IS '是否禁用（禁用后无法登录）。';
COMMENT ON COLUMN users.last_login_at IS '最近一次登录时间。';
COMMENT ON COLUMN users.created_at    IS '创建时间。';
COMMENT ON COLUMN users.updated_at    IS '最近更新时间。';

-- ============================================================================
-- user_project_links（008）
-- ============================================================================
COMMENT ON TABLE  user_project_links            IS '用户 ↔ 项目分配：非 admin 用户只能看到/操作此处关联的项目。';
COMMENT ON COLUMN user_project_links.user_id    IS '用户 ID。';
COMMENT ON COLUMN user_project_links.project_id IS '项目 ID。';
COMMENT ON COLUMN user_project_links.created_at IS '关系建立时间。';

-- ============================================================================
-- sessions（008）
-- ============================================================================
COMMENT ON TABLE  sessions            IS '登录会话：cookie 携带 token，过期或登出后失效。';
COMMENT ON COLUMN sessions.token      IS '会话 token（pgcrypto 32B 随机 hex）。';
COMMENT ON COLUMN sessions.user_id    IS '会话归属用户。';
COMMENT ON COLUMN sessions.created_at IS '会话创建时间。';
COMMENT ON COLUMN sessions.expires_at IS '过期时间。';

-- ============================================================================
-- conversations（017）
-- ============================================================================
COMMENT ON TABLE  conversations                   IS '实时直连对话：与某 Worker 在某项目某分支只读检出上多轮问答，独立于任务流。';
COMMENT ON COLUMN conversations.id                IS '对话 ID。';
COMMENT ON COLUMN conversations.project_id        IS '对话所针对的项目。';
COMMENT ON COLUMN conversations.worker_id         IS '定向的 Worker（实时直连，必须在线）。';
COMMENT ON COLUMN conversations.branch            IS '只读检出的分支名。';
COMMENT ON COLUMN conversations.title             IS '对话标题（前端可重命名）。';
COMMENT ON COLUMN conversations.model             IS '执行模型别名（语义同 tasks.model）。';
COMMENT ON COLUMN conversations.status            IS '对话状态：active 进行中 / closed 已结束。';
COMMENT ON COLUMN conversations.claude_session_id IS 'Claude Code session id：续接 `claude --resume`。';
COMMENT ON COLUMN conversations.created_by        IS '创建者用户 ID。';
COMMENT ON COLUMN conversations.created_at        IS '创建时间。';
COMMENT ON COLUMN conversations.updated_at        IS '最近更新时间。';

-- ============================================================================
-- conversation_messages（017 + 025）
-- ============================================================================
COMMENT ON TABLE  conversation_messages                     IS '对话消息：user 提问 / assistant 回答，会话内按 seq 单调递增。';
COMMENT ON COLUMN conversation_messages.id                  IS '消息 ID。';
COMMENT ON COLUMN conversation_messages.conversation_id     IS '所属对话。';
COMMENT ON COLUMN conversation_messages.seq                 IS '会话内单调递增序号，用于排序 + 派发判定。';
COMMENT ON COLUMN conversation_messages.role                IS '消息角色：user 提问 / assistant 回答。';
COMMENT ON COLUMN conversation_messages.body                IS '消息全文（user 恒填；assistant 收尾落最终全文）。';
COMMENT ON COLUMN conversation_messages.status              IS '消息状态：pending/streaming/done/failed/cancelled（user 恒 done）。';
COMMENT ON COLUMN conversation_messages.claimed_by          IS '认领回答的 Worker；user 消息恒 NULL。';
COMMENT ON COLUMN conversation_messages.error_message       IS '失败时的错误说明。';
COMMENT ON COLUMN conversation_messages.created_at          IS '创建时间。';
COMMENT ON COLUMN conversation_messages.updated_at          IS '最近更新时间。';
COMMENT ON COLUMN conversation_messages.cancel_requested_at IS '取消请求时间戳：Console 打戳，Worker 杀进程后翻 cancelled。';

-- ============================================================================
-- task_sessions（018）
-- ============================================================================
COMMENT ON TABLE  task_sessions           IS '任务 Claude session transcript（.jsonl 全文）侧表：与 tasks 1:1，隔离大字段。';
COMMENT ON COLUMN task_sessions.task_id   IS '所属任务 ID。';
COMMENT ON COLUMN task_sessions.jsonl     IS 'Claude Code session .jsonl 全文（NDJSON）。';
COMMENT ON COLUMN task_sessions.synced_at IS '最近一次同步时间。';

-- ============================================================================
-- conversation_sessions（019）
-- ============================================================================
COMMENT ON TABLE  conversation_sessions                 IS '对话 Claude session transcript（.jsonl 全文）侧表：与 conversations 1:1。';
COMMENT ON COLUMN conversation_sessions.conversation_id IS '所属对话 ID。';
COMMENT ON COLUMN conversation_sessions.jsonl           IS 'Claude Code session .jsonl 全文（NDJSON）。';
COMMENT ON COLUMN conversation_sessions.synced_at       IS '最近一次同步时间。';

-- ============================================================================
-- project_repos（023）
-- ============================================================================
COMMENT ON TABLE  project_repos                IS '项目仓清单：每项目 1 行主仓（role=main，relative_path=''.''）+ N 行子仓（role=sub）。';
COMMENT ON COLUMN project_repos.id             IS '仓行 ID。';
COMMENT ON COLUMN project_repos.project_id     IS '所属项目。';
COMMENT ON COLUMN project_repos.role           IS '仓角色：main 主仓 / sub 子仓。';
COMMENT ON COLUMN project_repos.relative_path  IS '相对主仓的 POSIX 路径；主仓恒 ''.''；子仓如 ''packages/widgets-lib''。';
COMMENT ON COLUMN project_repos.repo_url       IS '该仓的 Git URL。';
COMMENT ON COLUMN project_repos.default_branch IS '该仓默认分支。';
COMMENT ON COLUMN project_repos.display_name   IS '展示名。';
COMMENT ON COLUMN project_repos.position       IS 'UI 排序权重（升序）。';
COMMENT ON COLUMN project_repos.created_at     IS '创建时间。';
COMMENT ON COLUMN project_repos.updated_at     IS '最近更新时间。';

-- ============================================================================
-- task_repos（023）
-- ============================================================================
COMMENT ON TABLE  task_repos                  IS '任务级单仓快照：每仓的分支与子状态（多仓任务循环 finalize 时的执行单元）。';
COMMENT ON COLUMN task_repos.id               IS '任务仓快照 ID。';
COMMENT ON COLUMN task_repos.task_id          IS '所属任务。';
COMMENT ON COLUMN task_repos.project_repo_id  IS '对应的 project_repos 行（任务创建时按全集生成）。';
COMMENT ON COLUMN task_repos.role             IS '仓角色：main / sub（与 project_repos.role 同步）。';
COMMENT ON COLUMN task_repos.relative_path    IS '相对主仓的 POSIX 路径（与 project_repos.relative_path 同步）。';
COMMENT ON COLUMN task_repos.base_branch      IS '本仓签出分支。';
COMMENT ON COLUMN task_repos.work_branch      IS '本仓工作分支。';
COMMENT ON COLUMN task_repos.target_branch    IS '本仓 PR base / push 目标分支。';
COMMENT ON COLUMN task_repos.sub_status       IS '单仓子态：pending/no_changes/committed/pushed/pr_created/pr_merged/skipped/failed（强语义聚合见 spec）。';
COMMENT ON COLUMN task_repos.pr_url           IS '本仓建出的 PR 链接。';
COMMENT ON COLUMN task_repos.error_message    IS '本仓失败原因。';
COMMENT ON COLUMN task_repos.last_sync_at     IS '末次执行 / 状态翻转时间。';
COMMENT ON COLUMN task_repos.created_at       IS '创建时间。';
COMMENT ON COLUMN task_repos.updated_at       IS '最近更新时间。';

-- ============================================================================
-- attachments（024）
-- ============================================================================
COMMENT ON TABLE  attachments                 IS '任务/评论附件元数据（图片+文件）；与 attachment_blobs 1:1 分表避免 SELECT * 误拖大对象。';
COMMENT ON COLUMN attachments.id              IS '附件 ID。';
COMMENT ON COLUMN attachments.task_id         IS '归属任务（与 task_comment_id 二选一；都 NULL 表示未绑定上传）。';
COMMENT ON COLUMN attachments.task_comment_id IS '归属评论（与 task_id 二选一）。';
COMMENT ON COLUMN attachments.owner_user_id   IS '上传者（用于未绑定时的孤儿清理）。';
COMMENT ON COLUMN attachments.kind            IS '附件大类：image / file。';
COMMENT ON COLUMN attachments.mime            IS '附件 MIME 类型（白名单 + magic bytes 校验后写入）。';
COMMENT ON COLUMN attachments.size_bytes      IS '附件大小（字节，>0）。';
COMMENT ON COLUMN attachments.sha256          IS '内容 sha256：相同则二进制相同（Worker 端缓存判定）。';
COMMENT ON COLUMN attachments.original_name   IS '上传时的原始文件名。';
COMMENT ON COLUMN attachments.created_at      IS '创建时间。';

-- ============================================================================
-- attachment_blobs（024）
-- ============================================================================
COMMENT ON TABLE  attachment_blobs               IS '附件二进制：与 attachments 1:1 侧表，PG 自动 TOAST。';
COMMENT ON COLUMN attachment_blobs.attachment_id IS '关联的附件元数据 ID。';
COMMENT ON COLUMN attachment_blobs.data          IS '附件二进制内容。';
