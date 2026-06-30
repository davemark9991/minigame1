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
  status          TEXT NOT NULL DEFAULT 'active',  -- active / banned
  last_reset      TEXT,                            -- 每日免费次数重置日期 YYYY-MM-DD(UTC)
  player_id       TEXT,                            -- 好记的会员号 PLAY-XXXXXX
  lang            TEXT                             -- 玩家选择的语言 zh / en / ms
);
-- 老库若已存在 players，按需单独补列（已存在会报错，可忽略）：
-- ALTER TABLE players ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
-- ALTER TABLE players ADD COLUMN last_reset TEXT;
-- ALTER TABLE players ADD COLUMN player_id TEXT;
-- ALTER TABLE players ADD COLUMN lang TEXT;

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
-- 下注消耗模式：新玩家初始 0 分，靠后台加分。每游戏的下注额/奖品表由代码默认值兜底，
-- 后台「游戏设置」里可改（存为 <game>_bet / <game>_enabled / <game>_prizes(JSON)）。
INSERT OR IGNORE INTO settings (key, value) VALUES ('start_balance', '0');

-- 客服聊天消息（玩家发给 bot 的文字 <-> 管理员回复）
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id      INTEGER NOT NULL,
  username   TEXT,
  direction  TEXT NOT NULL,                    -- in=玩家发来 / out=管理员回复
  text       TEXT NOT NULL,
  media_type TEXT,                              -- photo / voice / video / document（纯文字为空）
  media_id   TEXT,                              -- Telegram file_id
  tg_msg_id  INTEGER,                            -- Telegram 消息 id（用于撤回/双向删除）
  seen       INTEGER NOT NULL DEFAULT 0,        -- 进站消息管理员是否已读
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- 老库（已有 messages 表）需补列：
-- ALTER TABLE messages ADD COLUMN media_type TEXT;
-- ALTER TABLE messages ADD COLUMN media_id TEXT;
-- ALTER TABLE messages ADD COLUMN tg_msg_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_msg_tg   ON messages(tg_id);
CREATE INDEX IF NOT EXISTS idx_msg_seen ON messages(direction, seen);

-- 定时广播队列（Cron 每分钟扫描 send_at<=now 且 sent=0 的记录群发）
CREATE TABLE IF NOT EXISTS scheduled_broadcasts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT NOT NULL,
  buttons    TEXT,                              -- JSON 数组，快捷按钮
  send_at    TEXT NOT NULL,                      -- UTC 'YYYY-MM-DD HH:MM'
  sent       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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
