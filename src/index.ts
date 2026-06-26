// Telegram Mini App 抽奖机器人 + 后台管理 — Cloudflare Worker (D1)
// GET   /            -> 由静态资源(public/index.html)直接服务游戏 SPA
// GET   /admin.html  -> 由静态资源(public/admin.html)直接服务后台 SPA
// POST  /api/profile -> 校验 initData，返回玩家资料
// POST  /api/spin    -> 校验 initData，扣次数+加积分（读配置区间，写流水）
// POST  /api/admin/* -> 后台 API（账号密码登录 + 会话令牌鉴权）
// POST  其它路径      -> Telegram Webhook（webhook 钉在 /webhook）

export default {
  async fetch(request: Request, env: any, ctx: any): Promise<Response> {
    const db: any = env.DB1 || env.DB;
    const url = new URL(request.url);

    if (request.method === "GET") {
      return new Response("请从 Telegram 内打开游戏 / Open this game inside Telegram.", { status: 200 });
    }

    if (request.method === "POST") {
      const path = url.pathname;
      if (path.startsWith("/api/admin/")) return handleAdmin(request, env, db, path);
      if (path === "/api/profile") return handleProfile(request, env, db);
      if (path === "/api/spin") return handleSpin(request, env, db);
      return handleWebhook(request, env, db, url);   // Telegram webhook
    }

    return new Response("OK");
  }
};

// --------------------------------------------------------------------------- //
// 小工具
// --------------------------------------------------------------------------- //
function jsonResp(obj: any, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

async function readJson(request: Request): Promise<any> {
  try { return await request.json(); } catch (e) { return {}; }
}

function bytesToHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(h: string): Uint8Array {
  const a = new Uint8Array(h.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16);
  return a;
}
function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str: string): Uint8Array {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function ctEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacBytes(keyStr: string, msgStr: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey(
    "raw", enc.encode(keyStr), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msgStr));
  return new Uint8Array(sig);
}

// --------------------------------------------------------------------------- //
// 安全：校验 Telegram WebApp initData (HMAC-SHA256)
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
  const calcHex = bytesToHex(new Uint8Array(calc));
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

async function readInitData(request: Request): Promise<string> {
  try { const b: any = await request.json(); return b.initData || ""; } catch (e) { return ""; }
}

// --------------------------------------------------------------------------- //
// 配置 / 流水
// --------------------------------------------------------------------------- //
async function getSettings(db: any): Promise<any> {
  const def: any = { award_min: 10, award_max: 200, daily_spins: 3, start_balance: 1000 };
  try {
    const res: any = await db.prepare(`SELECT key, value FROM settings`).all();
    for (const r of res.results || []) {
      if (r.key in def) def[r.key] = parseInt(r.value, 10);
    }
  } catch (e) { /* settings 表可能尚未建，用默认值 */ }
  return def;
}

async function logTx(db: any, tg_id: number, type: string, amount: number,
                     balance_after: number, note?: string): Promise<void> {
  try {
    await db.prepare(
      `INSERT INTO transactions (tg_id, type, amount, balance_after, note) VALUES (?, ?, ?, ?, ?)`
    ).bind(tg_id, type, amount, balance_after, note || null).run();
  } catch (e) { /* 记账失败不影响玩家游戏 */ }
}

async function ensurePlayer(db: any, user: any, settings: any): Promise<any> {
  const username = user.username || user.first_name || "神秘玩家";
  await db.prepare(
    `INSERT OR IGNORE INTO players (tg_id, username, balance, free_spins_left) VALUES (?, ?, ?, ?)`
  ).bind(user.id, username, settings.start_balance, settings.daily_spins).run();
  return db.prepare(`SELECT * FROM players WHERE tg_id = ?`).bind(user.id).first();
}

function todayUTC(): string { return new Date().toISOString().slice(0, 10); }

