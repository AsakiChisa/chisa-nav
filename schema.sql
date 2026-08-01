-- Chisa Nav database schema for Cloudflare D1

CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_visible INTEGER NOT NULL DEFAULT 1 CHECK (is_visible IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon_url TEXT NOT NULL DEFAULT '',
  open_in_new_tab INTEGER NOT NULL DEFAULT 1 CHECK (open_in_new_tab IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_visible INTEGER NOT NULL DEFAULT 1 CHECK (is_visible IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  value_type TEXT NOT NULL DEFAULT 'text',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL DEFAULT 100000,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  ip_address TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_address TEXT NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  failed_count INTEGER NOT NULL DEFAULT 0,
  blocked_until TEXT,
  last_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (ip_address, username)
);

CREATE TABLE IF NOT EXISTS ip_whitelist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_address TEXT NOT NULL UNIQUE,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '',
  ip_address TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_groups_sort
  ON groups (sort_order, id);

CREATE INDEX IF NOT EXISTS idx_links_group_sort
  ON links (group_id, sort_order, id);

CREATE INDEX IF NOT EXISTS idx_sessions_expires
  ON sessions (expires_at);

CREATE INDEX IF NOT EXISTS idx_login_attempts_ip
  ON login_attempts (ip_address);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created
  ON audit_logs (created_at DESC);

INSERT OR IGNORE INTO settings (key, value, value_type) VALUES
  ('site_title', '浅咲导航', 'text'),
  ('site_subtitle', '收藏常用网站，快速抵达', 'text'),
  ('greeting_name', '浅咲', 'text'),
  ('default_search_engine', 'google', 'text'),
  ('default_theme', 'auto', 'text'),
  ('background_url', '', 'text'),
  ('card_opacity', '0.78', 'number'),
  ('card_blur', '18', 'number');

INSERT OR IGNORE INTO groups (id, name, description, icon, sort_order, is_visible) VALUES
  (1, '常用网站', '日常最常使用的网站', 'star', 10, 1),
  (2, '我的服务', '个人网站与服务器服务', 'server', 20, 1),
  (3, '开发工具', '代码、文档与开发平台', 'code', 30, 1);
