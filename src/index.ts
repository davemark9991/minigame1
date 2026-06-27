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
  },

  // Cron：发送到期的定时广播（每分钟触发，见 wrangler.jsonc triggers.crons）
  async scheduled(event: any, env: any, ctx: any): Promise<void> {
    const db: any = env.DB1 || env.DB;
    try {
      const now = new Date().toISOString().slice(0, 16).replace("T", " ");   // UTC 'YYYY-MM-DD HH:MM'
      const due: any = await db.prepare(
        `SELECT id, text, buttons FROM scheduled_broadcasts WHERE sent = 0 AND send_at <= ? ORDER BY id LIMIT 5`).bind(now).all();
      for (const b of (due.results || [])) {
        let buttons: any = [];
        try { buttons = JSON.parse(b.buttons || "[]"); } catch (e) {}
        const markup = buildReplyKeyboard(buttons);
        const rows: any = await db.prepare(`SELECT tg_id FROM players WHERE status != 'banned'`).all();
        for (const p of (rows.results || [])) {
          try { await sendMessage(env.TELEGRAM_BOT_TOKEN, p.tg_id, b.text, markup); } catch (e) {}
        }
        await db.prepare(`UPDATE scheduled_broadcasts SET sent = 1 WHERE id = ?`).bind(b.id).run();
      }
    } catch (e) {}
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
const GAME_DEFS = [
  { key: "wheel",   label: "🎡 幸运大转盘", bet: 50 },
  { key: "plinko",  label: "🔵 普林科弹珠", bet: 50 },
  { key: "egg",     label: "🥚 砸金蛋",     bet: 100 },
  { key: "scratch", label: "🎫 刮刮乐",     bet: 50 }
];
const GAME_KEYS = GAME_DEFS.map((g) => g.key);

// 默认奖品表（后台可改）。type: fixed=固定分 / range=区间随机分；weight=中奖权重。
function defaultPrizes(): any[] {
  return [
    { type: "fixed", value: 0,   weight: 35, label: "谢谢参与" },
    { type: "fixed", value: 30,  weight: 25, label: "小奖" },
    { type: "fixed", value: 60,  weight: 18, label: "回本" },
    { type: "range", min: 80,  max: 150, weight: 13, label: "中奖" },
    { type: "range", min: 180, max: 350, weight: 7,  label: "大奖" },
    { type: "fixed", value: 600, weight: 2,  label: "超级大奖" }
  ];
}

function sanitizePrizes(raw: any): any[] {
  if (!Array.isArray(raw)) return [];
  const out: any[] = [];
  for (const p of raw) {
    const weight = Math.max(0, parseInt(p.weight, 10) || 0);
    if (weight <= 0) continue;
    const label = String(p.label || "").slice(0, 20);
    if (p.type === "range") {
      const min = Math.max(0, parseInt(p.min, 10) || 0);
      const max = Math.max(min, parseInt(p.max, 10) || min);
      out.push({ type: "range", min, max, weight, label });
    } else {
      const value = Math.max(0, parseInt(p.value, 10) || 0);
      out.push({ type: "fixed", value, weight, label });
    }
  }
  return out;
}

// 按权重随机抽一个奖品，返回 {award 分值, label 奖品名}
function pickPrize(prizes: any[]): { award: number; label: string } {
  const valid = (prizes && prizes.length) ? prizes : defaultPrizes();
  const total = valid.reduce((s, p) => s + (p.weight || 0), 0);
  if (total <= 0) return { award: 0, label: "" };
  let roll = Math.random() * total;
  for (const p of valid) {
    roll -= p.weight;
    if (roll <= 0) {
      const award = p.type === "range"
        ? Math.floor(Math.random() * (p.max - p.min + 1)) + p.min : p.value;
      return { award, label: p.label || "" };
    }
  }
  const last = valid[valid.length - 1];
  return { award: last.type === "range" ? last.min : last.value, label: last.label || "" };
}

async function getSettings(db: any): Promise<any> {
  const map: any = {};
  try {
    const res: any = await db.prepare(`SELECT key, value FROM settings`).all();
    for (const r of res.results || []) map[r.key] = r.value;
  } catch (e) { /* settings 表可能尚未建，用默认值 */ }
  const num = (k: string, d: number) => { const v = parseInt(map[k], 10); return isNaN(v) ? d : v; };
  const games: any = {};
  for (const def of GAME_DEFS) {
    const g = def.key;
    let prizes: any[] = [];
    try { prizes = sanitizePrizes(JSON.parse(map[`${g}_prizes`] || "null")); } catch (e) { prizes = []; }
    if (!prizes.length) prizes = defaultPrizes();
    games[g] = {
      bet: num(`${g}_bet`, def.bet),
      enabled: map[`${g}_enabled`] === undefined ? true : map[`${g}_enabled`] === "1",
      prizes
    };
  }
  return { start_balance: num("start_balance", 0), games };
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
    `INSERT OR IGNORE INTO players (tg_id, username, balance, free_spins_left) VALUES (?, ?, ?, 0)`
  ).bind(user.id, username, settings.start_balance).run();
  return db.prepare(`SELECT * FROM players WHERE tg_id = ?`).bind(user.id).first();
}