// 每日免费次数自动重置：玩家当天首次访问时，把 free_spins_left 补满到 daily_spins。
// best-effort：若 last_reset 列尚未建，跳过且不影响游戏。
async function applyDailyReset(db: any, p: any, settings: any): Promise<any> {
  if (!p) return p;
  try {
    const today = todayUTC();
    if (p.last_reset !== today) {
      await db.prepare(`UPDATE players SET free_spins_left = ?, last_reset = ? WHERE tg_id = ?`)
        .bind(settings.daily_spins, today, p.tg_id).run();
      p.free_spins_left = settings.daily_spins;
      p.last_reset = today;
    }
  } catch (e) { /* last_reset 列尚未建 */ }
  return p;
}

// --------------------------------------------------------------------------- //
// 玩家 API
// --------------------------------------------------------------------------- //
async function handleProfile(request: Request, env: any, db: any): Promise<Response> {
  const user = await validateInitData(await readInitData(request), env.TELEGRAM_BOT_TOKEN);
  if (!user) return jsonResp({ ok: false, error: "auth" }, 401);
  const settings = await getSettings(db);
  const p: any = await applyDailyReset(db, await ensurePlayer(db, user, settings), settings);
  return jsonResp({
    ok: true,
    username: p ? p.username : (user.username || user.first_name || "玩家"),
    balance: p ? p.balance : 0,
    spins: p ? p.free_spins_left : 0,
    banned: p ? (p.status === "banned") : false
  });
}

async function handleSpin(request: Request, env: any, db: any): Promise<Response> {
  const user = await validateInitData(await readInitData(request), env.TELEGRAM_BOT_TOKEN);
  if (!user) return jsonResp({ ok: false, error: "auth" }, 401);
  const settings = await getSettings(db);
  const p: any = await applyDailyReset(db, await ensurePlayer(db, user, settings), settings);
  if (!p) return jsonResp({ ok: false, error: "no_user" }, 400);
  if (p.status === "banned") return jsonResp({ ok: false, error: "banned", balance: p.balance });
  if (p.free_spins_left <= 0) return jsonResp({ ok: false, error: "no_spins", balance: p.balance });

  const lo = settings.award_min, hi = Math.max(settings.award_min, settings.award_max);
  const award = Math.floor(Math.random() * (hi - lo + 1)) + lo;
  await db.prepare(
    `UPDATE players SET balance = balance + ?, free_spins_left = free_spins_left - 1
     WHERE tg_id = ? AND free_spins_left > 0`
  ).bind(award, user.id).run();

  await logTx(db, user.id, "spin", award, p.balance + award);
  return jsonResp({ ok: true, award, balance: p.balance + award, spins: p.free_spins_left - 1 });
}

// --------------------------------------------------------------------------- //
// 后台：密码哈希 + 会话令牌
// --------------------------------------------------------------------------- //
async function pbkdf2Hex(password: string, saltHex: string, iterations: number): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBytes(saltHex), iterations, hash: "SHA-256" }, keyMaterial, 256);
  return bytesToHex(new Uint8Array(bits));
}
async function hashPassword(password: string): Promise<string> {
  const iterations = 100000;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = bytesToHex(salt);
  const hashHex = await pbkdf2Hex(password, saltHex, iterations);
  return `pbkdf2$sha256$${iterations}$${saltHex}$${hashHex}`;
}
async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = (stored || "").split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2") return false;
  const iterations = parseInt(parts[2], 10);
  const calc = await pbkdf2Hex(password, parts[3], iterations);
  return ctEq(calc, parts[4]);
}

async function signToken(payload: any, key: string): Promise<string> {
  const enc = new TextEncoder();
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = await hmacBytes(key, body);
  return body + "." + b64urlEncode(sig);
}
async function verifyToken(token: string, key: string): Promise<any> {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot), sigPart = token.slice(dot + 1);
  const expected = b64urlEncode(await hmacBytes(key, body));
  if (!ctEq(expected, sigPart)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch (e) { return null; }
}
function sessionKey(env: any): string {
  // 用已有的 bot token 作为服务端签名密钥（永不下发给客户端）
  return env.TELEGRAM_BOT_TOKEN || "minigame1-admin-fallback-key";
}
async function requireAdmin(request: Request, env: any): Promise<any> {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return await verifyToken(token, sessionKey(env));
}

