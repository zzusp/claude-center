-- 用户 / 角色 / 权限 / 登录会话 / 项目隔离
-- 方案见 docs/spec/auth-rbac.md
--
-- 密码散列与会话 token 全用 pgcrypto（001 已 CREATE EXTENSION）：
--   password_hash = crypt(明文, gen_salt('bf'))，校验用 crypt(输入, hash) = hash
--   session token = encode(gen_random_bytes(32), 'hex')
-- 四个固定角色写死在 packages/db/src/rbac.ts，这里只约束取值。

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'publisher', 'commenter', 'viewer')),
  display_name text NOT NULL DEFAULT '',
  disabled boolean NOT NULL DEFAULT false,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 用户 ↔ 项目分配：非 admin 用户只能看到 / 操作这里关联的项目。
CREATE TABLE IF NOT EXISTS user_project_links (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, project_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token text PRIMARY KEY DEFAULT encode(gen_random_bytes(32), 'hex'),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

-- 引导管理员：admin / admin123。首次登录后请在「用户权限」里重置密码。
INSERT INTO users (username, password_hash, role, display_name)
VALUES ('admin', crypt('admin123', gen_salt('bf')), 'admin', '管理员')
ON CONFLICT (username) DO NOTHING;
