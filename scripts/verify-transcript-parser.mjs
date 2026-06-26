#!/usr/bin/env node
// 一次性人工校验：把 apps/console/app/ui/transcript.tsx 里新加的两条解析逻辑（isMeta 过滤、后台进程统计）
// 在真实的 claude session .jsonl 上跑一遍，断言：
//   (a) 含 isMeta:true / <command-name> / <local-command-caveat> 等内部注入消息时，过滤后 user 气泡数明显少于原始 user 行数
//   (b) 含 Bash run_in_background:true 派发 + queued_command task-notification 收尾时，能正确算出「已派发 - 已完成」
// 与 transcript.tsx 中函数体一一镜像（如果以后改了 transcript.tsx 的解析规则，这里也要同步）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const projectsDir = path.join(os.homedir(), ".claude", "projects", "D--project-claude-center");

function isMetaUserEntry(obj) {
  if (obj.type !== "user") return false;
  if (obj.isMeta === true) return true;
  const content = obj.message?.content;
  let head = "";
  if (typeof content === "string") {
    head = content.trimStart().slice(0, 80);
  } else if (Array.isArray(content)) {
    const first = content.find((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string");
    head = first ? first.text.trimStart().slice(0, 80) : "";
  }
  return /^<(local-command-caveat|local-command-stdout|command-name|command-message|command-args|system-reminder)\b/.test(head);
}

function parseTranscript(jsonl) {
  const items = [];
  for (const line of jsonl.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if ((obj.type !== "user" && obj.type !== "assistant") || !obj.message) continue;
    if (isMetaUserEntry(obj)) continue;
    const content = obj.message.content;
    const raw = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
    const blocks = [];
    for (const b of raw) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) blocks.push({ kind: "text" });
      else if (b.type === "tool_use") blocks.push({ kind: "tool_use" });
      else if (b.type === "tool_result") blocks.push({ kind: "tool_result" });
    }
    if (blocks.length) items.push({ role: obj.type, blocks });
  }
  return items;
}

const BG_STATUS_RE = /<status>([^<]*)<\/status>/;
const BG_TASKID_RE = /<task-id>([^<]*)<\/task-id>/;

function extractBackgroundJobs(jsonl) {
  if (!jsonl) return [];
  const byId = new Map();
  const toolUseDesc = new Map();
  for (const line of jsonl.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    if (obj.type === "assistant") {
      const blocks = Array.isArray(obj.message?.content) ? obj.message.content : [];
      for (const b of blocks) {
        if (b && b.type === "tool_use" && b.name === "Bash") {
          const input = b.input || {};
          if (input.run_in_background === true && typeof b.id === "string") {
            toolUseDesc.set(b.id, input.description || (input.command || "").split("\n")[0]?.slice(0, 140) || "(bg)");
          }
        }
      }
      continue;
    }
    if (obj.type === "user") {
      const blocks = Array.isArray(obj.message?.content) ? obj.message.content : [];
      for (const b of blocks) {
        if (b && b.type === "tool_result") {
          const bgId = typeof obj.toolUseResult?.backgroundTaskId === "string" ? obj.toolUseResult.backgroundTaskId : null;
          if (bgId && !byId.has(bgId)) {
            byId.set(bgId, { id: bgId, status: "running", description: (b.tool_use_id && toolUseDesc.get(b.tool_use_id)) || "(bg)" });
          }
        }
      }
      continue;
    }
    if (obj.type === "attachment" && obj.attachment?.type === "queued_command") {
      const prompt = typeof obj.attachment.prompt === "string" ? obj.attachment.prompt : "";
      if (!prompt.includes("<task-notification>")) continue;
      const idm = BG_TASKID_RE.exec(prompt);
      const stm = BG_STATUS_RE.exec(prompt);
      if (!idm) continue;
      const raw = (stm?.[1] ?? "").trim().toLowerCase();
      const status = raw === "completed" ? "completed" : raw === "failed" ? "failed" : raw === "killed" ? "killed" : "running";
      const existing = byId.get(idm[1].trim());
      if (existing) existing.status = status;
      else byId.set(idm[1].trim(), { id: idm[1].trim(), status, description: "(bg)" });
    }
  }
  return Array.from(byId.values());
}

function rawUserBubbleCount(jsonl) {
  let n = 0;
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj; try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type === "user" && obj.message) n++;
  }
  return n;
}

