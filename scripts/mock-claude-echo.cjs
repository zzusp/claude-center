#!/usr/bin/env node
// Mock claude CLI：把进程 env / argv / stdin 全部回声为一个 JSON 对象到 stdout。
// 既用作 PR-A 端到端联调（worker 子进程是否收到 CLAUDE_CENTER_MAIN_REPO 和拼好的 prompt），
// 也可以作长期 e2e 资产复用：任何需要"看 worker 真的喂给 claude 什么"的场景都可设
//   CLAUDE_CODE_COMMAND="node <repo>/scripts/mock-claude-echo.cjs"
// 但注意：Node spawn shell:false 下 Windows 不能直接把 "node ..." 当成 command 路径
// （会被当成单一可执行文件名查找），生产配置要走 .cmd shim 或 wrap。本脚本直接被 `node`
// 解释执行无问题——下游 driver 用 spawn("node", [mockPath, ...claudeArgs]) 方式调用。
//
// 输出协议：一行 JSON 到 stdout，便于上层 JSON.parse。结构同时模拟 `claude -p ... --output-format
// json` 期待的形状（session_id / result / usage），这样真要给 worker 当 claude 用也不会被 parseClaudeJson
// 卡住（不是本次必要，但有意保留兼容）。
// 真 claude `-p <prompt>` 不读 stdin（prompt 在 argv 里），mock 也对齐这一行为：
// 不挂 stdin 监听，立刻把 env / argv 回声到 stdout 并退出，避免因等 stdin EOF 吊死。
// 如果未来要模拟"读 stdin"的场景再单独写一个 mock-claude-stdin.cjs，不污染本脚本契约。
setImmediate(finish);

function finish() {
  if (finish.done) return;
  finish.done = true;
  const stdin = ""; // 兼容字段，本 mock 不读 stdin
  const payload = {
    // 模拟 claude JSON 协议必要字段（让生产 parseClaudeJson 不抛错）
    session_id: "mock-session-" + Date.now(),
    result: "mock-result",
    usage: { input_tokens: 0, output_tokens: 0 },
    // mock 自己的回声（驱动脚本读这部分做断言）
    mock: {
      env: {
        CLAUDE_CENTER_MAIN_REPO: process.env.CLAUDE_CENTER_MAIN_REPO ?? null,
        CLAUDE_CODE_WORKFLOWS: process.env.CLAUDE_CODE_WORKFLOWS ?? null,
        CLAUDE_CODE_DISABLE_WORKFLOWS: process.env.CLAUDE_CODE_DISABLE_WORKFLOWS ?? null
      },
      argv: process.argv.slice(2),
      stdin
    }
  };
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}
