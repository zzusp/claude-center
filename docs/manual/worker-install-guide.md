# ClaudeCenter Worker 部署手册

> Worker 是 ClaudeCenter 的桌面执行节点：跑在你本机，负责心跳、领任务、调用本地 `claude` 执行编码任务、推 PR 到 GitHub。所有任务与状态通过 PostgreSQL（+ 可选 SSE 中转）与 Console 同步。
>
> 当前版本：**worker-v0.2.0**（首版标准化打包 / 不做代码签名）

## 1. 系统要求

| 项 | 要求 |
|---|---|
| 操作系统 | Windows 10/11（x64）、macOS 11+（x64 或 Apple Silicon） |
| 内存 | 4 GB 起，建议 8 GB+（并行 worktree 多耗内存） |
| 磁盘 | 100 MB 安装 + 任务 git worktree（按项目体积） |
| 网络 | 能访问 Console 用的 PostgreSQL（默认 `:55432`）+ 可选 SSE 中转 |

## 2. 本机前置软件（必须）

Worker 启动会自检以下三个命令，缺则任务跑挂、桌面窗口「能力自检」红点。

| 命令 | 用途 | 默认获取方式 |
|---|---|---|
| `git` | 项目操作、worktree、提交 | https://git-scm.com/ |
| `claude` | Claude Code CLI，执行编码任务 | https://docs.claude.com/en/docs/claude-code/quickstart |
| `gh` | GitHub CLI，认领后推 PR | https://cli.github.com/ |

可用环境变量覆盖二进制路径：`CLAUDE_CODE_COMMAND` / `GH_COMMAND`。

`claude` 与 `gh` 都需要**先登录账号一次**（`claude login` / `gh auth login`）。Worker 不代为登录。

## 3. 下载安装包

去 GitHub Releases 拿对应平台的包：

https://github.com/zzusp/claude-center/releases/tag/worker-v0.2.0

| 平台 | 文件 | 安装方式 |
|---|---|---|
| Windows x64 | `ClaudeCenter-Worker-0.2.0-win-x64.exe` | NSIS 安装包：双击 → 选目录 → 完成（约 100 MB） |
| macOS Apple Silicon | `ClaudeCenter-Worker-0.2.0-mac-arm64.dmg` | M1/M2/M3 等 ARM 芯片用这个 |
| macOS Intel | `ClaudeCenter-Worker-0.2.0-mac-x64.dmg` | Intel 芯片用这个 |

> macOS 不确定芯片？终端跑 `uname -m` —— `arm64` 选 arm64 包，`x86_64` 选 x64 包。

## 4. 首次启动：绕过系统安全警告

**当前版本未做代码签名**——后续接入证书后会自动签名 + macOS notarize，届时无需此步。

### Windows（SmartScreen 拦截）

双击安装包后：

1. 弹窗「Windows 已保护你的电脑」 → 点 **更多信息**
2. 下方出现 **仍要运行** 按钮 → 点
3. 后续 NSIS 安装向导按提示装即可

装好后桌面会有 `ClaudeCenter Worker` 快捷方式。

### macOS（Gatekeeper 拦截）

双击 dmg 把 `ClaudeCenter Worker.app` 拖到 Applications。首次启动：

1. 弹窗「无法打开"ClaudeCenter Worker"，因为 Apple 无法检查它是否包含恶意软件」 → 点 **取消**（不能在这里点"打开"，是禁用的）
2. **方法 A（推荐）**：右键 / Ctrl+点击 `.app` → 选 **打开** → 再次弹窗这次有 **打开** 按钮 → 点

   **方法 B（一次性命令）**：

   ```bash
   xattr -d com.apple.quarantine "/Applications/ClaudeCenter Worker.app"
   ```

   之后直接双击即可。

第一次绕过后系统记住信任，以后启动正常。

## 5. 配置：让 Worker 找到 Console

Worker 通过 PostgreSQL 跟 Console 沟通——必须知道连接串。配置写在 `~/.claude-center/worker.json` 或环境变量。

### 5.1 必填：DATABASE_URL

第一次启动 Worker 桌面端会弹「配置」面板，最重要的是这条：

```
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/claude_center
```

向 Console 管理员（你们公司的 DBA / 运维）要这个连接串。

**也可走 `.env` 文件**：在用户目录 `~/.claude-center/.env` 写：

```
DATABASE_URL=postgresql://...
CLAUDE_CENTER_WORKER_NAME=your-pc-name   # 给本机起个识别名，Console 列表里显示
```

完整环境变量参考仓库根 `.env.example`。

### 5.2 Worker 名字

`CLAUDE_CENTER_WORKER_NAME` 默认是机器 hostname。建议显式设个易识别的（如 `office-imac` / `home-windows-7800x3d`），Console 列表里看着清楚。

### 5.3 可选：SSE 中转（低延迟实时线）

如果 Console 管理员部署了 SSE relay，配下面 4 条：

```
CLAUDE_CENTER_RELAY_URL=https://relay.your-org.com
CLAUDE_CENTER_RELAY_PUBLISH_TOKEN=<向管理员要>
CLAUDE_CENTER_RELAY_WORKER_TOKEN=<向管理员要>
CLAUDE_CENTER_RELAY_SECRET=<可选，用于浏览器 ticket>
```

不配也能跑，Worker 自动走数据库轮询（功能不降级，只是延迟从亚秒变 10s 量级）。

