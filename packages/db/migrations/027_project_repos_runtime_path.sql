-- 027_project_repos_runtime_path.sql
-- 把 project_repos.relative_path 从「console 维护」改为「worker 运行时派生」。
-- 详细方案见 docs/spec/project-repos-runtime-path.md。
--
-- 变化：
-- - project_repos: 新增 name / description；删 relative_path / display_name；
--   旧 UNIQUE(project_id, relative_path) → 新 UNIQUE(project_id, repo_url)；
--   旧 CHECK（POSIX 路径校验 / role-path 一致性）全部删除。
-- - task_repos.relative_path 列保留：仍是「任务级、worker 派生后的本机相对路径快照」。
--   console 创建子仓行时写 '*-<projectRepoId>' 形式的占位（保 UNIQUE(task_id, relative_path) 不撞），
--   worker prepare 时 UPDATE 改写真实派生值。
--   023 的 task_repos 上无 relative_path CHECK 约束（仅 project_repos 有），故 task_repos 无需调整。
--
-- 不可逆：从 console 端去掉 relative_path 后，原数据信息只剩 name 兜底（COALESCE display_name → name）；
-- 若需回滚，需要业务侧重新收集子仓本机布局。

-- 1) 加列（默认空，回填后再约束 / 也可保持有默认值）
ALTER TABLE project_repos ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT '';
ALTER TABLE project_repos ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';

-- 2) 回填 name：优先用 display_name，空则回退到 relative_path。
UPDATE project_repos
   SET name = COALESCE(NULLIF(display_name, ''), relative_path)
 WHERE name = '';

-- 3) 删旧 UNIQUE(project_id, relative_path)：约束名按 PG 自动命名规则。
ALTER TABLE project_repos DROP CONSTRAINT IF EXISTS project_repos_project_id_relative_path_key;

-- 4) 删旧 CHECK 约束（匿名）：扫 pg_constraint，找到 project_repos 上 CHECK 且 conkey 含 relative_path 列的全删。
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class cls ON cls.oid = con.conrelid
     WHERE cls.relname = 'project_repos'
       AND con.contype = 'c'
       AND EXISTS (
         SELECT 1
           FROM pg_attribute att
          WHERE att.attrelid = con.conrelid
            AND att.attnum = ANY (con.conkey)
            AND att.attname IN ('relative_path', 'role')
       )
  LOOP
    EXECUTE format('ALTER TABLE project_repos DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

-- 5) 新增 UNIQUE(project_id, repo_url)：同项目不重复挂同一仓（主仓的 repo_url 由 syncMainProjectRepo 写）。
ALTER TABLE project_repos
  ADD CONSTRAINT project_repos_project_id_repo_url_key UNIQUE (project_id, repo_url);

-- 6) 重建 role CHECK（仅约束 role 取值，不再校验 relative_path 的值域）。
ALTER TABLE project_repos
  ADD CONSTRAINT project_repos_role_check CHECK (role IN ('main', 'sub'));

-- 7) 删旧列。
ALTER TABLE project_repos DROP COLUMN IF EXISTS relative_path;
ALTER TABLE project_repos DROP COLUMN IF EXISTS display_name;

-- 8) name 现在已全部回填，去掉默认值 + 显式 NOT NULL（DEFAULT '' 已在 ADD 时设；保留默认便于新行）。
--    不强行要求 name 非空字符串，由 console 表单校验。

-- 9) 注释（CLAUDE.md「迁移」章节硬规：新字段必须带 COMMENT ON）。
--    顺便给本期沉淀的语义变化补 / 修注释。
COMMENT ON COLUMN project_repos.name IS 'UI 展示名（主仓行镜像 projects.name；子仓行由用户填，缺省回退到 repo_url basename）';
COMMENT ON COLUMN project_repos.description IS '子仓描述（可选）；主仓行默认空，由 syncMainProjectRepo 维护';
COMMENT ON CONSTRAINT project_repos_project_id_repo_url_key ON project_repos IS '同一项目不可挂同一仓两次（主仓由 syncMainProjectRepo 写）';
-- task_repos.relative_path 语义已变：worker 派生后的本机相对路径快照。
COMMENT ON COLUMN task_repos.relative_path IS '主仓恒 ''.''；子仓为 worker 在本机派生后的相对主仓路径。task 创建时子仓行写占位 ''*-<projectRepoId>''，worker prepare 阶段 UPDATE 改写真实值（不同 worker 上可不一致）';
