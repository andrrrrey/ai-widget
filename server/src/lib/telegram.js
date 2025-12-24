import dotenv from "dotenv";
dotenv.config({ path: "/var/www/ai-widget/server/.env" });

import crypto from "crypto";

import { sql } from "./db.js";
import { getChatDisplayName } from "./chatNames.js";
import { listProjectTelegramChats } from "./store.js";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

function randomSecret() {
  return crypto.randomBytes(5).toString("hex");
}

export function isTelegramConfigured() {
  return Boolean(TELEGRAM_TOKEN);
}

export async function issueTelegramSecret({ chatId, username = null, chatType = null }) {
  if (!chatId) throw new Error("chat_id_required");

  let attempts = 0;
  while (attempts < 5) {
    const secret = randomSecret();
    try {
      await sql.exec(
        `INSERT INTO telegram_link_tokens (secret, chat_id, username, chat_type)
         VALUES ($1,$2,$3,$4)`,
        [secret, String(chatId), username || null, chatType || null]
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
     RETURNING chat_id, username, chat_type, created_at`,
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

function formatProjectTitle(project) {
  return project?.name ? `"${project.name}"` : "вашем сайте";
}

function formatChatId(chat) {
  if (!chat?.id) return "неизвестен";
  return getChatDisplayName(chat.id);
}

async function listProjectTelegramChatIds(project) {
  if (!project?.id) return [];
  const rows = await listProjectTelegramChats(project.id);
  const ids = rows.map((row) => row.chat_id).filter(Boolean);
  if (project.telegram_chat_id && !ids.includes(project.telegram_chat_id)) {
    ids.push(project.telegram_chat_id);
  }
  return ids;
}

function normalizeMatch(value) {
  return String(value || "").trim();
}

export function extractContactInfo(text) {
  if (!text) return [];
  const candidates = [];
  const emailMatches = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi) || [];
  emailMatches.forEach((value) => candidates.push({ type: "email", value }));

  const phoneMatches = text.match(/(\+?\d[\d\s().-]{6,}\d)/g) || [];
  phoneMatches.forEach((value) => candidates.push({ type: "phone", value }));

  const tgHandleMatches = text.match(/(?:^|\s)@([a-zA-Z0-9_]{5,})/g) || [];
  tgHandleMatches.forEach((value) => candidates.push({ type: "telegram", value }));

  const tmeMatches = text.match(/t\.me\/([a-zA-Z0-9_]+)/gi) || [];
  tmeMatches.forEach((value) => candidates.push({ type: "telegram", value }));

  const waMatches = text.match(/wa\.me\/\d+/gi) || [];
  waMatches.forEach((value) => candidates.push({ type: "whatsapp", value }));

  const tgLabelMatches = text.match(/(?:телеграм|telegram|tg)[:\s]+([\w@.+-]{3,})/gi) || [];
  tgLabelMatches.forEach((value) => candidates.push({ type: "telegram", value }));

  const waLabelMatches = text.match(/(?:whatsapp|ватсап|ватап)[:\s]+([\w@.+-]{3,})/gi) || [];
  waLabelMatches.forEach((value) => candidates.push({ type: "whatsapp", value }));

  const unique = new Map();
  candidates.forEach((item) => {
    const cleaned = normalizeMatch(item.value);
    if (!cleaned) return;
    const key = `${item.type}:${cleaned.toLowerCase()}`;
    if (!unique.has(key)) {
      unique.set(key, { type: item.type, value: cleaned });
    }
  });

  return Array.from(unique.values());
}

export async function notifyProjectAboutFirstMessage(project, chat, messageText) {
  if (!isTelegramConfigured()) return;
  const title = formatProjectTitle(project);
  const chatIds = await listProjectTelegramChatIds(project);
  if (chatIds.length === 0) return;
  const message =
    `На проекте ${title} получено первое сообщение от пользователя.\n` +
    `ID чата: ${formatChatId(chat)}.\n` +
    `Сообщение: ${String(messageText || "").trim().slice(0, 500) || "—"}`;

  for (const chatId of chatIds) {
    try {
      await sendTelegramMessage(chatId, message);
    } catch (err) {
      console.warn("telegram notify failed", err?.message || err);
    }
  }
}

export async function notifyProjectAboutContacts(project, chat, contacts, messageText) {
  if (!isTelegramConfigured()) return;
  if (!Array.isArray(contacts) || contacts.length === 0) return;
  const title = formatProjectTitle(project);
  const chatIds = await listProjectTelegramChatIds(project);
  if (chatIds.length === 0) return;
  const contactsLine = contacts.map((item) => item.value).join(", ");
  const message =
    `На проекте ${title} пользователь оставил контакты.\n` +
    `ID чата: ${formatChatId(chat)}.\n` +
    `Контакты: ${contactsLine}\n` +
    `Сообщение: ${String(messageText || "").trim().slice(0, 500) || "—"}`;

  for (const chatId of chatIds) {
    try {
      await sendTelegramMessage(chatId, message);
    } catch (err) {
      console.warn("telegram notify failed", err?.message || err);
    }
  }
}
