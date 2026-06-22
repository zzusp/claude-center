// 真机 e2e：桌面端 Usage 采集「失败不重试，等下一次采集触发」。
// 跑的是 worker 的【已构建 dist】（即随桌面端分发的同一份代码），对本机已登录的 Claude Code 账号实采。
//
//   node docs/acceptance/worker-usage-no-retry/scripts/e2e-usage-no-retry.mjs
//
// 覆盖：
//   A 真成功    —— inspectClaude(refreshUsage:true) 走真代理实采 oauth/usage，拿到 5h/7d 窗口
//   B 失败捕获  —— 强制坏代理触发采集失败：不抛异常、回填 error；上轮有窗口则沿用窗口+error（preserveUsageOnError）
//   C 不重试闸门 —— inspectClaude(refreshUsage:false) 不发起网络、原样透传上轮（失败那轮之后的 info tick 不重采）
//   D 真 runner —— ClaudeCenterWorker.refreshInfo() 连跑两次：失败一轮推进采集时刻，紧接的一轮被闸门挡住不重采
import { inspectClaude } from "../../../../apps/worker/dist/inspect.js";
import { readWorkerConfig } from "../../../../apps/worker/dist/config.js";
import { ClaudeCenterWorker } from "../../../../apps/worker/dist/runner.js";

const BAD_PROXY = "http://127.0.0.1:9"; // discard 口，连接直接被拒 → 采集必败、快速失败
let failed = 0;
// 采集失败的 error 文案里夹带了 curl 全命令（含 Authorization: Bearer <token>），打印/留证前先脱敏，勿泄漏。
// 全局兜底脱敏 console：既盖住本脚本的打印，也盖住 worker 内部 this.log → console.error/log 透出的 token。
const redact = (s) => String(s).replace(/Bearer\s+\S+/g, "Bearer ***").replace(/sk-ant-\S+/g, "sk-ant-***");
for (const m of ["log", "error", "warn"]) {
  const orig = console[m].bind(console);
  console[m] = (...args) => orig(...args.map((a) => (typeof a === "string" ? redact(a) : a)));
}
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"} — ${msg}`); if (!cond) failed++; };

const config = readWorkerConfig();
console.log(`[env] usageProxy=${config.usageProxy ?? "(直连)"}  usageIntervalMs=${config.usageIntervalMs}`);

// —— A：真成功采集（真代理 + 本机 max 账号）——
const a = await inspectClaude(config, { refreshUsage: true });
console.log(`[A] subscriptionType=${a.subscriptionType}  usage=${JSON.stringify(a.usage)}`);
ok(a.subscriptionType === "max", `本机凭据识别为套餐账号 max（实读 .credentials.json），当前=${a.subscriptionType}`);
const aHasWindow = Boolean(a.usage.five_hour || a.usage.seven_day);
ok(aHasWindow && !a.usage.error, `真代理实采 oauth/usage 成功，拿到 5h/7d 窗口（5h=${a.usage.five_hour?.utilization}% 7d=${a.usage.seven_day?.utilization}%）`);

// —— B：失败捕获（坏代理）——
const b = await inspectClaude({ ...config, usageProxy: BAD_PROXY }, { refreshUsage: true, previousUsage: a.usage });
console.log(`[B] usage=${JSON.stringify(b.usage)}`);
ok(Boolean(b.usage.error), `采集失败被捕获为 error、未抛异常（error=${b.usage.error}）`);
if (aHasWindow) {
  ok(Boolean(b.usage.five_hour || b.usage.seven_day), "失败但上轮有窗口 → 沿用上轮窗口 + 记录本轮 error（preserveUsageOnError）");
}

// —— C：不重试闸门（refreshUsage:false 不发起任何网络）——
const before = Date.now();
const c = await inspectClaude({ ...config, usageProxy: BAD_PROXY }, { refreshUsage: false, previousUsage: b.usage });
const elapsed = Date.now() - before;
ok(c.usage === b.usage, "refreshUsage:false 原样透传上轮 usage（同一引用）→ 未重新采集");
ok(elapsed < 1000, `未发起网络调用（耗时 ${elapsed}ms，远小于一次 curl 超时）`);

// —— D：真 runner.refreshInfo 连跑两次，验证「失败一轮即跳过、不重试」——
// reportInfo 需要 DB；本环境无 DATABASE_URL，getPool 会快速抛错，被 tick 的 try/catch 吞掉，
// 不影响在它之前就已落定的 lastUsageFetchAt / lastInspect（即「采集是否重试」的观察点）。
const worker = new ClaudeCenterWorker({ ...config, usageProxy: BAD_PROXY, databaseUrl: "" });
worker.lastUsageFetchAt = 0;
worker.lastInspect = { claudeVersion: null, subscriptionType: "unknown", usage: {} };
const tick = async () => { try { await worker.refreshInfo(); } catch { /* reportInfo 无 DB，预期抛错 */ } };

await tick();                                   // 第 1 轮：到点采集 → 坏代理失败
const t1 = worker.lastUsageFetchAt;
const u1 = worker.lastInspect.usage;
ok(t1 > 0, `第 1 轮（到点采集）推进了采集时刻 lastUsageFetchAt=${t1}`);
ok(Boolean(u1.error) && !u1.five_hour && !u1.seven_day, `第 1 轮采集失败，usage 仅含 error（${u1.error}）`);

await tick();                                   // 第 2 轮：紧接着——未满 usageIntervalMs，应被闸门挡住、不重采
const t2 = worker.lastUsageFetchAt;
const u2 = worker.lastInspect.usage;
ok(t2 === t1, `第 2 轮未满 usageIntervalMs(${config.usageIntervalMs}ms) → 未重新采集、lastUsageFetchAt 不变（${t2}）= 采集失败不重试`);
ok(u2 === u1, "第 2 轮原样沿用上轮 usage（透传 previousUsage），未发起新采集");

console.log(failed === 0 ? "\nALL PASS — 采集失败不重试，等下一次采集触发" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
