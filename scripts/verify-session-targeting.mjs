#!/usr/bin/env node
// 一次性人工校验：apps/worker/src/session.ts 里 findSessionFile 新增的 sinceMs / preferSessionId 过滤逻辑。
// 真实场景重现用户原报：同一 wtPath 下有「别的终端窗口跑的 claude」留下的旧 .jsonl，本对话的定时消息触发后
// 应锁定本对话的 session（preferSessionId 命中或 sinceMs 时间窗内的文件），不被旧文件抢走最新 mtime。
//
// 实现：在临时 CLAUDE_CONFIG_DIR 下伪造同一 cwd 的两个 .jsonl（A 旧、B 新），分别验证：
//   1) 仅时间窗：sinceMs 在 A 之后 → 跳过 A，命中 B
//   2) preferSessionId="A"：直接命中 A.jsonl（即便 B 更新）
//   3) preferSessionId="missing"：回退到时间窗逻辑（A 在窗外 → 取 B）

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function main() {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "session-target-"));
  const cwd = path.join(tmpBase, "fakecwd");
  fs.mkdirSync(cwd, { recursive: true });
  const claudeDir = path.join(tmpBase, "dot-claude");
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const projectsDir = path.join(claudeDir, "projects", encoded);
  fs.mkdirSync(projectsDir, { recursive: true });

  // A：很旧（mtime/birthtime 5 分钟前）；B：刚刚写的。
  const fiveMinAgo = Date.now() - 5 * 60_000;
  const fileA = path.join(projectsDir, "A.jsonl");
  const fileB = path.join(projectsDir, "B.jsonl");
  fs.writeFileSync(fileA, '{"type":"assistant","message":{"content":[{"type":"text","text":"A"}]}}\n');
  fs.utimesSync(fileA, new Date(fiveMinAgo), new Date(fiveMinAgo));
  fs.writeFileSync(fileB, '{"type":"assistant","message":{"content":[{"type":"text","text":"B"}]}}\n');

  // 动态导入已编译的 session.js（typecheck/build 已通过，dist 应存在）。
  // 但 session.js 依赖 packages/db，依赖 pg —— 我们只测一个函数，没必要起 DB。直接拷贝函数体来跑（与 session.ts 当前实现 1:1）。
  const fsp = fs.promises;

  function claudeProjectsDir() { return path.join(process.env.CLAUDE_CONFIG_DIR, "projects"); }
  function encodeProjectDir(cwd) { return cwd.replace(/[^a-zA-Z0-9]/g, "-"); }
  async function findSessionFile(cwd, opts) {
    const dir = path.join(claudeProjectsDir(), encodeProjectDir(cwd));
    const sinceMs = opts?.sinceMs ?? null;
    const preferSessionId = opts?.preferSessionId ?? null;
    if (preferSessionId) {
      const target = path.join(dir, `${preferSessionId}.jsonl`);
      try {
        const st = await fsp.stat(target);
        return { file: target, mtime: st.mtimeMs };
      } catch { /* fall through */ }
    }
    let entries;
    try { entries = await fsp.readdir(dir); } catch { return null; }
    let newest = null;
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const full = path.join(dir, entry);
      try {
        const stat = await fsp.stat(full);
        if (sinceMs !== null) {
          const birth = Number.isFinite(stat.birthtimeMs) ? stat.birthtimeMs : 0;
          if (stat.mtimeMs < sinceMs && birth < sinceMs) continue;
        }
        if (!newest || stat.mtimeMs > newest.mtime) newest = { file: full, mtime: stat.mtimeMs };
      } catch {}
    }
    return newest;
  }

  // case 1：无 sinceMs / preferSessionId → 旧版行为，命中最新者（B）
  const c1 = await findSessionFile(cwd);
  console.log("case 1 (legacy newest):", path.basename(c1.file));
  if (path.basename(c1.file) !== "B.jsonl") { console.error("FAIL: case 1"); process.exit(2); }

  // case 2：sinceMs 在 A 之后、B 之前 → 跳过 A、命中 B
  const sinceBetween = Date.now() - 60_000;
  const c2 = await findSessionFile(cwd, { sinceMs: sinceBetween });
  console.log("case 2 (sinceMs filters A):", path.basename(c2.file));
  if (path.basename(c2.file) !== "B.jsonl") { console.error("FAIL: case 2"); process.exit(2); }

  // case 3：preferSessionId='A' → 直接命中 A（即便 B 更新）
  const c3 = await findSessionFile(cwd, { preferSessionId: "A" });
  console.log("case 3 (preferSessionId hit):", path.basename(c3.file));
  if (path.basename(c3.file) !== "A.jsonl") { console.error("FAIL: case 3"); process.exit(2); }

  // case 4：preferSessionId='missing' + sinceMs 把 A 排掉 → 回退到时间窗，命中 B
  const c4 = await findSessionFile(cwd, { preferSessionId: "missing", sinceMs: sinceBetween });
  console.log("case 4 (preferSessionId miss → window):", path.basename(c4.file));
  if (path.basename(c4.file) !== "B.jsonl") { console.error("FAIL: case 4"); process.exit(2); }

  // case 5：sinceMs 在所有文件之后 → null（无候选）
  const c5 = await findSessionFile(cwd, { sinceMs: Date.now() + 60_000 });
  console.log("case 5 (sinceMs in future):", c5);
  if (c5 !== null) { console.error("FAIL: case 5"); process.exit(2); }

  console.log("\nOK — findSessionFile sinceMs / preferSessionId verified");
  fs.rmSync(tmpBase, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exit(1); });
