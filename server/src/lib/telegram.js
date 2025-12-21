import dotenv from "dotenv";
dotenv.config({ path: "/var/www/ai-widget/server/.env" });

import crypto from "crypto";

import { sql } from "./db.js";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

function randomSecret() {
  return crypto.randomBytes(5).toString("hex");
}

export function isTelegramConfigured() {
  return Boolean(TELEGRAM_TOKEN);
}

export async function issueTelegramSecret({ chatId, username = null }) {
  if (!chatId) throw new Error("chat_id_required");

  let attempts = 0;
  while (attempts < 5) {
    const secret = randomSecret();
    try {
      await sql.exec(
        `INSERT INTO telegram_link_tokens (secret, chat_id, username)
         VALUES ($1,$2,$3)`,
        [secret, String(chatId), username || null]
      );
      return secret;
    } catch (err) {
      // retry on conflict
      attempts += 1;
      if (attempts >= 5) throw err;
    }
  }
  throw new Error("failed_to_generate_secret");
}

export async function consumeTelegramSecret(secret) {
  if (!secret) return null;
  return await sql.oneOrNone(
    `UPDATE telegram_link_tokens
       SET used_at=NOW()
     WHERE secret=$1 AND used_at IS NULL
     RETURNING chat_id, username, created_at`,
    [secret]
  );
}

export async function sendTelegramMessage(chatId, text) {
  if (!TELEGRAM_TOKEN || !chatId || !text) return false;

  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = { chat_id: chatId, text };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const payload = await r.text();
    throw new Error(`telegram_error_${r.status}: ${payload}`);
  }
  return true;
}

export async function notifyProjectAboutNewChat(project, chat) {
  if (!project?.telegram_chat_id || !isTelegramConfigured()) return;
  const title = project?.name ? `"${project.name}"` : "вашем сайте";
  const message =
    `На проекте ${title} открыт новый диалог.\n` +
    `ID чата: ${chat?.id || "неизвестен"}.\n` +
    `Скорее посмотрите в админке.`;

  try {
    await sendTelegramMessage(project.telegram_chat_id, message);
  } catch (err) {
    console.warn("telegram notify failed", err?.message || err);
  }
}