// --------------------------------------------------------------------------- //
// 后台 API 路由
// --------------------------------------------------------------------------- //
async function handleAdmin(request: Request, env: any, db: any, path: string): Promise<Response> {
  if (path === "/api/admin/login") return adminLogin(request, env, db);

  const admin = await requireAdmin(request, env);
  if (!admin) return jsonResp({ ok: false, error: "unauthorized" }, 401);
  const body = await readJson(request);

  try {
    switch (path) {
      case "/api/admin/overview":        return adminOverview(db);
      case "/api/admin/players":         return adminPlayers(db, body);
      case "/api/admin/adjust":          return adminAdjust(db, body, admin);
      case "/api/admin/ban":             return adminBan(db, body);
      case "/api/admin/spins":           return adminSpins(db, body);
      case "/api/admin/player/delete":   return adminPlayerDelete(db, body);
      case "/api/admin/transactions":    return adminTransactions(db, body);
      case "/api/admin/settings/get":    return adminSettingsGet(db);
      case "/api/admin/settings/save":   return adminSettingsSave(db, body);
      case "/api/admin/admins/list":     return adminAdminsList(db);
      case "/api/admin/admins/create":   return adminAdminsCreate(db, body);
      case "/api/admin/admins/delete":   return adminAdminsDelete(db, body, admin);
      case "/api/admin/password":        return adminPassword(db, body, admin);
      default:                           return jsonResp({ ok: false, error: "not_found" }, 404);
    }
  } catch (e: any) {
    return jsonResp({ ok: false, error: "server", detail: String(e && e.message || e) }, 500);
  }
}

async function adminLogin(request: Request, env: any, db: any): Promise<Response> {
  const { username, password } = await readJson(request);
  if (!username || !password) return jsonResp({ ok: false, error: "missing" }, 400);
  const row: any = await db.prepare(`SELECT id, username, password FROM admins WHERE username = ?`)
    .bind(String(username)).first();
  if (!row || !(await verifyPassword(String(password), row.password))) {
    return jsonResp({ ok: false, error: "invalid" }, 401);
  }
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;   // 12 小时
  const token = await signToken({ uid: row.id, username: row.username, exp }, sessionKey(env));
  return jsonResp({ ok: true, token, username: row.username });
}