// --------------------------------------------------------------------------- //
// 玩家 API
// --------------------------------------------------------------------------- //
async function handleProfile(request: Request, env: any, db: any): Promise<Response> {
  const body = await readJson(request);
  const user = await validateInitData(body.initData || "", env.TELEGRAM_BOT_TOKEN);
  if (!user) return jsonResp({ ok: false, error: "auth" }, 401);
  const settings = await getSettings(db);
  const p: any = await ensurePlayer(db, user, settings);
  return jsonResp({
    ok: true,
    username: p ? p.username : (user.username || user.first_name || "玩家"),
    balance: p ? p.balance : 0,
    spins: 0,
    banned: p ? (p.status === "banned") : false
  });
}

async function handleSpin(request: Request, env: any, db: any): Promise<Response> {
  const body = await readJson(request);
  const user = await validateInitData(body.initData || "", env.TELEGRAM_BOT_TOKEN);
  if (!user) return jsonResp({ ok: false, error: "auth" }, 401);
  const settings = await getSettings(db);
  const game = GAME_KEYS.includes(body.game) ? body.game : "wheel";
  const gconf = settings.games[game];
  const p: any = await ensurePlayer(db, user, settings);
  if (!p) return jsonResp({ ok: false, error: "no_user" }, 400);
  if (p.status === "banned") return jsonResp({ ok: false, error: "banned", balance: p.balance });
  if (!gconf.enabled) return jsonResp({ ok: false, error: "disabled", balance: p.balance });

  const bet = gconf.bet;
  if (p.balance < bet) {
    return jsonResp({ ok: false, error: "insufficient", balance: p.balance, message: "积分不足，请联系管理员加分" });
  }
  const prize = pickPrize(gconf.prizes);
  const award = prize.award;
  // 原子扣注 + 派彩，防并发：仅当余额仍 >= bet 时执行
  const upd: any = await db.prepare(
    `UPDATE players SET balance = balance - ? + ? WHERE tg_id = ? AND balance >= ?`
  ).bind(bet, award, user.id, bet).run();
  const changed = upd && upd.meta ? upd.meta.changes : 1;
  if (!changed) {
    return jsonResp({ ok: false, error: "insufficient", balance: p.balance, message: "积分不足，请联系管理员加分" });
  }

  const newBal = p.balance - bet + award;
  const label = (GAME_DEFS.find((x) => x.key === game) || { label: game }).label;
  const note = `${label}·下注${bet}·中${award}${prize.label ? ("·" + prize.label) : ""}`;
  await logTx(db, user.id, "spin", award - bet, newBal, note);
  return jsonResp({ ok: true, award, bet, net: award - bet, balance: newBal, prize_label: prize.label });
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
      case "/api/admin/player/delete":   return adminPlayerDelete(db, body);
      case "/api/admin/transactions":    return adminTransactions(db, body);
      case "/api/admin/settings/get":    return adminSettingsGet(db);
      case "/api/admin/settings/save":   return adminSettingsSave(db, body);
      case "/api/admin/admins/list":     return adminAdminsList(db);
      case "/api/admin/admins/create":   return adminAdminsCreate(db, body);
      case "/api/admin/admins/delete":   return adminAdminsDelete(db, body, admin);
      case "/api/admin/password":        return adminPassword(db, body, admin);
      case "/api/admin/chat/list":       return adminChatList(db);
      case "/api/admin/chat/thread":     return adminChatThread(db, body);
      case "/api/admin/chat/send":       return adminChatSend(db, body, env);
      case "/api/admin/chat/photo":      return adminChatPhoto(db, body, env);
      case "/api/admin/chat/unread":     return adminChatUnread(db);
      case "/api/admin/broadcast":       return adminBroadcast(db, body, env);
      case "/api/admin/broadcast/schedule":     return adminBroadcastSchedule(db, body);
      case "/api/admin/broadcast/scheduled":    return adminBroadcastScheduledList(db);
      case "/api/admin/broadcast/cancel":       return adminBroadcastCancel(db, body);
      case "/api/admin/config/get":      return adminConfigGet(db);
      case "/api/admin/config/save":     return adminConfigSave(db, body);
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
  const upsert = (k: string, v: string) => db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(k, v);
  const stmts: any[] = [];
  if (body.start_balance !== undefined && body.start_balance !== null && body.start_balance !== "") {
    stmts.push(upsert("start_balance", String(Math.max(0, parseInt(body.start_balance, 10) || 0))));
  }
  const games = body.games || {};
  for (const def of GAME_DEFS) {
    const gc = games[def.key];
    if (!gc) continue;
    if (gc.bet !== undefined && gc.bet !== null && gc.bet !== "") {
      stmts.push(upsert(`${def.key}_bet`, String(Math.max(0, parseInt(gc.bet, 10) || 0))));
    }
    if (gc.enabled !== undefined) stmts.push(upsert(`${def.key}_enabled`, gc.enabled ? "1" : "0"));
    if (gc.prizes !== undefined) stmts.push(upsert(`${def.key}_prizes`, JSON.stringify(sanitizePrizes(gc.prizes))));
  }
  if (stmts.length) await db.batch(stmts);
  return jsonResp({ ok: true, settings: await getSettings(db) });
}

