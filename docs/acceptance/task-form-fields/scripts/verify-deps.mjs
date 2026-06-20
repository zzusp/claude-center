// 验证「编辑任务表单补全前置任务」的后端闭环：PATCH update 的 dependsOn 整批替换 + undefined 保持不变。
// 起 next dev（DATABASE_URL 由调用方指向一次性干净库）→ 登录 admin → 建项目/任务 → 跑依赖断言 → 关服务。
//
// 用法（先用 ephemeral-db --keep 建库拿连接串，再传进来）：
//   DATABASE_URL=<temp> CONSOLE_PORT=<free> node docs/acceptance/task-form-fields/scripts/verify-deps.mjs
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const consoleDir = path.join(root, "apps", "console");
const host = "127.0.0.1";
const port = process.env.CONSOLE_PORT || "3000";
const baseUrl = `http://${host}:${port}`;

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const dotNext = path.join(consoleDir, ".next");
if (existsSync(dotNext)) rmSync(dotNext, { recursive: true, force: true });

const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
const child = spawn(process.execPath, [nextBin, "dev", "--turbopack", "--hostname", host, "--port", port], {
  cwd: consoleDir,
  env: process.env,
  windowsHide: true
});
let output = "";
child.stdout.on("data", (d) => (output += d.toString("utf8")));
child.stderr.on("data", (d) => (output += d.toString("utf8")));

function waitForReady() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`dev server 未就绪\n${output}`)), 120_000);
    const interval = setInterval(() => {
      if (output.includes("Ready in")) {
        clearTimeout(timeout);
        clearInterval(interval);
        resolve();
      }
    }, 250);
    child.on("exit", (c) => {
      clearTimeout(timeout);
      clearInterval(interval);
      reject(new Error(`dev server 退出 ${c}\n${output}`));
    });
  });
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "✓ PASS" : "✗ FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

let cookie = "";
async function api(method, p, body) {
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* keep raw */
  }
  return { status: res.status, json, text, res };
}

const sortedEq = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

try {
  await waitForReady();

  const login = await api("POST", "/api/auth/login", { username: "admin", password: "admin123" });
  cookie = `cc_session=${/cc_session=([^;]+)/.exec(login.res.headers.get("set-cookie") ?? "")?.[1] ?? ""}`;
  check("admin 登录 200", login.status === 200, `status=${login.status}`);

  const proj = await api("POST", "/api/projects", {
    name: `deps-test-${Date.now()}`,
    repoUrl: "https://example.com/deps-test.git"
  });
  const projectId = proj.json?.project?.id;
  check("建项目 201", proj.status === 201 && projectId, `status=${proj.status}`);

  async function mkTask(title, dependsOn) {
    const r = await api("POST", "/api/tasks", {
      projectId,
      title,
      description: `${title} desc`,
      baseBranch: "main",
      submitMode: "pr",
      model: "default",
      ...(dependsOn ? { dependsOn } : {})
    });
    return r.json?.task;
  }
  async function deps(id) {
    const r = await api("GET", `/api/tasks/${id}`);
    return r.json?.task?.depends_on ?? [];
  }
  // update 必填全字段：从当前任务回填后再带 dependsOn（模拟编辑表单提交）。
  async function update(id, patch) {
    const cur = (await api("GET", `/api/tasks/${id}`)).json.task;
    return api("PATCH", `/api/tasks/${id}`, {
      action: "update",
      title: cur.title,
      description: cur.description,
      baseBranch: cur.base_branch,
      workBranch: cur.work_branch,
      targetBranch: cur.target_branch,
      submitMode: cur.submit_mode,
      autoMergePr: cur.auto_merge_pr,
      autoReply: cur.auto_reply,
      autoDecisionHints: cur.auto_decision_hints,
      model: cur.model,
      dynamicWorkflow: cur.dynamic_workflow,
      ...patch
    });
  }

  const A = await mkTask("任务A");
  const B = await mkTask("任务B");
  const C = await mkTask("任务C 依赖A", [A.id]);
  check("建 A/B/C", A?.id && B?.id && C?.id);

  // 1) 新建即带前置（compose 路径）
  check("C 初始前置=[A]", sortedEq(await deps(C.id), [A.id]));

  // 2) 编辑整批替换 [A] → [A,B]
  const u1 = await update(C.id, { dependsOn: [A.id, B.id] });
  check("update dependsOn=[A,B] 200", u1.status === 200, `status=${u1.status} ${u1.text?.slice(0, 120)}`);
  check("替换后前置=[A,B]", sortedEq(await deps(C.id), [A.id, B.id]));

  // 3) 编辑不带 dependsOn → 保持不变（undefined 语义）
  const u2 = await update(C.id, {});
  check("update 省略 dependsOn 200", u2.status === 200);
  check("省略后前置仍=[A,B]（保持）", sortedEq(await deps(C.id), [A.id, B.id]));

  // 4) 编辑清空 [] → 无前置
  const u3 = await update(C.id, { dependsOn: [] });
  check("update dependsOn=[] 200", u3.status === 200);
  check("清空后前置=[]", sortedEq(await deps(C.id), []));

  const failed = results.filter((r) => !r.pass);
  console.log(`\n结果：${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) {
    console.log(`日志尾部：\n${output.slice(-1500)}`);
    process.exitCode = 1;
  }
} catch (e) {
  console.error(e);
  console.log(`日志尾部：\n${output.slice(-1500)}`);
  process.exitCode = 1;
} finally {
  child.kill();
}
