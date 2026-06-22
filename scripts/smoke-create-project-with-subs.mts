// 行为冒烟：新建项目时一并填写子仓（子项目）。
// 与 apps/console/app/api/projects/route.ts 的 POST 持久化路径一致——
// 在一个事务里 createProject + replaceProjectSubRepos，再用 listProjectRepos 断言落库结果。
//
// 由 run-smoke-against-ephemeral.mjs 触发：
//   node scripts/run-smoke-against-ephemeral.mjs scripts/smoke-create-project-with-subs.mts
import {
  closePool,
  createProject,
  getPool,
  listProjectRepos,
  replaceProjectSubRepos,
  type ProjectRepoInput
} from "@claude-center/db";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function main(): Promise<void> {
  const pool = getPool();

  // 1) 含子仓：在一个事务里建项目 + 整批写子仓（与 POST /api/projects 一致）。
  const subInputs: ProjectRepoInput[] = [
    { name: "widgets-lib", repoUrl: "https://example.invalid/widgets.git", defaultBranch: "develop", description: "组件库", position: 1 },
    { name: "", repoUrl: "https://example.invalid/utils.git", defaultBranch: "main", description: "", position: 2 }
  ];
  const client = await pool.connect();
  let projectId: string;
  try {
    await client.query("BEGIN");
    const project = await createProject(client, {
      name: "Multi Repo Smoke",
      repoUrl: "https://example.invalid/main.git",
      defaultBranch: "main",
      description: "smoke"
    });
    await replaceProjectSubRepos(client, project.id, subInputs);
    await client.query("COMMIT");
    projectId = project.id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const repos = await listProjectRepos(pool, projectId);
  const main = repos.filter((r) => r.role === "main");
  const subs = repos.filter((r) => r.role === "sub");
  assert(main.length === 1, `应恰有 1 个主仓行，实际 ${main.length}`);
  assert(main[0]!.repo_url === "https://example.invalid/main.git", "主仓 repo_url 应镜像项目主仓");
  assert(subs.length === 2, `应恰有 2 个子仓行，实际 ${subs.length}`);

  const widgets = subs.find((r) => r.repo_url === "https://example.invalid/widgets.git");
  const utils = subs.find((r) => r.repo_url === "https://example.invalid/utils.git");
  assert(widgets, "应能查到 widgets 子仓");
  assert(widgets!.name === "widgets-lib", "widgets 子仓名应落库");
  assert(widgets!.default_branch === "develop", "widgets 子仓默认分支应为 develop");
  assert(widgets!.description === "组件库", "widgets 子仓描述应落库");
  assert(widgets!.position === 1, `widgets 子仓 position 应为 1，实际 ${widgets!.position}`);
  assert(utils, "应能查到 utils 子仓");
  assert(utils!.position === 2, `utils 子仓 position 应为 2，实际 ${utils!.position}`);
  console.log(`✓ 含子仓项目：1 主仓 + ${subs.length} 子仓 全部正确落库`);

  // 2) 不含子仓：原行为不变——只落主仓行，无子仓。
  const plain = await createProject(pool, {
    name: "No Sub Smoke",
    repoUrl: "https://example.invalid/plain.git",
    defaultBranch: "main",
    description: ""
  });
  const plainRepos = await listProjectRepos(pool, plain.id);
  assert(plainRepos.filter((r) => r.role === "main").length === 1, "无子仓项目应有 1 主仓行");
  assert(plainRepos.filter((r) => r.role === "sub").length === 0, "无子仓项目不应有子仓行");
  console.log("✓ 无子仓项目：仅主仓行，原行为不变");

  console.log("ALL SMOKE CHECKS PASSED");
}

try {
  await main();
} finally {
  await closePool();
}
