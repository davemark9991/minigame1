# 开一个新 Telegram Bot（完整部署手册）

> 用这份文档可以从零把整套系统（Telegram 小游戏 + JILI 老虎机 + 后台）复制成**另一个 bot**。
> 所有密钥都用 `<占位符>`，请换成你**新 bot 的**真实值，不要照抄旧的。

---

## 0. 这套系统是什么

- **前端**：Telegram Mini App（H5 单页），玩家在 bot 里打开。
  - 迷你游戏（转盘 / 弹珠 / 砸蛋 / 刮刮乐 / 点球 / 石头剪刀布）用**积分 Points**。
  - JILI 老虎机（283 款）用**存款余额 Deposit Balance**（真钱），在 App 内嵌打开。
- **后端**：Cloudflare **Worker**（TypeScript，单文件 `src/index.ts`）。
- **数据库**：Cloudflare **D1**（SQLite）。
- **静态资源**：`public/`（`index.html` 游戏、`admin.html` 后台、`sw.js` 等）。
- **部署**：GitHub 推送 → **Workers Builds** 自动部署（无需手动 deploy）。
- **入口**：
  - 游戏 `https://<worker>.workers.dev/`
  - 后台 `https://<worker>.workers.dev/admin`
  - Webhook `https://<worker>.workers.dev/webhook`（注意：**不是根路径**，根路径被静态资源占用返回 405）

---

## 1. 你需要准备

