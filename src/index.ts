export default {
  async fetch(request: Request, env: any, ctx: any): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("机器人运行正常！请确保已在 Cloudflare 网页端正确绑定了 D1 数据库 和 TELEGRAM_BOT_TOKEN");
    }

    // 兼容两种绑定名：DB1（面板里配置的）或 DB（仓库 wrangler.jsonc 里的）
    const db: any = env.DB1 || env.DB;

    try {
      const update: any = await request.json();

      if (update.message) {
        const msg = update.message;
        const chatId = msg.chat.id;
        const text = msg.text || "";
        const userId = msg.from.id;
        const username = msg.from.username || msg.from.first_name || "神秘玩家";

        // 🎯 /start (玩家报到注册)
        if (text.startsWith("/start")) {
          await db.prepare(
            `INSERT OR IGNORE INTO players (tg_id, username) VALUES (?, ?)`
          ).bind(userId, username).run();

          await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `🎉 欢迎来到游戏机器人！\n\n💰 你的初始积分：1000 分\n🎁 今日免费抽奖：3 次\n\n👉 输入 /profile 查看钱包\n👉 输入 /spin 试试手气`);
        }

        // 🎯 /profile (查看资产)
        else if (text.startsWith("/profile")) {
          const player: any = await db.prepare(
            `SELECT * FROM players WHERE tg_id = ?`
          ).bind(userId).first();
          if (player) {
            await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `👤 【${player.username}】的资产面板：\n\n💰 积分余额：${player.balance} 分\n🎁 剩余抽奖次数：${player.free_spins_left} 次`);
          } else {
            await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `❌ 找不到你的资料，请先输入 /start 激活。`);
          }
        }

        // 🎯 /spin (抽奖扣次数、加积分)
        else if (text.startsWith("/spin")) {
          const player: any = await db.prepare(
            `SELECT * FROM players WHERE tg_id = ?`
          ).bind(userId).first();
          if (!player) {
            await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `❌ 请先输入 /start 激活游戏。`);
            return new Response("OK");
          }

          if (player.free_spins_left <= 0) {
            await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `❌ 你今天的免费抽奖次数已经用光啦！`);
            return new Response("OK");
          }

          const award = Math.floor(Math.random() * 191) + 10;

          await db.prepare(
            `UPDATE players SET balance = balance + ?, free_spins_left = free_spins_left - 1 WHERE tg_id = ?`
          ).bind(award, userId).run();

          await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `🎰 📊 抽奖转盘转动...\n\n🎉 恭喜中奖！积分 +${award}！\n💰 当前总资产：${player.balance + award} 分\n🎁 剩余免费次数：${player.free_spins_left - 1} 次`);
        }
      }
    } catch (err) {
      // 容错处理
    }

    return new Response("OK");
  }
};

async function sendMessage(token: string, chatId: number, text: string): Promise<void> {
  if (!token) return;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text })
  });
}
