# Web 下发终端命令到 Worker（在配置的运行终端中执行）

## 需求

Web Console 能向指定 Worker 下发一条**终端命令**，Worker 收到后在**自己配置的「运行终端」**（`terminal_command` + `claude_pre_command`）里执行，并把执行结果（stdout / stderr / 退出码）回传给 Console 展示。下发走既有的「定向指令 + SSE 中转」链路：落库 → 推 `worker:<id>` 频道 → Worker 收到即认领执行（中转不可用时退回数据库轮询，功能不降级）。

## 现状（改动前）

链路骨架其实已存在，但有两处缺口：

- **DB / API / SSE 已就绪**：`direct_commands` 表（`command ∈ {shell, claude_prompt}`）、`createDirectCommand` / `claimNextDirectCommand` / `markDirectCommand*` 查询、`POST /api/direct-commands`（落库后 `publishRelay` 推 `worker:<id>` 频道）、Worker `onRelaySignal → tick → claimNextDirectCommand → executeDirectCommand` 全部齐备。
- **缺口 1：`shell` 指令没走配置的终端**。`executeDirectCommand` 里 `command === "shell"` 写死调 `runPowerShell(text)`——永远是 PowerShell，无视 Worker 配置的 `terminalCommand` / `claudePreCommand`。非 Windows、或配了 Git Bash / 自定义终端的 Worker 都不对。
- **缺口 2：Console 没有任何 UI 调 `/api/direct-commands`**。该端点是死代码，用户在 web 上无从下发，也看不到结果。

本特性把这两处缺口补齐，不改协议、不改表结构（`shell` 类型自始合法）。

## 方案

### Worker：`shell` 指令在配置的运行终端里执行

复用既有的「运行终端」抽象（`terminal.ts`，原本只服务 claude 调用）：

- `terminal.ts` 抽出通用拼接 `buildTerminalScript(family, preCommand, command)` → `<前置命令> <sep> <命令>`（前置命令为空则只跑命令）；`buildClaudeScript` 改为复用它（claude 调用串作为 `command` 传入），消除重复。
- `executor.ts` 新增 `runShellInTerminal(config, command, cwd)`：取 `config.terminalCommand || defaultTerminalCommand()` 定家族 → `buildTerminalScript` 拼脚本（前置命令先行，所以代理 / VPN / 登录设置的环境被命令继承）→ `terminalLaunch` 以 `shell:false` spawn 终端可执行文件，脚本作单参不被二次解析。
- `executeDirectCommand` 的 `shell` 分支由 `runPowerShell(text)` 改为 `runShellInTerminal(config, text, cwd)`。`claude_prompt` 分支不变。

**命令文本按所选终端语法书写**（与前置命令同款约定），内联进脚本——和 `claudePreCommand` 处理方式一致。这是 admin（`command.create`）才能下发的能力，注入风险等同既有的前置命令配置。超时沿用原 `runPowerShell` 的 20 分钟上限（`SHELL_COMMAND_TIMEOUT_MS`）。

> 为什么前置命令也跟着跑：与 claude 调用形态完全一致——每次 claude / 任务执行本就先跑一遍前置命令。下发的 `git fetch` / `npm install` 等同样需要前置命令设的代理环境，否则受限网络下会失败。前置命令失败不阻塞后续命令（`;` / `&` 分隔，与 `buildClaudeScript` 行为一致）。

### Console：worker 详情页「下发命令」面板

- 新增 DB 查询 `listWorkerDirectCommands(pool, workerId, limit=20)`：按 `created_at DESC` 取该 worker 的指令历史。
- 新增 `GET /api/workers/[id]/direct-commands`（需 `command.create`）：返回该 worker 的指令历史。
- 新增组件 `worker-command.tsx`（`WorkerCommandPanel`）：command 文本框 + 可选 cwd + 「下发」按钮，POST 既有 `/api/direct-commands`（`command:"shell"`）；下方按 `usePolling` 刷新指令历史，每条显示状态徽章、命令文本、时间，展开见 stdout / stderr / 退出码 / 失败原因。仅 `canCommand`（admin）渲染。
- `worker-detail.tsx` 在「运行配置」区后接入该面板；面板顶部提示「将在该 Worker 的运行终端（{terminal} + 前置命令）中按其语法执行」。

## 涉及文件

- `apps/worker/src/terminal.ts`：加 `buildTerminalScript`，`buildClaudeScript` 复用。
- `apps/worker/src/executor.ts`：加 `runShellInTerminal` + `SHELL_COMMAND_TIMEOUT_MS`，`executeDirectCommand` 改用之；imports 去 `runPowerShell`、加 `buildTerminalScript`。
- `packages/db/src/queries.ts`：加 `listWorkerDirectCommands`。
- `apps/console/app/api/workers/[id]/direct-commands/route.ts`：新 GET。
- `apps/console/app/ui/worker-command.tsx`：新面板组件。
- `apps/console/app/ui/worker-detail.tsx`：接入面板。
- `README.md`：文档同步。

## 验证

- `npm run typecheck` / `npm run build` 五包绿。
- Worker 单元级断言：`buildTerminalScript` 对 powershell / cmd / bash 三家族拼接正确（前置命令有 / 无两种）；`runShellInTerminal` 按配置终端选 launch。
- `verify:console` 起站点 401→200 绿（确认 instrumentation / 路由未破坏）。
- 端到端（手动 / 脚本）：配置 worker 终端 → Console 详情页下发 `echo hello` → 历史出现 success + stdout 含 hello。
</content>
</invoke>
