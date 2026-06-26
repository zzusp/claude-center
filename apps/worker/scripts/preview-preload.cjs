// 仅供 UI 预览/截图验证：在渲染层注入样例 workerApi，让各页有真实数据可渲染。
// 不进生产路径（生产用 apps/worker/preload.cjs 经 IPC 接真 worker）。contextIsolation 关，直接挂 window。
const nowMs = Date.now();
const iso = (deltaMs) => new Date(nowMs + deltaMs).toISOString();

const STATE = {
  workerName: "dev-macbook",
  hostName: "dev-macbook.local",
  workingState: "working",
  allowRemoteControl: true,
  maxParallel: 3,
  activeCount: 1,
  claudeVersion: "1.2.7",
  subscriptionType: "max",
  usage: {
    five_hour: { utilization: 42, resets_at: iso(3 * 3600 * 1000) },
    seven_day: { utilization: 78, resets_at: iso(4 * 24 * 3600 * 1000) }
  },
  capabilities: {
    git: { ok: true, version: "2.43.0" },
    gh: { ok: true, version: "2.40.1" },
    claude: { ok: true, version: "1.2.7" },
    nodejs: { ok: true, version: "20.10.0" },
    python: { ok: true, version: "3.11.6" },
    dingtalk: { ok: true, version: "0.4.1" }
  },
  os: { platform: "darwin", label: "macOS 14.4 (arm64)" },
  terminalCommand: "",
  claudePreCommand: "",
  relayState: "connected",
  relayChannels: 3,
  databaseUrl: "postgresql://app:****@db.internal:5432/claude_center",
  dbState: "connected",
  dingtalkEnabled: true,
  dingtalkCommand: "dingtalk",
  logs: Array.from({ length: 40 }).map((_, i) => ({
    ts: iso(-(40 - i) * 60000),
    level: i % 9 === 0 ? "error" : "info",
    message: i % 9 === 0 ? "claude exited non-zero (task t" + i + ")" : "polled center · claimed 0 · active 1 · heartbeat ok #" + i
  }))
};

const TASKS = [
  { id: "t1", status: "waiting", title: "重构对话历史首屏渲染加速", project_name: "claude-center", work_branch: "feature/render-perf", submit_mode: "pr", pr_url: "https://example.com/pr/1", merge_status: null, error_message: null, updated_at: iso(-5 * 60000) },
  { id: "t2", status: "running", title: "用户权限页重构 + worker 完成数", project_name: "claude-center", work_branch: "feature/users-rbac", submit_mode: "pr", pr_url: null, merge_status: null, error_message: null, updated_at: iso(-90000) },
  { id: "t3", status: "success", title: "worktree 执行可观测性", project_name: "claude-center", work_branch: "worktree-observability", submit_mode: "pr", pr_url: "https://example.com/pr/3", merge_status: null, error_message: null, updated_at: iso(-3600000) },
  { id: "t4", status: "merged", title: "任务详情页 summary bar 移除 PR 项", project_name: "claude-center", work_branch: "feature/summary-bar", submit_mode: "pr", pr_url: "https://example.com/pr/4", merge_status: "merged", error_message: null, updated_at: iso(-2 * 3600000) },
  { id: "t5", status: "failed", title: "迁移序号撞号修复", project_name: "claude-center", work_branch: "feature/migrate-fix", submit_mode: "push", pr_url: null, merge_status: null, error_message: "migration 027 conflicts with origin/main", updated_at: iso(-4 * 3600000) }
];

const TASK_DETAIL = {
  comments: [
    { author: "user", body: "麻烦把首屏渲染优化一下，先渲染最近 20 条。", created_at: iso(-10 * 60000) },
    { author: "worker", body: "需要确认：分页是按条数还是按时间窗口？", created_at: iso(-6 * 60000) }
  ],
  events: [
    { event_type: "claimed", message: "认领任务", created_at: iso(-9 * 60000) },
    { event_type: "running", message: "启动 claude 子进程", created_at: iso(-8 * 60000) },
    { event_type: "waiting", message: "等待用户澄清", created_at: iso(-6 * 60000) }
  ]
};

const CONVERSATIONS = [
  { id: "c1", title: "排查 SSE 重连抖动", project_name: "claude-center", branch: "main", status: "active", generating: true, last_message_at: iso(-20000) },
  { id: "c2", title: "解释 instrumentation 拆分", project_name: "claude-center", branch: "feature/render-perf", status: "active", generating: false, last_message_at: iso(-8 * 60000) },
  { id: "c3", title: "迁移编号规则", project_name: "claude-center", branch: "main", status: "closed", generating: false, last_message_at: iso(-2 * 3600000) }
];

const CONV_DETAIL = {
  messages: [
    { role: "user", body: "为什么 SSE 偶尔重连？", status: "done", error_message: null },
    { role: "assistant", body: "可能是中转保活超时；先看 relayState 是否在 reconnecting 抖动……", status: "streaming", error_message: null }
  ]
};

const api = {
  getState: async () => STATE,
  setWorking: async () => {},
  setAllowRemote: async () => {},
  setMaxParallel: async () => {},
  clearLogs: async () => {},
  listTerminals: async () => [
    { name: "PowerShell 7", command: "C:/Program Files/PowerShell/7/pwsh.exe" },
    { name: "Windows Terminal", command: "wt.exe" }
  ],
  setTerminal: async () => {},
  setPreCommand: async () => {},
  setRelayConfig: async () => {},
  setDatabaseConfig: async () => ({ ok: true, error: null }),
  setDingtalkConfig: async () => {},
  listCloudProjects: async () => [{ name: "claude-center" }, { name: "demo-app" }],
  listProjectLinks: async () => [
    { project_name: "claude-center", local_path: "D:/project/claude-center" },
    { project_name: "demo-app", local_path: "D:/work/demo-app" }
  ],
  pickFolder: async () => null,
  addProjectLink: async () => {},
  removeProjectLink: async () => {},
  cancelTask: async () => {},
  listMyTasks: async () => TASKS,
  getTaskDetail: async () => TASK_DETAIL,
  replyToTask: async () => {},
  retryMyTask: async () => true,
  listMyConversations: async () => CONVERSATIONS,
  getConversationDetail: async () => CONV_DETAIL
};

// contextIsolation:false → preload 与页面共享 window，直接挂载。
window.workerApi = api;
