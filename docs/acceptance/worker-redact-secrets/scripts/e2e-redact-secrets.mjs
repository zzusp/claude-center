// 真机 e2e：worker 采集失败的错误文案脱敏，不把凭据透进错误链（→ this.log 桌面面板 / usage.error 落库 Console）。
// 跑的是 worker 的【已构建 dist】（随桌面端分发的同一份代码），用假 token 实跑 curl / node，避免依赖真实账号凭据。
//
//   npm -w @claude-center/worker run build
//   node docs/acceptance/worker-redact-secrets/scripts/e2e-redact-secrets.mjs
//
// 覆盖：
//   A redactSecrets 单元   —— Bearer / sk-ant 凭据被替换为 ***，前缀保留、非凭据原样
//   B formatCommandFailure —— args + 命令输出里的凭据均被脱敏（失败文案的拼装入口）
//   C runCommand 非零退出  —— 真跑 curl（坏代理必败，含 Authorization: Bearer <假token>），抛出的 error.message 不含 token
//   D runCommand 超时      —— 真跑 node（挂住）触发 timeoutMs，超时文案含命令行（带假 token），脱敏后不含 token
//   E fetchUsage 形态      —— 按 inspect.ts 的 `请求失败：${error.message}` 包装 C 的 error，证明回填 usage.error 已干净
import { runCommand, formatCommandFailure, redactSecrets } from "../../../../apps/worker/dist/shell.js";

const FAKE_BEARER = "FAKEoauth_DEADBEEF_do_not_log_0123456789";
const FAKE_APIKEY = "sk-ant-FAKEkey_DEADBEEF_0123456789";
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"} — ${msg}`); if (!cond) failed++; };
// 断言「脱敏后不含明文 token，且保留可读前缀」。clean 文本不再打印任何 token。
const assertRedacted = (label, text) => {
  ok(!text.includes(FAKE_BEARER), `${label}：不含明文 Bearer token`);
  ok(!text.includes(FAKE_APIKEY), `${label}：不含明文 sk-ant API key`);
};

// —— A：redactSecrets 单元 —— //
const aBearer = redactSecrets(`-H Authorization: Bearer ${FAKE_BEARER} https://api.anthropic.com`);
ok(aBearer.includes("Bearer ***") && !aBearer.includes(FAKE_BEARER), `A1 Bearer token → "Bearer ***"（${aBearer}）`);
const aKey = redactSecrets(`x-api-key: ${FAKE_APIKEY}`);
ok(aKey.includes("sk-ant-***") && !aKey.includes(FAKE_APIKEY), `A2 sk-ant key → "sk-ant-***"（${aKey}）`);
ok(redactSecrets("git push origin main") === "git push origin main", "A3 非凭据文本原样不动");

// —— B：formatCommandFailure（失败文案拼装入口，args + 输出都脱敏）—— //
const bMsg = formatCommandFailure({
  command: "curl",
  args: ["-H", `Authorization: Bearer ${FAKE_BEARER}`, "https://api.anthropic.com/api/oauth/usage"],
  exitCode: 7,
  stdout: `{"hint":"key ${FAKE_APIKEY}"}`,
  stderr: "curl: (7) Failed to connect"
});
assertRedacted("B formatCommandFailure", bMsg);
ok(bMsg.includes("Bearer ***") && bMsg.includes("sk-ant-***"), `B 仍保留脱敏占位与命令上下文（exitCode/stderr 可读）`);

// —— C：runCommand 真跑 curl（坏代理必败，复刻 fetchUsage 的 argv 形态）—— //
const curl = process.platform === "win32" ? "curl.exe" : "curl";
const curlArgs = [
  "-sS", "--max-time", "5",
  "-H", `Authorization: Bearer ${FAKE_BEARER}`,
  "-H", "anthropic-beta: oauth-2025-04-20",
  "-x", "http://127.0.0.1:9", // discard 口，连接直接被拒 → 必败、快速失败
  "https://api.anthropic.com/api/oauth/usage"
];
try {
  await runCommand(curl, curlArgs, { timeoutMs: 15_000, shell: false });
  ok(false, "C curl 预期失败（坏代理），却成功了");
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);
  assertRedacted("C runCommand 非零退出（真 curl）", msg);
  ok(/Command failed: .*curl/.test(msg) && msg.includes("Bearer ***"), "C 失败文案仍含命令上下文且 token 已脱敏");
}

// —— D：runCommand 真触发 timeoutMs（node 挂住）—— //
try {
  await runCommand(
    "node",
    ["-e", "setTimeout(()=>{}, 10000)", `Authorization: Bearer ${FAKE_BEARER}`],
    { timeoutMs: 600 }
  );
  ok(false, "D node 预期超时，却返回了");
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);
  assertRedacted("D runCommand 超时", msg);
  ok(msg.startsWith("Command timed out:") && msg.includes("Bearer ***"), "D 超时文案脱敏后仍可读");
}

// —— E：fetchUsage 形态（inspect.ts 把 error.message 包成 usage.error）—— //
let usageError = "";
try {
  await runCommand(curl, curlArgs, { timeoutMs: 15_000, shell: false });
} catch (error) {
  usageError = `请求失败：${error instanceof Error ? error.message : String(error)}`; // 同 inspect.ts:242
}
assertRedacted("E usage.error 回填", usageError);
ok(usageError.startsWith("请求失败："), `E usage.error 仍带原因前缀（透到 this.log / Console 时已无 token）`);

console.log(failed === 0 ? "\nALL PASS — 采集失败文案已脱敏，token 不再透出" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