async function main() {
  const entries = fs.readdirSync(projectsDir).filter((e) => e.endsWith(".jsonl"));
  if (entries.length === 0) {
    console.error("no session jsonl found under", projectsDir);
    process.exit(1);
  }

  // 找一个既含 isMeta 又含 backgroundTaskId 的 session 做强校验。
  let bestPath = null;
  let bestScore = -1;
  for (const e of entries) {
    const p = path.join(projectsDir, e);
    const raw = fs.readFileSync(p, "utf8");
    const meta = raw.includes('"isMeta":true') ? 1 : 0;
    const bg = raw.includes("backgroundTaskId") ? 1 : 0;
    const notif = raw.includes("<task-notification>") ? 1 : 0;
    const score = meta + bg + notif;
    if (score > bestScore) { bestScore = score; bestPath = p; }
  }
  if (bestScore < 2) {
    console.error("not enough fixture coverage; bestScore=" + bestScore);
    process.exit(1);
  }
  const jsonl = fs.readFileSync(bestPath, "utf8");
  const rawUser = rawUserBubbleCount(jsonl);
  const parsed = parseTranscript(jsonl);
  const parsedUser = parsed.filter((i) => i.role === "user").length;
  const jobs = extractBackgroundJobs(jsonl);
  const pending = jobs.filter((j) => j.status === "running");
  const completed = jobs.filter((j) => j.status === "completed");

  console.log(JSON.stringify({
    fixture: path.basename(bestPath),
    rawUserBubbles: rawUser,
    parsedUserBubbles: parsedUser,
    droppedMetaUserBubbles: rawUser - parsedUser,
    bgJobsTotal: jobs.length,
    bgPending: pending.length,
    bgCompleted: completed.length
  }, null, 2));

  if (rawUser - parsedUser <= 0) {
    console.error("FAIL: expected isMeta filter to drop ≥1 user bubble in this fixture");
    process.exit(2);
  }
  if (jobs.length === 0) {
    console.error("FAIL: expected ≥1 background job detected in this fixture");
    process.exit(2);
  }
  // 完整 fixture 里通常 spawn 数 == 完成数（都收到了 task-notification）。即便如此，extractBackgroundJobs 的所有 status 必须只能是已知枚举之一。
  for (const j of jobs) {
    if (!["running","completed","failed","killed"].includes(j.status)) {
      console.error("FAIL: unexpected status", j);
      process.exit(2);
    }
  }
  // 合成 fixture：spawn 两条后台命令、只完成一条 → 校验 pending 计数。
  const synth = [
    JSON.stringify({ type: "assistant", message: { content: [
      { type: "tool_use", id: "tu_a", name: "Bash", input: { command: "sleep 60", description: "task A", run_in_background: true } }
    ]}}),
    JSON.stringify({ type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "tu_a", content: "..." }
    ]}, toolUseResult: { backgroundTaskId: "bgA" } }),
    JSON.stringify({ type: "assistant", message: { content: [
      { type: "tool_use", id: "tu_b", name: "Bash", input: { command: "sleep 120", description: "task B", run_in_background: true } }
    ]}}),
    JSON.stringify({ type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "tu_b", content: "..." }
    ]}, toolUseResult: { backgroundTaskId: "bgB" } }),
    JSON.stringify({ type: "attachment", attachment: { type: "queued_command", prompt: "<task-notification>\n<task-id>bgA</task-id>\n<status>completed</status>\n<summary>task A done</summary>\n</task-notification>" } })
  ].join("\n");
  const sJobs = extractBackgroundJobs(synth);
  const sPending = sJobs.filter((j) => j.status === "running");
  console.log("\nSynth fixture: jobs=" + sJobs.length + ", pending=" + sPending.length + ", desc[A]=" + (sJobs.find(j=>j.id==="bgA")?.description) + ", desc[B]=" + (sJobs.find(j=>j.id==="bgB")?.description));
  if (sJobs.length !== 2) { console.error("FAIL: synth expected 2 jobs, got " + sJobs.length); process.exit(2); }
  if (sPending.length !== 1 || sPending[0].id !== "bgB") { console.error("FAIL: synth expected exactly bgB pending"); process.exit(2); }
  if (sJobs.find(j=>j.id==="bgA")?.description !== "task A") { console.error("FAIL: synth expected bgA description='task A'"); process.exit(2); }

  console.log("\nOK — parser changes verified against real session fixture + synth pending case");
}

main().catch((err) => { console.error(err); process.exit(1); });