| 项目 | 说明 |
|---|---|
| Cloudflare 账号 | 建 Worker + D1（免费额度够用） |
| GitHub 账号 | 放代码，接 Workers Builds 自动部署 |
| Telegram bot | 找 [@BotFather](https://t.me/BotFather) 新建，拿 **Bot Token** |
| Node + wrangler | 本地跑命令：`npm i -g wrangler`（或用 `npx wrangler`） |
| JILI 代理 | 找 JILI 商务开代理，拿 **AgentId / AgentKey / API 域名**，并确认是 **Transfer Wallet（转账钱包）模式** |

---

## 2. 建 Telegram Bot（BotFather）

1. `/newbot` → 起名 → 拿到 **Bot Token**（形如 `1234567890:AA...`）。
2. `/setmenubutton`（或 bot 设置里 Menu Button）→ 设成 Web App，URL 填 `https://<worker>.workers.dev/`。
3. 可选：`/setdescription`、`/setuserpic` 美化。

> 一个 AgentKey 下玩家账号唯一。本系统给每个玩家在 JILI 建的账号是 `mg<telegram_id>`。

---

## 3. 代码

Fork 或复制 `davemark9991/minigame1` 到你自己的 GitHub 仓库。关键文件：
```
src/index.ts          # 整个后端（路由、游戏、JILI、后台 API）
public/index.html     # 游戏前端
public/admin.html     # 后台前端
public/sw.js          # PWA service worker（改缓存版本号可强制刷新）
schema.sql            # 建表 SQL
wrangler.jsonc        # Worker 配置
```

---

## 4. Cloudflare：建 D1 + Worker + Workers Builds

### 4.1 建 D1
```bash
npx wrangler d1 create <your_db_name>
```
记下返回的 **database_id**。

### 4.2 wrangler.jsonc
把 `name` 和 D1 binding 改成你的：
```jsonc
{
  "name": "<your-worker-name>",
  "main": "src/index.ts",
  "compatibility_date": "2024-xx-xx",
  "assets": { "directory": "./public" },
  "d1_databases": [
    { "binding": "DB", "database_name": "<your_db_name>", "database_id": "<你的 database_id>" }
  ]
}
```
> 代码里用 `env.DB` 访问数据库，binding 名必须是 **DB**。

### 4.3 接 Workers Builds（自动部署）
Cloudflare 后台 → Workers & Pages → Create → **Connect to Git** → 选你的仓库 → 分支 `main`。
以后每次 `git push` 就自动部署。

---

## 5. Secrets（密钥）

⚠️ **重要坑**：Workers Builds 每次部署会**清空**你在网页后台手动加的 Secret / 变量。
所以本系统把 **JILI 配置放进 D1 数据库**（部署不会清），只有下面这一个必须用 secret：

| 名称 | 说明 | 怎么设 |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | bot token，服务端验签 initData / 发消息 / 收 webhook 都要它 | 见下 |
| `EXT_API_KEY`（可选） | 公司对接 API 的鉴权 key，不接可不设 | 同下 |

设 secret（本地 wrangler 需登录到**拥有该 Worker 的账号**）：
```bash
npx wrangler login
npx wrangler secret put TELEGRAM_BOT_TOKEN
# 粘贴你的 bot token
```
> 如果 wrangler 登录的账号和 Worker 所在账号不一致，会报 `Authentication error 10000`。
> 也可在 Cloudflare 网页后台 Worker → Settings → Variables and Secrets 里加（记得选 **Secret**）。

---

## 6. 建表 + 迁移

### 6.1 建基础表
在 Cloudflare 网页后台 **D1 → 你的库 → Console**，粘贴 `schema.sql` 全部内容执行；
或本地：
```bash
npx wrangler d1 execute <your_db_name> --remote --file=./schema.sql
```

### 6.2 补齐 players 列（关键）
`CREATE TABLE IF NOT EXISTS` 不会给旧表补列。部署好后，**登录后台**（第 8 步），拿到 token，调一次迁移接口自动补齐所有列：
```bash
curl -X POST https://<worker>.workers.dev/api/admin/migrate \
  -H "Authorization: Bearer <admin_token>" -H "Content-Type: application/json" -d '{}'
```
它会幂等地给 `players` 加：`status / last_reset / player_id / lang / company_name / total_deposit / cash_balance`。
> 只加列、默认 0/空，**不动任何现有余额**。

---

## 7. 设 Webhook + Mini App

部署好后设 webhook（指向 `/webhook`，不是根路径）：
```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<worker>.workers.dev/webhook"
```
检查：
```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```
> 若 webhook 老是被清空，多半是本地跑了 `getUpdates` 轮询把它顶掉了——停掉本地轮询即可。

玩家在 bot 里点 `/start` → 选语言 → 点菜单按钮进游戏。

---

## 8. 后台登录 + 改密码

- 地址：`https://<worker>.workers.dev/admin`
- 初始账号：`admin`，密码见 `schema.sql` 里 `admins` 表插入的那一行（pbkdf2 哈希对应的明文由你首次部署时设定）。
- **务必登录后在「管理员」页改密码 / 加你自己的管理员账号。**

拿 token（脚本里要用）：
```bash
curl -s -X POST https://<worker>.workers.dev/api/admin/login \
  -H "Content-Type: application/json" -d '{"username":"admin","password":"<你的密码>"}'
```

---

## 9. 接 JILI（转账钱包）

JILI 配置存在 **D1 settings**（部署不会清），在**后台调接口**写入即可（不用碰 Cloudflare 密钥）：

```bash
curl -X POST https://<worker>.workers.dev/api/admin/jili/config/save \
  -H "Authorization: Bearer <admin_token>" -H "Content-Type: application/json" \
  -d '{
    "api_base":"https://wb-api-2.xxxx.com/api1,https://wb-api-2.yyyy.com/api1",
    "agent_id":"<你的 AgentId>",
    "agent_key":"<你的 AgentKey>",
    "game_id":"49"
  }'
```
- `api_base`：JILI 给的 **API 域名**（可填多个镜像，逗号分隔，自动故障切换）。注意结尾是 `/api1`。
- `game_id`：默认进入的游戏（`49` = Super Ace）。

**验证连通**（只读，不搬钱）：
```bash
curl -X POST https://<worker>.workers.dev/api/admin/jili/games \
  -H "Authorization: Bearer <admin_token>" -H "Content-Type: application/json" -d '{}'
```
回 `"ok":true` + 一堆游戏 = 通了。

**签名算法**（代码里已实现，供参考）：
- `KeyG = MD5( yyMMd(UTC-4 当下时间, 日不补0) + AgentId + AgentKey )`
- `Key = 6随机字符 + MD5(参数串&AgentId=xxx + KeyG) + 6随机字符`
- Cloudflare Worker 支持 `crypto.subtle.digest("MD5")`。

**真钱进出**（Transfer Wallet）：进游戏时 `ExchangeTransferByAgentId type=2` 把存款余额转入 JILI，退出时 `type=1` 全部转回。
> ⚠️ 若转账接口回 `ErrorCode 4 service unavailable`，说明你的代理是 **Seamless 模式**，要找 JILI **改成 Transfer Wallet 模式**。
> ⚠️ 若调用被挡，可能要 JILI 把 **Worker 出口 IP 加白名单**。

**游戏封面图**：`https://cdn.vefrop.com/games/jili/<gameId>.png`（前端已自动用）。

---

## 10. 主题 / LOGO

后台「游戏设置 → 🎨 品牌/主题」填 **JILI LOGO 图片直链**：
- 建议：**透明底 PNG，正方形 240×240**，前台展示约 56px。
- 不填则前台显示金色「JILI」文字标。

---

## 11. 数据库结构（D1）

| 表 | 用途 | 关键列 |
|---|---|---|
| `players` | 玩家 | `tg_id`(PK), `balance`(积分), `cash_balance`(存款余额,可玩JILI), `total_deposit`(累计存款→VIP), `player_id`(会员号), `lang`, `company_name`, `status` |
| `transactions` | 流水 | `type`(spin/deposit/withdraw/slot_in/slot_out/admin_grant/...), `amount`(带符号), `balance_after`, `note` |
| `settings` | 配置(键值) | `start_balance`, `vip_thresholds`, `vip_names`, `vip_benefits`, `jili_api_base/agent_id/agent_key/game_id`, `theme_jili_logo` |
| `messages` | 客服聊天 | `direction`(in/out), `text`, `media_type/media_id`, `tg_msg_id`(去重/撤回) |
| `deposits` | 充值记录 | `amount`, `points`, `staff` |
| `api_customers` | 公司对接顾客 | `company_name`(PK), `pending_points/deposit`, `tg_id` |
| `scheduled_broadcasts` | 定时广播 | `text`, `send_at`, `sent` |
| `admins` | 管理员 | `username`, `password`(pbkdf2) |

---

## 12. API 一览

**玩家端**（POST，body 带 `initData` 验签）：
- `/api/profile` 资料 + 双钱包 + VIP + theme
- `/api/spin` 迷你游戏下注派彩（`{game}`）
- `/api/history` 本人流水（`{category: mini|slot|deposit}`）
- `/api/slot/games` JILI 老虎机列表
- `/api/slot/launch` 取游戏登入网址（转钱进 JILI）
- `/api/slot/settle` 退出结算（JILI 余额转回存款余额）

**后台**（POST，Header `Authorization: Bearer <token>`，前缀 `/api/admin/`）：
- `login` / `overview` / `players` / `adjust`(积分) / `cash/adjust`(存/提款) / `ban` / `player/delete`
- `transactions` / `deposits/list` / `deposits/add`
- `migrate`（补列） / `settings/get|save` / `config/get|save`（欢迎语等）
- `theme/get|save` / `jili/config/get|save` / `jili/games` / `jili/member`
- `chat/*`（客服）/ `broadcast/*`（广播）/ `admins/*` / `password`
- `link` / `apic/*`（公司对接）

**公司对接**（Header `X-API-Key: <EXT_API_KEY>`）：
- `/api/ext/credit` 按 `company_name` 给玩家转分/加存款
- `/api/ext/balance` 查余额

**Webhook**：`/webhook`（Telegram POST）

---

## 13. 日常运营（后台）

- **加/扣积分**：玩家管理 → ➕分 / ➖分（迷你游戏用）。
- **存款/提款**：玩家管理 → 💵存 / 💸提（存款余额，玩 JILI 用）。
- **封禁 / 删除 / 明细**：玩家管理每行按钮。
- **客服聊天**：收发文字/图片/语音，可撤回。
- **广播**：群发（可定时，Cron 每分钟扫描发送）。
- **游戏设置**：每游戏下注额 + 奖品档位 + 权重（EV 显示庄家盈亏）。
- **VIP**：`vip_thresholds`（4 个阈值分 5 档）+ `vip_names` + `vip_benefits`（每档 3 条）。

---

## 14. 踩过的坑（务必知道）

1. **部署清空密钥**：Workers Builds 每次部署会清掉网页后台加的 Secret/变量 → 所以 JILI 配置放 D1（`jili/config/save`），别放 Cloudflare 密钥。`TELEGRAM_BOT_TOKEN` 用 `wrangler secret put` 设（这个不会被清）。
2. **旧表缺列**：`CREATE TABLE IF NOT EXISTS` 不补列，务必调 `/api/admin/migrate` 补齐。
3. **JILI 钱包模式**：转账接口回 `ErrorCode 4` = 你的代理是 Seamless，要找 JILI 改 Transfer Wallet。
4. **API 域名 ≠ 后台域名**：JILI 给的登录后台网址不是 API，API 域名要单独问商务（形如 `https://wb-api-2.xxx.com/api1`）。
5. **Webhook 路径**：必须 `/webhook`，根路径 405。别在本地跑 getUpdates 轮询（会顶掉 webhook）。
6. **前端缓存**：手机看不到更新时，改 `public/sw.js` 的 `CACHE` 版本号，或让玩家彻底关掉小程序重开。
7. **D1 读副本延迟**：刚建的玩家立刻查可能读不到（副本延迟），业务里等 1~2 秒或重试。
8. **git 推送账号**：远程用 `https://<你的用户名>@github.com/<你>/<repo>.git`，避免推错账号 403。
9. **提交信息署名**：本项目提交以 `Co-Authored-By: Claude` 结尾。

---

## 15. 常用命令

```bash
# 本地校验构建（不部署）
npx wrangler deploy --dry-run

# 部署（一般靠 git push 自动部署；手动也行）
git add -A && git commit -m "..." && git push origin main

# 设 webhook
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<worker>.workers.dev/webhook"

# 后台登录拿 token
curl -s -X POST https://<worker>.workers.dev/api/admin/login \
  -H "Content-Type: application/json" -d '{"username":"admin","password":"<pw>"}'

# 补数据库列
curl -X POST https://<worker>.workers.dev/api/admin/migrate -H "Authorization: Bearer <token>" -d '{}'
```

---

### 一句话开新 bot 顺序
BotFather 建 bot → fork 仓库 → 建 D1 + 改 wrangler.jsonc → 接 Workers Builds → `wrangler secret put TELEGRAM_BOT_TOKEN` → 跑 schema.sql → 部署后调 `/api/admin/migrate` → 设 webhook → 后台改密码 → `jili/config/save` 接 JILI → 填主题 logo → 开玩。