## 6. 配置：跑 `claude` 前置命令（代理 / VPN）

国内网络访问 `api.anthropic.com` 通常需要代理。在 Worker 桌面窗口的「运行终端」卡片：

| 字段 | 示例 |
|---|---|
| 运行终端 | `Windows PowerShell` / `Git Bash` / `bash` 等本机已装的 shell |
| 前置命令 | PowerShell：`$env:HTTPS_PROXY = "http://127.0.0.1:10808"`<br>Git Bash：`export HTTPS_PROXY=http://127.0.0.1:10808` |

前置命令在 `claude` 启动的**同一 shell session**里执行，环境变量自动继承。

> **注意**：套餐用量（5h / 7d 配额）走另一条网络出口，配 `CLAUDE_CENTER_USAGE_PROXY` 单独走代理；只配前置命令不会让用量采集走代理（详见 README「Worker 前置依赖」）。

## 7. 关联本地项目

Worker 需要知道**本机哪个文件夹对应 Console 哪个项目**才能在该目录跑任务。

桌面窗口「关联项目」卡片：

1. 「云端项目」下拉选目标项目（Console 已创建的）
2. 「选择文件夹」选本地仓库根目录
3. 点「添加」

可关联多个。持久化到 `~/.claude-center/worker.json`。

> 也可在 `CLAUDE_CENTER_PROJECTS` 环境变量里以 JSON 数组形式批量配（参考 `.env.example`），与桌面端添加项合并去重。

## 8. 上线与工作状态

启动 Worker 后默认状态是「**在线但空闲**」——只发心跳、**不接任务**。

| 状态 | 含义 | 接任务？ |
|---|---|---|
| `offline` | Worker 进程没起 / 心跳超时 | ❌ |
| `online + idle` | 已在线，但没切到工作 | ❌ |
| `online + working` | 工作中 | ✅ |

在桌面窗口顶部「工作状态」开关切换。Console 也可远程切（前提是 Worker 桌面端开了「允许远程控制」）。状态持久化，重启保留。

### 并行容量

默认并发 1（同一时间最多 1 个在途任务）。多任务并行用 git worktree 隔离。桌面窗口可调到更大（量力而行，每个 worktree 一份 node_modules）。

## 9. 升级到新版本

下载新版本安装包覆盖装即可（Windows 直接装；macOS 拖 .app 替换）。配置在 `~/.claude-center/`，升级不会丢。

升级前建议在桌面窗口先把「工作状态」切到 `idle`，等当前任务跑完再升级。

## 10. 卸载

| 平台 | 步骤 |
|---|---|
| Windows | 控制面板 → 程序和功能 → ClaudeCenter Worker → 卸载 |
| macOS | 把 Applications 里的 `ClaudeCenter Worker.app` 拖到废纸篓 |

清理配置 / 持久化数据：

- `~/.claude-center/`（worker.json、env、缓存）
- 任务 worktree 目录（在你关联的项目 `.git/worktrees/cc-*`）

## 11. 常见问题排查

### 启动后桌面窗口「能力自检」红点

意思是 `git` / `claude` / `gh` 其中之一不在 PATH。

- 把对应命令装上，确保终端跑 `git --version` / `claude --version` / `gh --version` 三条都有输出
- macOS 用 brew 装的命令路径在 `/opt/homebrew/bin/`（Apple Silicon）或 `/usr/local/bin/`（Intel）；如果从 Finder 启动 Worker 它继承的 PATH 可能不含 brew，从终端 `open -a "ClaudeCenter Worker"` 启动可解决，或在系统设置改 launchd `PATH`

### Console 列表里看不到本机 Worker

- 检查 `DATABASE_URL` 写对（用 `psql` 或别的客户端连一下试试）
- 检查防火墙允许出站到 PostgreSQL 端口
- 桌面窗口「连接状态」会显示 DB 健康度，红色就是连不上

### 任务跑挂 `claude CLI not found`

`claude` 不在 PATH。要么装 Claude Code CLI（参 §2），要么设 `CLAUDE_CODE_COMMAND` 指向 claude 可执行文件全路径。

### 任务执行中 Claude 返回 forbidden / unauthorized

通常是 `claude login` 没做或者代理没配对。先确认：

1. 终端跑 `claude --version` 能出版本
2. 终端跑 `claude` 进交互模式不报 forbidden
3. 在 Worker 桌面端按 §6 配前置命令 + 代理

### 套餐用量（5h / 7d）一直空

`CLAUDE_CENTER_USAGE_PROXY` 没配。它跟前置命令的代理是两条独立出口，详见 README「Worker 前置依赖」与 `docs/spec/worker-detail-usage-parallel.md`。

### PR 创建失败

`gh` 没登录或没权限。终端跑：

```bash
gh auth login
gh auth status
```

### 看日志

桌面窗口「日志」卡片实时显示；持久化文件在：

- Windows：`%APPDATA%\ClaudeCenter Worker\logs\`
- macOS：`~/Library/Application Support/ClaudeCenter Worker/logs/`

## 12. 反馈与提 issue

提 issue 时附上：

- Worker 版本号（桌面窗口顶部）+ 平台
- 桌面窗口「能力自检」截图
- 出错时的「日志」末尾 50 行
- 复现步骤

仓库：https://github.com/zzusp/claude-center
