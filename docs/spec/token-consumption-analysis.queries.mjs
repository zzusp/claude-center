// 复现 docs/spec/token-consumption-analysis.md 的全部实测数字。
// 运行：在仓库根（已装依赖、DATABASE_URL 指向目标库）执行 `node docs/spec/token-consumption-analysis.queries.mjs`
// 只读：仅 SELECT，不写库。tz 用 Asia/Shanghai 还原"今天上午"的本地口径。
import pg from "pg";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const TZ = "Asia/Shanghai";
const fmt = (n) => Number(n).toLocaleString();

async function dayTasks() {
  // 当日本地时区有活动的任务，按 token 降序（§1 表）
  const r = await pool.query(
    `SELECT t.id, t.title, t.status, t.model, t.auto_reply, t.dynamic_workflow, t.total_tokens,
            to_char(t.created_at AT TIME ZONE $1,'MM-DD HH24:MI') created_local,
            to_char(t.finished_at AT TIME ZONE $1,'MM-DD HH24:MI') finished_local
       FROM tasks t
      WHERE (t.updated_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date
      ORDER BY t.total_tokens DESC NULLS LAST`,
    [TZ]
  );
  const sum = r.rows.reduce((s, x) => s + Number(x.total_tokens || 0), 0);
  console.log(`\n# §1 当日任务（${r.rows.length} 个）TOTAL=${fmt(sum)}`);
  for (const x of r.rows) {
    console.log(
      `${fmt(x.total_tokens).padStart(12)} | ${x.status.padEnd(8)} | ${x.model.padEnd(7)} | ar=${x.auto_reply ? 1 : 0} wf=${x.dynamic_workflow ? 1 : 0} | ${x.created_local}->${x.finished_local || "-"} | ${x.id.slice(0, 8)} | ${(x.title || "").slice(0, 40)}`
    );
  }
  return r.rows.filter((x) => Number(x.total_tokens) > 0).map((x) => x.id.slice(0, 8));
}

async function usageComposition(short) {
  // §2 结论 A/B：从 task_sessions.jsonl 解析四类 token 占比 + 规模
  const r = await pool.query(
    `SELECT ts.jsonl, t.title, t.total_tokens FROM task_sessions ts JOIN tasks t ON t.id=ts.task_id WHERE t.id::text LIKE $1||'%'`,
    [short]
  );
  if (!r.rows.length) return console.log(`${short}: no session`);
  const { jsonl, title, total_tokens } = r.rows[0];
  let inp = 0, out = 0, cc = 0, cr = 0, asst = 0, tooluse = 0, sidechain = 0, maxctx = 0;
  for (const line of jsonl.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let o;
    try { o = JSON.parse(t); } catch { continue; }
    if (o.isSidechain) sidechain++;
    const u = o.message?.usage;
    if (o.type === "assistant" && u) {
      asst++;
      inp += u.input_tokens || 0; out += u.output_tokens || 0;
      cc += u.cache_creation_input_tokens || 0; cr += u.cache_read_input_tokens || 0;
      const ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      if (ctx > maxctx) maxctx = ctx;
      const c = o.message?.content;
      if (Array.isArray(c)) for (const b of c) if (b.type === "tool_use") tooluse++;
    }
  }
  const s = inp + out + cc + cr;
  console.log(`\n# ${short} | ${title} | total_tokens=${fmt(total_tokens)}`);
  console.log(`  assistant=${asst} tool_use=${tooluse} sidechain=${sidechain} maxctx=${fmt(maxctx)}`);
  console.log(`  cache_read=${(cr / s * 100).toFixed(1)}%  output=${(out / s * 100).toFixed(2)}%  cache_creation=${(cc / s * 100).toFixed(1)}%  input=${(inp / s * 100).toFixed(2)}%`);
}

async function rounds(short) {
  // §2 结论 C：轮次 / resume / auto_merge_skipped 计数
  const r = await pool.query(
    `SELECT te.event_type, count(*) c FROM task_events te JOIN tasks t ON t.id=te.task_id
      WHERE t.id::text LIKE $1||'%' AND te.event_type IN ('claude_turn_finished','resumed','auto_merge_skipped')
      GROUP BY te.event_type`,
    [short]
  );
  const m = Object.fromEntries(r.rows.map((x) => [x.event_type, Number(x.c)]));
  console.log(`  ${short}: turns=${m.claude_turn_finished || 0} resumes=${m.resumed || 0} automerge_skipped=${m.auto_merge_skipped || 0}`);
}

async function resumeBoundaries(short) {
  // §2 结论 C 机制澄清：找 jsonl 里 >5min 的 assistant 间隔（= 续接/缓存过期边界），
  // 看该次 API 调用的 cache_creation（冷缓存满价重写） vs cache_read（温缓存），并打印上下文增长。
  const r = await pool.query(
    `SELECT ts.jsonl FROM task_sessions ts JOIN tasks t ON t.id=ts.task_id WHERE t.id::text LIKE $1||'%'`,
    [short]
  );
  if (!r.rows.length) return console.log(`${short}: no session`);
  const msgs = [];
  for (const line of r.rows[0].jsonl.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let o;
    try { o = JSON.parse(t); } catch { continue; }
    const u = o.message?.usage;
    if (o.type === "assistant" && u) {
      msgs.push({
        ts: o.timestamp,
        cc: u.cache_creation_input_tokens || 0,
        cr: u.cache_read_input_tokens || 0,
        ctx: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)
      });
    }
  }
  console.log(`\n# ${short} resume/缓存过期边界（>5min 间隔）  上下文: 首5条≈${msgs.slice(0,5).map(m=>m.ctx).join("/")}  末5条≈${msgs.slice(-5).map(m=>m.ctx).join("/")}`);
  for (let i = 1; i < msgs.length; i++) {
    const gapMin = (new Date(msgs[i].ts) - new Date(msgs[i - 1].ts)) / 60000;
    if (gapMin > 5)
      console.log(`  idx ${String(i).padStart(3)} gap=${gapMin.toFixed(0)}min  cache_creation=${fmt(msgs[i].cc)} cache_read=${fmt(msgs[i].cr)} ctx=${fmt(msgs[i].ctx)}`);
  }
}

const shorts = await dayTasks();
console.log("\n# §2 结论 A/B 用量构成");
for (const s of shorts) await usageComposition(s);
console.log("\n# §2 结论 C 轮次");
for (const s of shorts) await rounds(s);
console.log("\n# §2 结论 C 机制澄清：续接/冷缓存边界（Top1 与 d8b66a53）");
for (const s of ["2f524b68", "d8b66a53"]) await resumeBoundaries(s);
await pool.end();
