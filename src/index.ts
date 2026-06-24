// Telegram Mini App 抽奖机器人 — Cloudflare Worker (D1)
// GET   /            -> 返回霓虹风 Mini App 网页
// POST  /api/profile -> 校验 initData，返回玩家资料
// POST  /api/spin    -> 校验 initData，扣次数+加积分
// POST  其它路径      -> Telegram Webhook（/start 发送"进入游戏"内嵌按钮）

export default {
  async fetch(request: Request, env: any, ctx: any): Promise<Response> {
    // 兼容两种绑定名：DB1（面板里配置的）或 DB（仓库 wrangler.jsonc 里的）
    const db: any = env.DB1 || env.DB;
    const url = new URL(request.url);

    if (request.method === "GET") {
      return new Response(PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
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

// --------------------------------------------------------------------------- //
// 霓虹风 Mini App 网页（无模板插值/反引号，安全内嵌）
// --------------------------------------------------------------------------- //
const PAGE = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>🎰 霓虹抽奖</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
  :root{--neon:#0ff;--neon2:#f0f;--gold:#ffd700}
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{margin:0;height:100%}
  body{background:radial-gradient(circle at 50% 0%,#1a1040,#05010f 70%);color:#fff;
    font-family:-apple-system,Segoe UI,Roboto,sans-serif;display:flex;flex-direction:column;
    align-items:center;min-height:100%;padding:18px;overflow:hidden}
  .top{width:100%;max-width:440px;display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
  .user{font-weight:700;text-shadow:0 0 8px var(--neon)}
  .bal{background:rgba(255,255,255,.06);border:1px solid var(--gold);border-radius:14px;
    padding:8px 14px;font-weight:800;color:var(--gold);box-shadow:0 0 14px rgba(255,215,0,.35)}
  .title{font-size:26px;font-weight:900;margin:16px 0 2px;letter-spacing:1px;
    background:linear-gradient(90deg,var(--neon),var(--neon2));-webkit-background-clip:text;background-clip:text;color:transparent;
    text-shadow:0 0 24px rgba(0,255,255,.4)}
  .sub{color:#9aa;font-size:13px;margin-bottom:14px}
  .wheel{position:relative;width:min(70vw,260px);aspect-ratio:1;margin:8px 0 24px}
  .ring{position:absolute;inset:0;border-radius:50%;
    background:conic-gradient(var(--neon),var(--neon2),var(--gold),var(--neon));filter:blur(2px);opacity:.85}
  .ring.spin{animation:spin .7s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .core{position:absolute;inset:14px;border-radius:50%;background:#0a0420;
    display:flex;align-items:center;justify-content:center;flex-direction:column;
    box-shadow:inset 0 0 30px rgba(0,255,255,.25)}
  .core .emoji{font-size:54px}
  .core .hint{font-size:12px;color:#9aa;margin-top:2px;letter-spacing:2px}
  .btn{width:min(80vw,300px);border:none;border-radius:18px;padding:18px;font-size:20px;font-weight:900;
    color:#05010f;background:linear-gradient(90deg,var(--neon),var(--neon2));cursor:pointer;
    box-shadow:0 0 26px rgba(0,255,255,.5);transition:transform .08s,opacity .2s}
  .btn:active{transform:scale(.97)}
  .btn:disabled{opacity:.45;cursor:default;box-shadow:none}
  .spins{margin-top:12px;color:#9aa;font-size:13px}
  .pop{position:fixed;inset:0;background:rgba(0,0,0,.72);display:none;align-items:center;justify-content:center;z-index:9}
  .pop.show{display:flex;animation:fade .2s}
  @keyframes fade{from{opacity:0}to{opacity:1}}
  .card{background:linear-gradient(160deg,#1a1040,#05010f);border:1px solid var(--gold);border-radius:22px;
    padding:30px 36px;text-align:center;box-shadow:0 0 40px rgba(255,215,0,.4);animation:pumpin .35s}
  @keyframes pumpin{from{transform:scale(.6);opacity:0}to{transform:scale(1);opacity:1}}
  .card .big{font-size:44px;font-weight:900;color:var(--gold);text-shadow:0 0 18px rgba(255,215,0,.7)}
  .card .lbl{color:#cdd;margin-top:6px}
  .card button{margin-top:18px;border:none;border-radius:12px;padding:10px 22px;font-weight:800;
    background:var(--neon);color:#05010f;cursor:pointer}
</style>
</head>
<body>
  <div class="top">
    <div class="user" id="user">玩家</div>
    <div class="bal">💰 <span id="bal">--</span></div>
  </div>
  <div class="title">NEON LUCKY SPIN</div>
  <div class="sub" id="sub">点击下方按钮，试试今天的手气 ✨</div>
  <div class="wheel">
    <div class="ring" id="ring"></div>
    <div class="core"><div class="emoji">🎰</div><div class="hint" id="hint">GO</div></div>
  </div>
  <button class="btn" id="spinBtn" disabled>🎰 试试手气 (Spin)</button>
  <div class="spins">🎁 剩余次数：<span id="spins">--</span></div>

  <div class="pop" id="pop">
    <div class="card">
      <div class="big" id="popBig">+0</div>
      <div class="lbl" id="popLbl">恭喜中奖！</div>
      <button id="popClose">太棒了</button>
    </div>
  </div>

<script>
  var tg = window.Telegram ? window.Telegram.WebApp : null;
  var initData = tg ? tg.initData : "";
  function $(id){ return document.getElementById(id); }
  function haptic(t){ try{ if(tg&&tg.HapticFeedback){ if(t==="ok")tg.HapticFeedback.notificationOccurred("success"); else tg.HapticFeedback.impactOccurred("medium"); } }catch(e){} }
  function setInfo(d){
    if(d.username) $("user").textContent = d.username;
    if(typeof d.balance==="number") $("bal").textContent = d.balance;
    if(typeof d.spins==="number") $("spins").textContent = d.spins;
  }
  async function api(path){
    var r = await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({initData:initData})});
    return { status:r.status, data: await r.json() };
  }
  async function loadProfile(){
    try{
      var res = await api("/api/profile");
      if(res.data && res.data.ok){ setInfo(res.data); $("spinBtn").disabled=false; }
      else { $("sub").textContent = "⚠️ 请从 Telegram 内打开本游戏"; }
    }catch(e){ $("sub").textContent = "⚠️ 加载失败，请重试"; }
  }
  var spinning=false;
  async function doSpin(){
    if(spinning) return; spinning=true;
    $("spinBtn").disabled=true; $("ring").classList.add("spin"); $("hint").textContent="..."; haptic("go");
    try{
      var res = await api("/api/spin");
      var d = res.data || {};
      await new Promise(function(r){ setTimeout(r,1400); });
      $("ring").classList.remove("spin");
      if(d.ok){
        setInfo(d); $("hint").textContent="WIN";
        $("popBig").textContent = "+" + d.award + " 分";
        $("popLbl").textContent = "🎉 恭喜中奖！";
        $("pop").classList.add("show"); haptic("ok");
      } else {
        $("hint").textContent="GO";
        var msg = d.error==="no_spins" ? "🎁 今日免费次数已用完！" : (d.error==="auth" ? "请从 Telegram 内打开本游戏" : "请先在机器人里发送 /start");
        $("popBig").textContent = "🙁";
        $("popLbl").textContent = msg;
        $("pop").classList.add("show");
      }
    }catch(e){ $("ring").classList.remove("spin"); $("hint").textContent="GO"; }
    spinning=false; $("spinBtn").disabled=false;
  }
  $("spinBtn").addEventListener("click", doSpin);
  $("popClose").addEventListener("click", function(){ $("pop").classList.remove("show"); });
  if(tg){ tg.ready(); tg.expand(); }
  loadProfile();
</script>
</body>
</html>`;
