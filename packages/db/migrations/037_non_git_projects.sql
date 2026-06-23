-- 037_non_git_projects.sql
-- 支持非 git 管理的项目：vcs='none' 的项目是普通本地目录（无 repo_url / 无分支 / 无 PR），
-- 任务与实时对话都在该目录里就地跑 Claude。方案见 docs/spec/non-git-projects.md
--
-- - repo_url 去掉 NOT NULL：非 git 项目存 NULL。原 UNIQUE 约束保留（PG 视多个 NULL 为彼此不同，互不冲突）。
-- - 新增 vcs 标志：'git'（默认，行为不变）/ 'none'（非 git 本地目录）。
-- - project_repos / task_repos 不动：非 git 项目压根不建这些行（syncMainProjectRepo 跳过非 git）。

ALTER TABLE projects ALTER COLUMN repo_url DROP NOT NULL;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS vcs text NOT NULL DEFAULT 'git'
    CHECK (vcs IN ('git', 'none'));

COMMENT ON COLUMN projects.vcs IS '版本控制类型：git=git 托管（有 repo_url/分支/PR，行为不变）；none=非 git 本地目录（就地修改、无分支无 PR）。';
COMMENT ON COLUMN projects.repo_url IS 'git 仓库地址；vcs=none 的非 git 项目为 NULL。';
