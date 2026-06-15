-- worker 终端配置（桌面端设置，入库供 web 展示）+ web 端可设置的友好显示名（label）。
-- label 为 null 表示未重命名，UI 显示 name；set 后取 label 优先。worker 重注册不覆盖 label。
ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS terminal_command   text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS claude_pre_command text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS label              text;
