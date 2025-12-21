import dotenv from "dotenv";
dotenv.config({ path: "/var/www/ai-widget/server/.env" });

import TelegramBot from "node-telegram-bot-api";

import { ensureSchema } from "./lib/db.js";
import { issueTelegramSecret } from "./lib/telegram.js";

dotenv.config({ path: "/var/www/ai-widget/server/.env" });

const token = process.env.TELEGRAM_BOT_TOKEN || "";

if (!token) {
  console.error("[telegram-bot] TELEGRAM_BOT_TOKEN is not set in .env");
  process.exit(1);
}


const bot = new TelegramBot(token, { polling: true });

await ensureSchema();

async function sendNewSecret(chat) {
  const secret = await issueTelegramSecret({
    chatId: chat.id,
    username: chat?.username || null,
  });
  const message =
    `Привет! Это бот уведомлений AI Widget.\n` +
    `Секретный код для привязки: ${secret}\n\n` +
    `Скопируйте его и вставьте в настройках проекта в админке, ` +
    `чтобы получать уведомления о новых чатах.`;
  await bot.sendMessage(chat.id, message);
}

bot.onText(/\/(start|code)/i, async (msg) => {
  try {
    await sendNewSecret(msg.chat);
  } catch (err) {
    console.error("[telegram-bot] failed to issue code", err?.message || err);
    await bot.sendMessage(msg.chat.id, "Не удалось выдать код. Попробуйте ещё раз позже.");
  }
});

bot.onText(/\/help/i, async (msg) => {
  const help =
    "Чтобы получать уведомления о новых диалогах:\n" +
    "1) Отправьте /code, чтобы получить секрет.\n" +
    "2) Откройте админку проекта и вставьте код в поле 'Telegram код'.";
  await bot.sendMessage(msg.chat.id, help);
});

bot.on("message", async (msg) => {
  if (msg.text?.startsWith("/")) return;
  await bot.sendMessage(
    msg.chat.id,
    "Отправьте /code, чтобы получить секретный ключ для привязки уведомлений."
  );
});

console.log("[telegram-bot] Bot started and polling for updates");
