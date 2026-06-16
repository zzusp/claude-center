import type { ProjectRepo, TaskRepoInput } from "@claude-center/db";

// 创建/编辑任务时，把 body.taskRepos 与项目所有仓做对齐，生成 createTaskRepos 入参。
// - 主仓行：始终启用，分支用 tasks 字段（保持 tasks ↔ task_repos main 镜像）
// - 子仓行：用户启用 → 用 body 传入的分支（缺省回退到子仓 default_branch）；
//          未启用 → sub_status='skipped' + 子仓 work_branch 留空、其它分支用 default（不参与签出）
// 缺省 body.taskRepos 时仅主仓启用、其它子仓全部 skipped（兼容旧前端 / 默认行为）。
export type TaskRepoUserInput = {
  projectRepoId: string;
  baseBranch?: string;
  workBranch?: string;
  targetBranch?: string;
  enabled?: boolean;
};

// 子仓 work_branch 名按子仓的「name」slug 派生（旧版本用 relative_path——已下线，
// 因为 relative_path 现在由 worker 运行时派生、console 端不再持有）。
// fallback：name 为空时用 project_repos.id 前 8 位，保证唯一可读。
export function subWorkBranchFor(mainWorkBranch: string, repo: { id: string; name: string }): string {
  const slug = (repo.name ?? "").replace(/[^a-zA-Z0-9_\-]+/g, "-").replace(/^-+|-+$/g, "");
  const tail = slug || repo.id.slice(0, 8);
  return `${mainWorkBranch}-${tail}`;
}

export function buildTaskRepoInputs({
  projectRepos,
  body,
  baseBranch,
  workBranch,
  targetBranch
}: {
  projectRepos: ProjectRepo[];
  body: { taskRepos?: TaskRepoUserInput[] };
  baseBranch: string;
  workBranch: string;
  targetBranch: string;
}): TaskRepoInput[] {
  const mainRepo = projectRepos.find((r) => r.role === "main");
  if (!mainRepo) {
    throw new Error("项目主仓行缺失");
  }
  const byPid = new Map(projectRepos.map((r) => [r.id, r]));
  const provided = new Map(body.taskRepos?.map((t) => [t.projectRepoId, t]) ?? []);

  // 校验：用户传了不属于本项目的 projectRepoId 直接报错（前端理论上不该发生）
  for (const tr of body.taskRepos ?? []) {
    if (!byPid.has(tr.projectRepoId)) {
      throw new Error(`taskRepos 包含未知 projectRepoId: ${tr.projectRepoId}`);
    }
  }

  const inputs: TaskRepoInput[] = [];
  inputs.push({
    projectRepoId: mainRepo.id,
    role: "main",
    relativePath: ".",
    baseBranch,
    workBranch,
    targetBranch,
    subStatus: "pending"
  });

  for (const repo of projectRepos) {
    if (repo.role === "main") continue;
    const input = provided.get(repo.id);
    const enabled = input?.enabled === true;
    inputs.push({
      projectRepoId: repo.id,
      role: "sub",
      // 占位：子仓本机相对路径由 worker prepare 阶段派生后 UPDATE 改写真实值。
      // 形式 `*-<projectRepoId>` 保证 UNIQUE(task_id, relative_path) 不在创建期就撞，
      // 后续 worker 端派生完成才进入正常 UNIQUE 域。
      relativePath: `*-${repo.id}`,
      baseBranch: enabled ? input?.baseBranch?.trim() || repo.default_branch : repo.default_branch,
      workBranch: enabled ? input?.workBranch?.trim() || subWorkBranchFor(workBranch, repo) : "",
      targetBranch: enabled ? input?.targetBranch?.trim() || repo.default_branch : repo.default_branch,
      subStatus: enabled ? "pending" : "skipped"
    });
  }
  return inputs;
}
