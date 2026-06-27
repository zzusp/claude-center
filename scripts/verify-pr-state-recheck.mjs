#!/usr/bin/env node
// 一次性人工校验：apps/worker/src/executor.ts 里 getPrState 对 `gh pr view --json state` 输出的解析，
// 以及"merged/closed PR 当成不存在"的复用分支判定。函数体改了请同步本脚本（1:1 镜像）。
//
// 真因：task_repos.pr_url 指向的 PR 被合并后，老代码直接 `gh pr edit --body` 把新一轮产出贴到那条
// merged PR 上而不是新开一条（"还在用旧 PR"的现象）。修复：把 state 探一下，MERGED/CLOSED 即清掉
// pr_url、落到下方 gh pr create 路径新建。
import assert from "node:assert/strict";

function parseState(stdout) {
  try {
    const parsed = JSON.parse(stdout.trim() || "{}");
    const s = String(parsed.state ?? "").toUpperCase();
    if (s === "OPEN" || s === "CLOSED" || s === "MERGED") return s;
    return null;
  } catch {
    return null;
  }
}

function shouldReuse(prUrl, state) {
  if (!prUrl) return false;
  if (state === "MERGED" || state === "CLOSED") return false;
  // OPEN 或查不到（null，gh 抖动等）保守走复用，避免把活 PR 当死。
  return true;
}

// 场景 1：MERGED 不复用、清掉 pr_url
{
  const state = parseState(`{"state":"MERGED"}`);
  assert.equal(state, "MERGED");
  assert.equal(shouldReuse("https://github.com/x/y/pull/1", state), false);
}

// 场景 2：CLOSED 不复用（用户手动关掉）
{
  const state = parseState(`{"state":"CLOSED"}`);
  assert.equal(state, "CLOSED");
  assert.equal(shouldReuse("https://github.com/x/y/pull/2", state), false);
}

// 场景 3：OPEN 复用
{
  const state = parseState(`{"state":"OPEN"}`);
  assert.equal(state, "OPEN");
  assert.equal(shouldReuse("https://github.com/x/y/pull/3", state), true);
}

// 场景 4：小写也接受（gh 不同版本曾返回小写）
{
  const state = parseState(`{"state":"merged"}`);
  assert.equal(state, "MERGED");
  assert.equal(shouldReuse("https://github.com/x/y/pull/4", state), false);
}

// 场景 5：gh 抖动 / 输出空 / 非 JSON → state=null → 保守复用（不把活 PR 误判成死）
{
  assert.equal(parseState(""), null);
  assert.equal(parseState("garbage not json"), null);
  assert.equal(shouldReuse("https://github.com/x/y/pull/5", null), true);
}

// 场景 6：未知 state 字符串 → null → 保守复用
{
  assert.equal(parseState(`{"state":"DRAFT"}`), null);
  assert.equal(shouldReuse("https://github.com/x/y/pull/6", null), true);
}

// 场景 7：pr_url 为空 → 不复用（流程本来就走 create 分支）
{
  assert.equal(shouldReuse(null, "OPEN"), false);
  assert.equal(shouldReuse("", "OPEN"), false);
}

console.log("OK — getPrState parsing + merged/closed-skip semantics verified (7 cases)");
