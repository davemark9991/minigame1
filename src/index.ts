// Telegram Mini App 抽奖机器人 — Cloudflare Worker (D1)
// GET   /            -> 由 Cloudflare 静态资源(public/index.html)直接服务 SPA
// POST  /api/profile -> 校验 initData，返回玩家资料
// POST  /api/spin    -> 校验 initData，扣次数+加积分
// POST  其它路径      -> Telegram Webhook（/start 发送"进入游戏"内嵌按钮）

export default {
  async fetch(request: Request, env: any, ctx: any): Promise<Response> {
    // 兼容两种绑定名：DB1（面板里配置的）或 DB（仓库 wrangler.jsonc 里的）
    const db: any = env.DB1 || env.DB;
    const url = new URL(request.url);

    if (request.method === "GET") {
      // 正常情况下 GET 会被静态资源拦截、返回 public/index.html，不会进到这里。
      // 此为兜底（仅当资源未命中时）。
      return new Response("请从 Telegram 内打开游戏 / Open this game inside Telegram.", { status: 200 });
    }

    if (request.method === "POST") {
      if (url.pathname === "/api/profile") return handleProfile(request, env, db);
      if (url.pathname === "/api/spin") return handleSpin(request, env, db);
      return handleWebhook(request, env, db, url);   // Telegram webhook
    }

    return new Response("OK");
  }
};

// --------------------------------------------------------------------------- //
// 安全：校验 Telegram WebApp initData (HMAC-SHA256)
//   secret = HMAC_SHA256(key="WebAppData", msg=botToken)
//   check  = HMAC_SHA256(key=secret, msg=dataCheckString)
// --------------------------------------------------------------------------- //
async function validateInitData(initData: string, botToken: string): Promise<any> {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const keys = [...params.keys()].sort();
  const dataCheckString = keys.map((k) => k + "=" + params.get(k)).join("\n");

  const enc = new TextEncoder();
  const kSecret = await crypto.subtle.importKey(
    "raw", enc.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const secret = await crypto.subtle.sign("HMAC", kSecret, enc.encode(botToken));
  const kCalc = await crypto.subtle.importKey(
    "raw", new Uint8Array(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const calc = await crypto.subtle.sign("HMAC", kCalc, enc.encode(dataCheckString));
  const calcHex = [...new Uint8Array(calc)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (calcHex !== hash) return null;

  const authDate = parseInt(params.get("auth_date") || "0", 10);
  if (Date.now() / 1000 - authDate > 86400) return null;   // 24h 防重放

  try {
    const user = JSON.parse(params.get("user") || "{}");
    return user && user.id ? user : null;
  } catch (e) {
    return null;
  }
}

function jsonResp(obj: any, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

async function readInitData(request: Request): Promise<string> {
  try { const b: any = await request.json(); return b.initData || ""; } catch (e) { return ""; }
}

async function ensurePlayer(db: any, user: any): Promise<any> {
  const username = user.username || user.first_name || "神秘玩家";
  await db.prepare(`INSERT OR IGNORE INTO players (tg_id, username) VALUES (?, ?)`)
    .bind(user.id, username).run();
  return db.prepare(`SELECT * FROM players WHERE tg_id = ?`).bind(user.id).first();
}

// --------------------------------------------------------------------------- //
// API
// --------------------------------------------------------------------------- //
async function handleProfile(request: Request, env: any, db: any): Promise<Response> {
  const user = await validateInitData(await readInitData(request), env.TELEGRAM_BOT_TOKEN);
  if (!user) return jsonResp({ ok: false, error: "auth" }, 401);
  const p: any = await ensurePlayer(db, user);
  return jsonResp({
    ok: true,
    username: p ? p.username : (user.username || user.first_name || "玩家"),
    balance: p ? p.balance : 0,
    spins: p ? p.free_spins_left : 0
  });
}

async function handleSpin(request: Request, env: any, db: any): Promise<Response> {
  const user = await validateInitData(await readInitData(request), env.TELEGRAM_BOT_TOKEN);
  if (!user) return jsonResp({ ok: false, error: "auth" }, 401);
  const p: any = await ensurePlayer(db, user);
  if (!p) return jsonResp({ ok: false, error: "no_user" }, 400);
  if (p.free_spins_left <= 0) return jsonResp({ ok: false, error: "no_spins", balance: p.balance });

  const award = Math.floor(Math.random() * 191) + 10;
  // 带守卫的扣减，避免并发抽到负数
  await db.prepare(
    `UPDATE players SET balance = balance + ?, free_spins_left = free_spins_left - 1
     WHERE tg_id = ? AND free_spins_left > 0`
  ).bind(award, user.id).run();

  return jsonResp({ ok: true, award, balance: p.balance + award, spins: p.free_spins_left - 1 });
}

// --------------------------------------------------------------------------- //
// Telegram Webhook
// --------------------------------------------------------------------------- //
async function handleWebhook(request: Request, env: any, db: any, url: URL): Promise<Response> {
  try {
    const update: any = await request.json();
    if (update.message) {
      const msg = update.message;
      const chatId = msg.chat.id;
      const text = msg.text || "";
      const userId = msg.from.id;
      const username = msg.from.username || msg.from.first_name || "神秘玩家";

      if (text.startsWith("/start")) {
        await db.prepare(`INSERT OR IGNORE INTO players (tg_id, username) VALUES (?, ?)`)
          .bind(userId, username).run();
        const appUrl = url.origin + "/";   // Mini App = 本 Worker 的根地址
        await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId,
          `🎉 欢迎来到霓虹抽奖游戏！\n\n💰 初始积分：1000 分\n🎁 每日免费抽奖：3 次\n\n点下方按钮进入游戏 👇`,
          { inline_keyboard: [[{ text: "🚀 进入游戏", web_app: { url: appUrl } }]] });
      } else if (text.startsWith("/profile")) {
        const p: any = await db.prepare(`SELECT * FROM players WHERE tg_id = ?`).bind(userId).first();
        if (p) {
          await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId,
            `👤 【${p.username}】\n💰 积分：${p.balance} 分\n🎁 剩余次数：${p.free_spins_left} 次`);
        } else {
          await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `❌ 请先输入 /start 激活。`);
        }
      }
    }
  } catch (e) {
    // 容错处理
  }
  return new Response("OK");
}

async function sendMessage(token: string, chatId: number, text: string, replyMarkup?: any): Promise<void> {
  if (!token) return;
  const body: any = { chat_id: chatId, text: text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}
