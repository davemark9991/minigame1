# 霓虹游戏厅 + 管理后台 — 完整复刻手册（REBUILD GUIDE）

> 本文档让你从零搭建一套**一模一样**的系统（Telegram 下注游戏 Mini App + 网页管理后台 + 客服聊天 + 广播）。
> 现有线上实例：`https://minigame1.davemark9991.workers.dev`（Worker 名 `minigame1`，D1 名 `mini_game`）。
> 复刻 = 新建一个 Telegram 机器人 + 新 D1 + 新 Worker，代码沿用同一个仓库。

---

## 1. 架构总览

```
玩家(Telegram) ──/start、消息──▶  Telegram 服务器 ──webhook POST /webhook──▶  Cloudflare Worker (src/index.ts)
玩家点"进入游戏" ─Mini App─▶ GET / ─Cloudflare 静态资源─▶ public/index.html(游戏 SPA)
                                                          │
管理员(浏览器/手机PWA) ─GET /admin─▶ public/admin.html ──POST /api/admin/*──▶ 同一个 Worker
                                                          │
                                                          ▼
                                                  Cloudflare D1 (SQLite)
                                                  players / transactions / messages / settings / admins / scheduled_broadcasts
Cron(每分钟) ──▶ Worker.scheduled() ──▶ 发送到期的定时广播
```

