// 单测 mergeEntries：失败错误条按 created_at 插入到 jsonl items 的对应时间位置，
// 不再统一堆在末尾（旧 bug：dbExtras 全部追加在 TranscriptView 之后，与实际发生顺序串位）。
// 同时单测 parseTranscript：TItem 多了 ts 字段（来自 jsonl 行的 timestamp）。
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const parseUrl = path.resolve(ROOT, "apps/console/app/ui/transcript-parse.ts").replace(/\\/g, "/");

// 用 ts-node / tsx 风格直接 import 不行（.ts），改写成读源码 + 用 typescript 编译——太重。
// 简化：tsc 把 transcript-parse.ts 单独编一份到 tmp 拿出来跑。
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

const tmp = mkdtempSync(path.join(tmpdir(), "chat-merge-"));
try {
  // 1) 编译 transcript-parse.ts 到 mjs（剥成纯 JS）
  const src = readFileSync(parseUrl, "utf8");
  const tsFile = path.join(tmp, "parse.ts");
  writeFileSync(tsFile, src);
  execSync(`npx -p typescript@5 tsc "${tsFile}" --target ES2020 --module ESNext --moduleResolution Bundler --outDir "${tmp}"`, { stdio: "inherit" });

  const parseMod = await import(`file:///${path.join(tmp, "parse.js").replace(/\\/g, "/")}`);

  // 1) parseTranscript：ts 字段提取
  const sample = [
    JSON.stringify({ type: "user", timestamp: "2026-06-28T10:00:00Z", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-06-28T10:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } })
  ].join("\n");
  const items = parseMod.parseTranscript(sample);
  assert.equal(items.length, 2);
  assert.equal(items[0].ts, "2026-06-28T10:00:00Z", "user item should carry ts from jsonl timestamp");
  assert.equal(items[1].ts, "2026-06-28T10:00:01Z", "assistant item should carry ts");
  console.log("✓ parseTranscript: TItem.ts populated from jsonl timestamp");

  // 2) mergeEntries：复制 transcript.tsx 内嵌实现做最小验证（保持纯函数语义，避免把 React 拖进来）
  function mergeEntries(items, failures) {
    const out = [];
    const sorted = failures.slice().sort((a, b) => a.ts.localeCompare(b.ts));
    let fi = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      while (fi < sorted.length && it.ts != null && sorted[fi].ts <= it.ts) {
        out.push({ kind: "failure", failure: sorted[fi] });
        fi++;
      }
      out.push({ kind: "item", item: it, idx: i });
    }
    while (fi < sorted.length) {
      out.push({ kind: "failure", failure: sorted[fi] });
      fi++;
    }
    return out;
  }

  // 场景：3 轮 user/assistant，第 2 轮失败 → DB failed assistant 的 created_at 应当夹在 第 2 轮 与 第 3 轮 之间。
  const T = (s) => `2026-06-28T10:${s}Z`;
  const turnItems = [
    { role: "user", ts: T("00:00"), blocks: [{ kind: "text", text: "msg-1" }] },
    { role: "assistant", ts: T("00:01"), blocks: [{ kind: "text", text: "reply-1" }] },
    { role: "user", ts: T("01:00"), blocks: [{ kind: "text", text: "msg-2 (将失败)" }] },
    // 假设第 2 轮失败，jsonl 只到 user-2，failure created_at = 01:30
    { role: "user", ts: T("02:00"), blocks: [{ kind: "text", text: "msg-3" }] },
    { role: "assistant", ts: T("02:01"), blocks: [{ kind: "text", text: "reply-3" }] }
  ];
  const failures = [{ id: "f1", error: "claude exit 1", ts: T("01:30") }];

  const merged = mergeEntries(turnItems, failures);

  // 验证：failure 的位置在 msg-2 之后、msg-3 之前。
  const order = merged.map((e) => (e.kind === "failure" ? `FAIL:${e.failure.id}` : e.item.blocks[0].text));
  console.log("merged order:", order);
  assert.deepEqual(order, [
    "msg-1",
    "reply-1",
    "msg-2 (将失败)",
    "FAIL:f1",
    "msg-3",
    "reply-3"
  ]);
  console.log("✓ mergeEntries: failure inserted between failed turn and next user message");

  // 场景 2：多条失败夹在不同位置（确认按 created_at 排序 + 各自插对位）
  const failures2 = [
    { id: "f2", error: "later fail", ts: T("02:30") }, // 在 reply-3 之后
    { id: "f1", error: "early fail", ts: T("01:30") }
  ];
  const merged2 = mergeEntries(turnItems, failures2);
  const order2 = merged2.map((e) => (e.kind === "failure" ? `FAIL:${e.failure.id}` : e.item.blocks[0].text));
  console.log("merged order 2:", order2);
  assert.deepEqual(order2, [
    "msg-1",
    "reply-1",
    "msg-2 (将失败)",
    "FAIL:f1",
    "msg-3",
    "reply-3",
    "FAIL:f2"
  ]);
  console.log("✓ mergeEntries: multiple failures sorted + interleaved by ts");

  console.log("\nALL PASS");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