// --------------------------------------------------------------------------- //
// 后台客服聊天（玩家发给 bot 的消息 <-> 管理员回复）
// --------------------------------------------------------------------------- //
async function adminChatList(db: any): Promise<Response> {
  try {
    const rows: any = await db.prepare(
      `SELECT m.tg_id, MAX(m.username) AS username,
        SUM(CASE WHEN m.direction='in' AND m.seen=0 THEN 1 ELSE 0 END) AS unread,
        (SELECT text FROM messages x WHERE x.tg_id=m.tg_id ORDER BY x.id DESC LIMIT 1) AS last_text,
        (SELECT created_at FROM messages x WHERE x.tg_id=m.tg_id ORDER BY x.id DESC LIMIT 1) AS last_at
       FROM messages m GROUP BY m.tg_id ORDER BY last_at DESC LIMIT 200`).all();
    return jsonResp({ ok: true, chats: rows.results || [] });
  } catch (e) { return jsonResp({ ok: true, chats: [] }); }
}

async function adminChatThread(db: any, body: any): Promise<Response> {
  const tg_id = parseInt(body.tg_id, 10);
  if (!tg_id) return jsonResp({ ok: false, error: "bad_input" }, 400);
  const rows: any = await db.prepare(
    `SELECT id, direction, text, created_at FROM messages WHERE tg_id = ? ORDER BY id ASC LIMIT 500`).bind(tg_id).all();
  try { await db.prepare(`UPDATE messages SET seen=1 WHERE tg_id=? AND direction='in' AND seen=0`).bind(tg_id).run(); } catch (e) {}
  return jsonResp({ ok: true, messages: rows.results || [] });
}

// 玩家快捷回复键盘：玩家会看到一排可点的按钮，点了即把该文字发回；同时仍可自己打字。
function buildReplyKeyboard(buttons: any): any {
  if (!Array.isArray(buttons)) return undefined;
  const labels = buttons.map((s: any) => String(s).slice(0, 40).trim()).filter(Boolean).slice(0, 8);
  if (!labels.length) return undefined;
  return { keyboard: labels.map((l: string) => [{ text: l }]), resize_keyboard: true, one_time_keyboard: false };
}

async function adminChatSend(db: any, body: any, env: any): Promise<Response> {
  const tg_id = parseInt(body.tg_id, 10);
  const text = String(body.text || "").slice(0, 2000);
  if (!tg_id || !text.trim()) return jsonResp({ ok: false, error: "bad_input" }, 400);
  let markup = buildReplyKeyboard(body.buttons);
  if (!markup && body.remove_keyboard) markup = { remove_keyboard: true };   // 移除玩家键盘
  await sendMessage(env.TELEGRAM_BOT_TOKEN, tg_id, text, markup);
  await db.prepare(`INSERT INTO messages (tg_id, direction, text) VALUES (?, 'out', ?)`).bind(tg_id, text).run();
  return jsonResp({ ok: true });
}