async function adminOverview(db: any): Promise<Response> {
  const u: any = await db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(balance),0) s FROM players`).first();
  let today = 0;
  try {
    const t: any = await db.prepare(
      `SELECT COUNT(*) c FROM transactions WHERE type='spin' AND date(created_at)=date('now')`).first();
    today = t ? t.c : 0;
  } catch (e) { today = 0; }
  let banned = 0;
  try {
    const bnd: any = await db.prepare(`SELECT COUNT(*) c FROM players WHERE status='banned'`).first();
    banned = bnd ? bnd.c : 0;
  } catch (e) { banned = 0; }
  return jsonResp({
    ok: true,
    users: u ? u.c : 0,
    total_points: u ? u.s : 0,
    today_spins: today,
    banned: banned
  });
}

async function adminPlayers(db: any, body: any): Promise<Response> {
  const q = (body.q || "").trim();
  let rows;
  if (q) {
    const like = `%${q}%`;
    rows = await db.prepare(
      `SELECT tg_id, username, balance, free_spins_left, status FROM players
       WHERE CAST(tg_id AS TEXT) LIKE ? OR username LIKE ?
       ORDER BY balance DESC LIMIT 500`).bind(like, like).all();
  } else {
    rows = await db.prepare(
      `SELECT tg_id, username, balance, free_spins_left, status FROM players
       ORDER BY balance DESC LIMIT 500`).all();
  }
  return jsonResp({ ok: true, players: rows.results || [] });
}

async function adminAdjust(db: any, body: any, admin: any): Promise<Response> {
  const tg_id = parseInt(body.tg_id, 10);
  const amount = parseInt(body.amount, 10);
  const note = (body.note || "").slice(0, 200) || (admin ? `by ${admin.username}` : null);
  if (!tg_id || !amount) return jsonResp({ ok: false, error: "bad_input" }, 400);
  const p: any = await db.prepare(`SELECT balance FROM players WHERE tg_id = ?`).bind(tg_id).first();
  if (!p) return jsonResp({ ok: false, error: "no_user" }, 404);
  const newBal = p.balance + amount;
  if (newBal < 0) return jsonResp({ ok: false, error: "insufficient", balance: p.balance }, 400);
  await db.prepare(`UPDATE players SET balance = ? WHERE tg_id = ?`).bind(newBal, tg_id).run();
  await logTx(db, tg_id, amount >= 0 ? "admin_grant" : "admin_deduct", amount, newBal, note);
  return jsonResp({ ok: true, balance: newBal });
}

async function adminBan(db: any, body: any): Promise<Response> {
  const tg_id = parseInt(body.tg_id, 10);
  const status = body.status === "banned" ? "banned" : "active";
  if (!tg_id) return jsonResp({ ok: false, error: "bad_input" }, 400);
  await db.prepare(`UPDATE players SET status = ? WHERE tg_id = ?`).bind(status, tg_id).run();
  return jsonResp({ ok: true, status });
}

async function adminSpins(db: any, body: any): Promise<Response> {
  const tg_id = parseInt(body.tg_id, 10);
  const spins = Math.max(0, parseInt(body.spins, 10) || 0);
  if (!tg_id) return jsonResp({ ok: false, error: "bad_input" }, 400);
  await db.prepare(`UPDATE players SET free_spins_left = ? WHERE tg_id = ?`).bind(spins, tg_id).run();
  // 同步标记今天已重置，避免玩家当天再次访问时被自动重置覆盖管理员设定的次数
  try {
    await db.prepare(`UPDATE players SET last_reset = ? WHERE tg_id = ?`).bind(todayUTC(), tg_id).run();
  } catch (e) { /* last_reset 列尚未建 */ }
  return jsonResp({ ok: true, spins });
}

async function adminTransactions(db: any, body: any): Promise<Response> {
  const q = (body.q || "").trim();
  const limit = Math.min(200, Math.max(1, parseInt(body.limit, 10) || 50));
  const offset = Math.max(0, parseInt(body.offset, 10) || 0);
  const conds: string[] = [];
  const binds: any[] = [];
  if (q) {
    conds.push(`(CAST(t.tg_id AS TEXT) LIKE ? OR p.username LIKE ? OR t.type LIKE ?)`);
    const like = `%${q}%`; binds.push(like, like, like);
  }
  if (body.from) { conds.push(`date(t.created_at) >= date(?)`); binds.push(body.from); }
  if (body.to)   { conds.push(`date(t.created_at) <= date(?)`); binds.push(body.to); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  // 多取一条用于判断是否还有下一页
  const rows = await db.prepare(
    `SELECT t.id, t.tg_id, p.username, t.type, t.amount, t.balance_after, t.note, t.created_at
     FROM transactions t LEFT JOIN players p ON p.tg_id = t.tg_id
     ${where} ORDER BY t.id DESC LIMIT ? OFFSET ?`).bind(...binds, limit + 1, offset).all();
  const all = rows.results || [];
  const hasMore = all.length > limit;
  return jsonResp({ ok: true, transactions: all.slice(0, limit), hasMore, offset, limit });
}

async function adminPlayerDelete(db: any, body: any): Promise<Response> {
  const tg_id = parseInt(body.tg_id, 10);
  if (!tg_id) return jsonResp({ ok: false, error: "bad_input" }, 400);
  await db.batch([
    db.prepare(`DELETE FROM transactions WHERE tg_id = ?`).bind(tg_id),
    db.prepare(`DELETE FROM players WHERE tg_id = ?`).bind(tg_id)
  ]);
  return jsonResp({ ok: true });
}

// 改密码：传 id 则重置该管理员密码（任意已登录管理员可操作）；
// 不传 id（或 id==自己）则修改自己的密码，需校验 old 当前密码。
async function adminPassword(db: any, body: any, admin: any): Promise<Response> {
  const newPass = String(body.new || "");
  if (newPass.length < 6) return jsonResp({ ok: false, error: "weak", message: "新密码至少 6 位" }, 400);
  const targetId = body.id ? parseInt(body.id, 10) : admin.uid;
  if (targetId === admin.uid) {
    const row: any = await db.prepare(`SELECT password FROM admins WHERE id = ?`).bind(admin.uid).first();
    if (!row || !(await verifyPassword(String(body.old || ""), row.password))) {
      return jsonResp({ ok: false, error: "badold", message: "当前密码不正确" }, 400);
    }
  } else {
    const exists: any = await db.prepare(`SELECT id FROM admins WHERE id = ?`).bind(targetId).first();
    if (!exists) return jsonResp({ ok: false, error: "no_admin", message: "管理员不存在" }, 404);
  }
  const stored = await hashPassword(newPass);
  await db.prepare(`UPDATE admins SET password = ? WHERE id = ?`).bind(stored, targetId).run();
  return jsonResp({ ok: true });
}

async function adminSettingsGet(db: any): Promise<Response> {
  return jsonResp({ ok: true, settings: await getSettings(db) });
}

async function adminSettingsSave(db: any, body: any): Promise<Response> {
  const keys = ["award_min", "award_max", "daily_spins", "start_balance"];
  const stmts: any[] = [];
  for (const k of keys) {
    if (body[k] !== undefined && body[k] !== null && body[k] !== "") {
      const v = String(Math.max(0, parseInt(body[k], 10) || 0));
      stmts.push(db.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(k, v));
    }
  }
  if (stmts.length) await db.batch(stmts);
  return jsonResp({ ok: true, settings: await getSettings(db) });
}

async function adminAdminsList(db: any): Promise<Response> {
  const rows = await db.prepare(`SELECT id, username, created_at FROM admins ORDER BY id`).all();
  return jsonResp({ ok: true, admins: rows.results || [] });
}

async function adminAdminsCreate(db: any, body: any): Promise<Response> {
  const username = (body.username || "").trim();
  const password = String(body.password || "");
  if (username.length < 3 || password.length < 6) {
    return jsonResp({ ok: false, error: "weak", message: "用户名≥3位、密码≥6位" }, 400);
  }
  const exists: any = await db.prepare(`SELECT id FROM admins WHERE username = ?`).bind(username).first();
  if (exists) return jsonResp({ ok: false, error: "exists", message: "用户名已存在" }, 400);
  const stored = await hashPassword(password);
  await db.prepare(`INSERT INTO admins (username, password) VALUES (?, ?)`).bind(username, stored).run();
  return jsonResp({ ok: true });
}

async function adminAdminsDelete(db: any, body: any, admin: any): Promise<Response> {
  const id = parseInt(body.id, 10);
  if (!id) return jsonResp({ ok: false, error: "bad_input" }, 400);
  if (admin && admin.uid === id) return jsonResp({ ok: false, error: "self", message: "不能删除当前登录账号" }, 400);
  const cnt: any = await db.prepare(`SELECT COUNT(*) c FROM admins`).first();
  if (cnt && cnt.c <= 1) return jsonResp({ ok: false, error: "last", message: "至少保留一个管理员" }, 400);
  await db.prepare(`DELETE FROM admins WHERE id = ?`).bind(id).run();
  return jsonResp({ ok: true });
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
        const settings = await getSettings(db);
        await db.prepare(
          `INSERT OR IGNORE INTO players (tg_id, username, balance, free_spins_left) VALUES (?, ?, ?, ?)`
        ).bind(userId, username, settings.start_balance, settings.daily_spins).run();
        const appUrl = url.origin + "/";
        await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId,
          `🎉 欢迎来到霓虹抽奖游戏！\n\n💰 初始积分：${settings.start_balance} 分\n🎁 每日免费抽奖：${settings.daily_spins} 次\n\n点下方按钮进入游戏 👇`,
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