- **一个 Worker 同时**：① 服务游戏页和后台页（静态资源）② 处理玩家 API（/api/profile、/api/spin）③ 处理后台 API（/api/admin/*）④ 处理 Telegram webhook（POST /webhook）⑤ Cron 定时广播。
- **经济模型 = 下注消耗**：新玩家 0 分，靠后台加分；每局扣下注额、按该游戏的奖品表（权重）派彩。
- **鉴权**：玩家用 Telegram `initData` 的 HMAC-SHA256 验签；后台用账号密码（PBKDF2）+ 会话令牌（HMAC，密钥复用 bot token）。

---

## 2. 文件结构（代码全部在 GitHub 仓库里）

| 文件 | 作用 |
|------|------|
| `src/index.ts` | Worker 全部后端逻辑（游戏 API + 后台 API + webhook + cron） |
| `public/index.html` | 游戏大厅 SPA（4 个游戏：转盘/弹珠/砸金蛋/刮刮乐） |
| `public/admin.html` | 管理后台 SPA（总览/玩家/流水/客服/设置/管理员） |
| `public/sw.js` | PWA Service Worker（离线外壳） |
| `public/manifest-game.webmanifest` / `manifest-admin.webmanifest` | PWA 安装清单 |
| `public/icon-game.svg` / `icon-admin.svg` | App 图标 |
| `schema.sql` | 完整数据库建表脚本 |
| `wrangler.jsonc` | Worker 配置（main、D1 绑定、静态资源、Cron） |

**复刻第一步**：把现有仓库克隆/复制成一个新仓库即可拿到全部代码（代码本身无需改动，差异只在"配置"）：
```bash
git clone https://github.com/davemark9991/minigame1.git my-new-game
cd my-new-game
# 然后推到你自己的新 GitHub 仓库
```

---

## 3. 准备工作（Prerequisites）

1. **Cloudflare 账号**（免费版即可起步）。
2. **GitHub 账号**（用于 Workers Builds 自动部署）。
3. **Telegram 机器人**：在 Telegram 找 **@BotFather** → `/newbot` → 拿到 **bot token**（形如 `123456:AAxxxx`）。
4. 本机装 **Node.js**（用于生成首个管理员密码哈希）。

---

## 4. 一步步搭建新实例

### 4.1 创建 D1 数据库
Cloudflare Dashboard → **Storage & Databases → D1 → Create**，命名如 `mini_game`，记下 **database_id**。

### 4.2 建表
进该 D1 的 **Console**，把第 7 节的 `schema.sql` **整段粘贴执行**（含首个管理员）。

### 4.3 创建 Worker（连 GitHub 自动部署）
Cloudflare → Workers & Pages → **Create → Connect to Git** → 选你的新仓库。
- 它会读取 `wrangler.jsonc` 自动部署，Worker 名取自 `wrangler.jsonc` 的 `name`（改成你要的名字，如 `mygame`）。
- 部署后地址为 `https://<worker名>.<你的子域>.workers.dev`。

> `wrangler.jsonc` 里 **`database_id` 改成 4.1 里你自己的**；`name` 改成你的 Worker 名。

### 4.4 绑定 D1
Worker → **Settings → Bindings → Add → D1**：变量名填 **`DB`**，选你的 `mini_game`。
> 代码用 `env.DB1 || env.DB`，所以变量名用 `DB` 即可；**不要**额外加名为 `DB1` 的"明文变量"（会顶掉真数据库导致 500）。

### 4.5 配置 Bot Token（密文）
Worker → **Settings → Variables and Secrets → Add → Secret**：
- 名称 **`TELEGRAM_BOT_TOKEN`**，值 = 你的 bot token。

### 4.6 设置 webhook（关键：用 `/webhook`，不要用根 `/`）
> 根 `/` 会被静态资源拦截返回 405，所以 webhook 必须钉在 `/webhook`。
```bash
curl "https://api.telegram.org/bot<你的TOKEN>/setWebhook" \
  --data-urlencode "url=https://<你的Worker地址>/webhook" \
  --data-urlencode "drop_pending_updates=true"
# 验证
curl "https://api.telegram.org/bot<你的TOKEN>/getWebhookInfo"
```

### 4.7 开通 Cron（定时广播）
`wrangler.jsonc` 已含 `"triggers": { "crons": ["* * * * *"] }`，部署后在 Worker → **Settings → Triggers** 可见。

### 4.8 验收
- Telegram 给机器人发 `/start` → 收到欢迎 + "进入游戏" 按钮。
- 打开 `https://<你的Worker地址>/admin` → 用首个管理员登录（见 4.9）→ 给自己加分 → 进游戏下注。

### 4.9 首个管理员账号
默认 `schema.sql` 里内置了一个 `admin` 账号，**但密码哈希是现有实例的，你必须换成自己的**。用第 8 节脚本生成你自己的哈希，替换 `INSERT INTO admins...` 那行，再执行。登录后到「管理员」页可增删账号、改密码。

---

## 5. 后台设置项（settings 表，key→value）

| key | 含义 | 默认 |
|-----|------|------|
| `start_balance` | 新玩家初始积分 | `0` |
| `<game>_bet` | 该游戏每局下注额（game ∈ wheel/plinko/egg/scratch） | 50/50/100/50 |
| `<game>_enabled` | 是否启用（`1`/`0`） | `1` |
| `<game>_prizes` | 奖品表 JSON：`[{type:"fixed",value,weight,label}\|{type:"range",min,max,weight,label}]` | 代码内置默认表 |
| `welcome_text` | /start 欢迎语（空＝默认） | 空 |
| `autoreply` | 关键词自动回复 JSON：`[{kw,reply}]` | 空 |
| `qr_url` | 充值二维码图片直链 | 空 |

> 这些都在后台「游戏设置」「⚙️ 自动回复/配置」里图形化编辑，无需手改数据库。

---

## 6. API 端点速查

**玩家端**（需 Telegram initData）
- `POST /api/profile` → 资料/余额
- `POST /api/spin` `{initData, game}` → 下注派彩

**后台端**（`POST /api/admin/*`，除 login 外需 `Authorization: Bearer <token>`）
- `login` `{username,password}` → `{token}`
- `overview` / `players` / `adjust` / `ban` / `player/delete`
- `transactions` `{q,from,to,offset,limit}`
- `settings/get` · `settings/save`
- `config/get` · `config/save`
- `admins/list` · `admins/create` · `admins/delete` · `password`
- `chat/list` · `chat/thread` · `chat/send`（`{buttons,remove_keyboard}`）· `chat/photo` · `chat/unread`
- `broadcast`（分批 `{offset,limit}`）· `broadcast/schedule` · `broadcast/scheduled` · `broadcast/cancel`

**webhook**：`POST /webhook`（Telegram 调用）

---

## 7. 完整 schema.sql（整段粘贴到新 D1 的 Console）

```sql
-- 玩家
CREATE TABLE IF NOT EXISTS players (
  tg_id INTEGER PRIMARY KEY,
  username TEXT,
  balance INTEGER NOT NULL DEFAULT 0,
  free_spins_left INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  last_reset TEXT
);
-- 流水
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tx_tg ON transactions(tg_id);
CREATE INDEX IF NOT EXISTS idx_tx_time ON transactions(created_at);
-- 配置
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO settings (key,value) VALUES ('start_balance','0');
-- 客服消息
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL, username TEXT,
  direction TEXT NOT NULL, text TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_msg_tg ON messages(tg_id);
CREATE INDEX IF NOT EXISTS idx_msg_seen ON messages(direction, seen);
-- 管理员（password 格式 pbkdf2$sha256$迭代$saltHex$hashHex，用第8节脚本生成你自己的）
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- 把下面这行的哈希换成你自己生成的：
INSERT OR IGNORE INTO admins (username,password) VALUES
  ('admin','在这里粘贴你用第8节脚本生成的哈希');
-- 定时广播
CREATE TABLE IF NOT EXISTS scheduled_broadcasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL, buttons TEXT,
  send_at TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

---

## 8. 生成首个管理员密码哈希（本机跑一次）

新建 `genadmin.mjs`：
```js
import crypto from 'crypto';
const username = 'admin';
const password = '换成你要的强密码';
const iter = 100000, salt = crypto.randomBytes(16);
const dk = crypto.pbkdf2Sync(password, salt, iter, 32, 'sha256');
const stored = `pbkdf2$sha256$${iter}$${salt.toString('hex')}$${dk.toString('hex')}`;
console.log("用户名:", username);
console.log("密码:", password);
console.log("INSERT:", `INSERT OR IGNORE INTO admins (username,password) VALUES ('${username}','${stored}');`);
```
运行 `node genadmin.mjs`，把打印的 INSERT 语句放进第 7 节替换那一行。

---

## 9. 常见坑（按重要性）

1. **webhook 必须用 `/webhook`**，不能用根 `/`（根命中 index.html → 静态资源对 POST 回 405，消息进不来）。
2. **不要建名为 `DB1` 的明文变量**（值会顶掉真 D1 绑定 → `db.prepare` 报错 → 500）。绑定名用 `DB`。
3. **`TELEGRAM_BOT_TOKEN` 要配在正确的 Worker 上**（就是跑游戏代码那个）。缺它 → 玩家 API 401、机器人不回话。
4. 老库加列要单独 `ALTER`（`CREATE TABLE IF NOT EXISTS` 不会给已存在的表补列）。
5. 改完代码 **git push 即自动部署**；浏览器/PWA 有缓存，更新后 `Ctrl+Shift+R` 强刷或重装主屏图标。
6. 时间统一存 UTC，前端按设备时区显示。

---

## 10. 可扩展（尚未内置，需要可加）

- **聊天收发 语音/图片/视频**：见仓库 issue 或让维护者加（需 webhook 处理 `photo/voice/video`、加一个带 token 的媒体代理端点、后台 sendPhoto/sendVideo/sendVoice）。
- **游戏脱离 Telegram 独立登录**（手机号/账号密码 + 自有验签）。
- **充值审核流程、玩家分组广播、加分快捷金额**。

---
_最后更新：随仓库版本。代码以 GitHub 仓库为准，本文档负责"如何把它部署成一套新的"。_