async function adminChatUnread(db: any): Promise<Response> {
  try {
    const r: any = await db.prepare(`SELECT COUNT(*) c FROM messages WHERE direction='in' AND seen=0`).first();
    return jsonResp({ ok: true, unread: r ? r.c : 0 });
  } catch (e) { return jsonResp({ ok: true, unread: 0 }); }
}

// 发图片（充值二维码）。photo 可为图片 URL。
async function sendPhoto(token: string, chatId: number, photo: string, caption?: string): Promise<void> {
  if (!token || !photo) return;
  await fetch("https://api.telegram.org/bot" + token + "/sendPhoto", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, photo, caption: caption || "" })
  });
}

async function adminChatPhoto(db: any, body: any, env: any): Promise<Response> {
  const tg_id = parseInt(body.tg_id, 10);
  if (!tg_id) return jsonResp({ ok: false, error: "bad_input" }, 400);
  const cfg = await getConfig(db);
  const url = String(body.photo_url || cfg.qr_url || "").trim();
  if (!url) return jsonResp({ ok: false, error: "no_qr", message: "未配置充值二维码图片 URL" }, 400);
  const caption = String(body.caption || "扫码充值，付款后请把截图发给客服").slice(0, 500);
  await sendPhoto(env.TELEGRAM_BOT_TOKEN, tg_id, url, caption);
  await db.prepare(`INSERT INTO messages (tg_id, direction, text) VALUES (?, 'out', ?)`).bind(tg_id, "🖼️ [充值二维码] " + caption).run();
  return jsonResp({ ok: true });
}

// 广播（分批）：每次发一批，返回 nextOffset 让前端循环到 done。
async function adminBroadcast(db: any, body: any, env: any): Promise<Response> {
  const text = String(body.text || "").slice(0, 2000);
  if (!text.trim()) return jsonResp({ ok: false, error: "bad_input" }, 400);
  let markup = buildReplyKeyboard(body.buttons);
  if (!markup && body.remove_keyboard) markup = { remove_keyboard: true };
  const limit = Math.min(40, Math.max(1, parseInt(body.limit, 10) || 40));
  const offset = Math.max(0, parseInt(body.offset, 10) || 0);
  let totalRow: any, rows: any;
  try {
    totalRow = await db.prepare(`SELECT COUNT(*) c FROM players WHERE status != 'banned'`).first();
    rows = await db.prepare(`SELECT tg_id FROM players WHERE status != 'banned' ORDER BY tg_id LIMIT ? OFFSET ?`).bind(limit, offset).all();
  } catch (e) {
    totalRow = await db.prepare(`SELECT COUNT(*) c FROM players`).first();
    rows = await db.prepare(`SELECT tg_id FROM players ORDER BY tg_id LIMIT ? OFFSET ?`).bind(limit, offset).all();
  }
  const total = totalRow ? totalRow.c : 0;
  const players = rows.results || [];
  let sent = 0, failed = 0;
  for (const p of players) {
    try { await sendMessage(env.TELEGRAM_BOT_TOKEN, p.tg_id, text, markup); sent++; }
    catch (e) { failed++; }
  }
  const nextOffset = offset + players.length;
  return jsonResp({ ok: true, sent, failed, total, nextOffset, done: players.length === 0 || nextOffset >= total });
}

// 定时广播
async function adminBroadcastSchedule(db: any, body: any): Promise<Response> {
  const text = String(body.text || "").slice(0, 2000);
  const send_at = String(body.send_at || "").trim();   // UTC 'YYYY-MM-DD HH:MM'
  if (!text.trim() || !send_at) return jsonResp({ ok: false, error: "bad_input" }, 400);
  const buttons = JSON.stringify(Array.isArray(body.buttons) ? body.buttons : []);
  await db.prepare(`INSERT INTO scheduled_broadcasts (text, buttons, send_at, sent) VALUES (?, ?, ?, 0)`)
    .bind(text, buttons, send_at).run();
  return jsonResp({ ok: true });
}
async function adminBroadcastScheduledList(db: any): Promise<Response> {
  try {
    const rows: any = await db.prepare(`SELECT id, text, send_at, sent, created_at FROM scheduled_broadcasts ORDER BY id DESC LIMIT 50`).all();
    return jsonResp({ ok: true, list: rows.results || [] });
  } catch (e) { return jsonResp({ ok: true, list: [] }); }
}
async function adminBroadcastCancel(db: any, body: any): Promise<Response> {
  const id = parseInt(body.id, 10);
  if (!id) return jsonResp({ ok: false, error: "bad_input" }, 400);
  await db.prepare(`DELETE FROM scheduled_broadcasts WHERE id = ? AND sent = 0`).bind(id).run();
  return jsonResp({ ok: true });
}

