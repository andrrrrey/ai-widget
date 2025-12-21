import { sql } from "./db.js";
import { v4 as uuidv4 } from "uuid";
import { ensureThread } from "./openai.js";

export async function createUser({ email, passwordHash, role = "user" }) {
  const row = await sql.one(
    `INSERT INTO users (id, email, password_hash, role)
     VALUES ($1,$2,$3,$4) RETURNING id, email, role, created_at`,
    [uuidv4(), email, passwordHash, role]
  );
  return row;
}

export async function findUserByEmail(email) {
  return await sql.oneOrNone(`SELECT * FROM users WHERE email=$1`, [email]);
}

export async function listUsers() {
  return await sql.many(`SELECT id, email, role, created_at FROM users ORDER BY created_at DESC`);
}

export async function createProject({
  name,
  assistantId,
  openaiApiKey,
  instructions,
  allowedOrigins,
  ownerId = null,
  telegramChatId = null,
}) {
  const id = uuidv4();
  const row = await sql.one(
    `INSERT INTO projects (id, name, assistant_id, openai_api_key, instructions, allowed_origins, owner_id, telegram_chat_id, telegram_connected_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      id,
      name || "New Project",
      assistantId || "",
      openaiApiKey || "",
      instructions || "",
      Array.isArray(allowedOrigins) ? allowedOrigins : [],
      ownerId || null,
      telegramChatId || null,
      telegramChatId ? new Date() : null,
    ]
  );
  return row;
}

export async function listProjects({ ownerId = null } = {}) {
  if (ownerId) {
    return await sql.many("SELECT * FROM projects WHERE owner_id=$1 ORDER BY created_at DESC", [ownerId]);
  }
  return await sql.many("SELECT * FROM projects ORDER BY created_at DESC");
}

export async function getProject(projectId) {
  return await sql.oneOrNone("SELECT * FROM projects WHERE id=$1", [projectId]);
}

export async function updateProject(projectId, patch) {
  const p = await getProject(projectId);
  if (!p) return null;

  const name = patch.name ?? p.name;
  const assistantId = patch.assistant_id ?? p.assistant_id;
  const openaiApiKey = patch.openai_api_key ?? p.openai_api_key;
  const instructions = patch.instructions ?? p.instructions;
  const allowedOrigins = patch.allowed_origins ?? p.allowed_origins;
  const ownerId = patch.owner_id ?? p.owner_id;
  const telegramChatId = Object.hasOwn(patch, "telegram_chat_id")
    ? patch.telegram_chat_id
    : p.telegram_chat_id;
  const telegramConnectedAt = Object.hasOwn(patch, "telegram_connected_at")
    ? patch.telegram_connected_at
    : p.telegram_connected_at;

  return await sql.one(
    `UPDATE projects
     SET name=$2, assistant_id=$3, openai_api_key=$4, instructions=$5, allowed_origins=$6, owner_id=$7, telegram_chat_id=$8, telegram_connected_at=$9, updated_at=NOW()
     WHERE id=$1 RETURNING *`,
    [
      projectId,
      name,
      assistantId,
      openaiApiKey,
      instructions,
      allowedOrigins,
      ownerId,
      telegramChatId,
      telegramConnectedAt,
    ]
  );
}

export async function deleteProject(projectId) {
  const existing = await getProject(projectId);
  if (!existing) return false;
  await sql.exec("DELETE FROM projects WHERE id=$1", [projectId]);
  return true;
}

export async function createChat({ projectId, visitorId, openaiApiKey }) {
  const threadId = await ensureThread(openaiApiKey);
  const id = uuidv4();

  const row = await sql.one(
    `INSERT INTO chats (id, project_id, thread_id, mode, status, visitor_id)
     VALUES ($1,$2,$3,'assistant','open',$4) RETURNING *`,
    [id, projectId, threadId, visitorId || null]
  );
  return row;
}

export async function getChatById(chatId) {
  return await sql.oneOrNone("SELECT * FROM chats WHERE id=$1", [chatId]);
}

export async function listChats({ projectId, status = null, mode = null }) {
  const where = ["project_id=$1"];
  const params = [projectId];
  let i = 2;

  if (status) { where.push(`status=$${i++}`); params.push(status); }
  if (mode) { where.push(`mode=$${i++}`); params.push(mode); }

  const q = `SELECT * FROM chats WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT 200`;
  return await sql.many(q, params);
}

export async function listMessages(chatId) {
  return await sql.many("SELECT * FROM messages WHERE chat_id=$1 ORDER BY created_at ASC", [chatId]);
}

export async function addMessage({ chatId, role, content }) {
  return await sql.one(
    `INSERT INTO messages (id, chat_id, role, content)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [uuidv4(), chatId, role, content]
  );
}

export async function setChatMode(chatId, mode) {
  const row = await sql.oneOrNone("UPDATE chats SET mode=$2, updated_at=NOW() WHERE id=$1 RETURNING *", [chatId, mode]);
  if (!row) throw new Error("chat_not_found");
  return row;
}

export async function touchChat(chatId) {
  await sql.exec("UPDATE chats SET updated_at=NOW(), last_seen_at=NOW() WHERE id=$1", [chatId]);
}
