-- minigame1 D1 schema — 玩家 / 流水 / 配置 / 管理员
-- 应用到远程 D1（数据库 mini_game / id ff1c5758-106e-4c96-aa52-7eb19367ca26）：
--   npx wrangler d1 execute mini_game --remote --file=./schema.sql
-- 或在 Cloudflare 网页端 D1 Console 直接粘贴执行（逐段或整段均可）。

-- 玩家表 ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS players (
  tg_id           INTEGER PRIMARY KEY,
  username        TEXT,
  balance         INTEGER NOT NULL DEFAULT 1000,
  free_spins_left INTEGER NOT NULL DEFAULT 3,
  status          TEXT NOT NULL DEFAULT 'active'   -- active / banned
);
-- 老库若已存在 players 但没有 status 列，单独补一列（已存在会报错，可忽略）：
-- ALTER TABLE players ADD COLUMN status TEXT NOT NULL DEFAULT 'active';

-- 流水表（每次抽奖 / 管理员调分写入）---------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id         INTEGER NOT NULL,
  type          TEXT NOT NULL,                    -- spin / admin_grant / admin_deduct
  amount        INTEGER NOT NULL,                 -- 带符号
  balance_after INTEGER NOT NULL,
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tx_tg   ON transactions(tg_id);
CREATE INDEX IF NOT EXISTS idx_tx_time ON transactions(created_at);

-- 游戏配置表（后台 Game Settings 可改，抽奖实时读取）----------------------
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('award_min',     '10'),
  ('award_max',     '200'),
  ('daily_spins',   '3'),
  ('start_balance', '1000');

-- 管理员表（多账号，各自独立用户名 + 密码）------------------------------
-- password 格式：pbkdf2$sha256$<iterations>$<saltHex>$<hashHex>
CREATE TABLE IF NOT EXISTS admins (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT UNIQUE NOT NULL,
  password   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- 第一个店主账号（username: admin），密码见会话中我单独给你的明文。
-- 登录后可在后台「Admins」页自行增删更多管理员、改密码。
INSERT OR IGNORE INTO admins (username, password) VALUES
  ('admin', 'pbkdf2$sha256$100000$d55099d020d8411d4cfb81c654721f0a$d14d75942c02530684f18505ff8becc465123046003460e302365bbee3e16124');