// 配置：欢迎语 / 关键词自动回复 / 充值二维码 URL
async function getConfig(db: any): Promise<any> {
  const map: any = {};
  try {
    const res: any = await db.prepare(`SELECT key, value FROM settings WHERE key IN ('welcome_text','autoreply','qr_url')`).all();
    for (const r of res.results || []) map[r.key] = r.value;
  } catch (e) {}
  let rules: any = [];
  try { rules = JSON.parse(map.autoreply || "null") || []; } catch (e) { rules = []; }
  if (!Array.isArray(rules)) rules = [];
  return { welcome_text: map.welcome_text || "", autoreply: rules, qr_url: map.qr_url || "" };
}
async function adminConfigGet(db: any): Promise<Response> {
  return jsonResp({ ok: true, config: await getConfig(db) });
}
async function adminConfigSave(db: any, body: any): Promise<Response> {
  const upsert = (k: string, v: string) => db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(k, v);
  const stmts: any[] = [];
  if (body.welcome_text !== undefined) stmts.push(upsert("welcome_text", String(body.welcome_text).slice(0, 2000)));
  if (body.qr_url !== undefined) stmts.push(upsert("qr_url", String(body.qr_url).slice(0, 500)));
  if (body.autoreply !== undefined) {
    const rules = (Array.isArray(body.autoreply) ? body.autoreply : [])
      .map((r: any) => ({ kw: String(r.kw || "").slice(0, 40).trim(), reply: String(r.reply || "").slice(0, 1000) }))
      .filter((r: any) => r.kw && r.reply).slice(0, 30);
    stmts.push(upsert("autoreply", JSON.stringify(rules)));
  }
  if (stmts.length) await db.batch(stmts);
  return jsonResp({ ok: true, config: await getConfig(db) });
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
          `INSERT OR IGNORE INTO players (tg_id, username, balance, free_spins_left) VALUES (?, ?, ?, 0)`
        ).bind(userId, username, settings.start_balance).run();
        const appUrl = url.origin + "/";
        const cfg = await getConfig(db);
        const welcome = cfg.welcome_text ||
          `🎉 欢迎来到霓虹游戏厅！\n\n💰 当前积分：${settings.start_balance} 分\n🎮 下注游戏赢取积分；积分不足请直接在此发消息联系客服充值。\n\n点下方按钮进入游戏 👇`;
        await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, welcome,
          { inline_keyboard: [[{ text: "🚀 进入游戏", web_app: { url: appUrl } }]] });
      } else if (text.startsWith("/profile")) {
        const p: any = await db.prepare(`SELECT * FROM players WHERE tg_id = ?`).bind(userId).first();
        if (p) {
          await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId,
            `👤 【${p.username}】\n💰 积分：${p.balance} 分`);
        } else {
          await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `❌ 请先输入 /start 激活。`);
        }
      } else if (text.trim()) {
        // 普通文字消息 -> 存入客服会话，供后台回复
        try {
          await db.prepare(`INSERT INTO messages (tg_id, username, direction, text) VALUES (?, ?, 'in', ?)`)
            .bind(userId, username, text.slice(0, 2000)).run();
        } catch (e) { /* messages 表尚未建则忽略 */ }
        // 关键词自动回复
        try {
          const cfg = await getConfig(db);
          const low = text.toLowerCase();
          const hit = (cfg.autoreply || []).find((r: any) => r.kw && low.includes(String(r.kw).toLowerCase()));
          if (hit) {
            await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, hit.reply);
            await db.prepare(`INSERT INTO messages (tg_id, direction, text) VALUES (?, 'out', ?)`).bind(userId, hit.reply).run();
          }
        } catch (e) {}
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
