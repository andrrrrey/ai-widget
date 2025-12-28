import express from "express";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

import { ensureSchema, pool } from "./lib/db.js";
import { requireAdmin, requireUser, loginHandler, logoutHandler, hashPassword } from "./lib/auth.js";
import {
  createUser,
  listUsers,
  updateUserPassword,
  deleteUser,
  findUserByEmail,
  createProject,
  listProjects,
  getProject,
  updateProject,
  deleteProject,
  addProjectTelegramChat,
  deleteProjectTelegramChats,
  createChat,
  getChatById,
  listChats,
  listMessages,
  closeInactiveChats,
  addMessage,
  setChatMode,
  touchChat,
  countUserMessages,
  deleteChat,
  getProjectStats,
} from "./lib/store.js";
import { widgetCors } from "./lib/widgetCors.js";
import {
  fetchAssistantInstructions,
  runAssistantStream,
  syncOperatorToThread,
  updateAssistantInstructions,
} from "./lib/openai.js";
import { getChatDisplayName } from "./lib/chatNames.js";
import {
  consumeTelegramSecret,
  notifyProjectAboutFirstMessage,
  notifyProjectAboutContacts,
  extractContactInfo,
} from "./lib/telegram.js";

dotenv.config({ path: "/var/www/ai-widget/server/.env" });

const NO_SOURCE_INSTRUCTION =
  "Не указывай в ответах источник документа, из которого взята информация.";

const ASSISTANT_ID_PATTERN = /^asst_[a-zA-Z0-9]{12,}$/;

const isLikelyAssistantId = (value) => ASSISTANT_ID_PATTERN.test(String(value || ""));

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Static: widget + admin
app.use("/widget", express.static(path.join(__dirname, "../../widget")));
app.use("/admin", express.static(path.join(__dirname, "../../web-admin")));

app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

/**
 * WIDGET API (CORS allowlist per project)
 */
app.options("/api/widget/:projectId/*", widgetCors);

app.post("/api/widget/:projectId/chat/start", widgetCors, async (req, res) => {
  const { projectId } = req.params;
  const { visitorId } = req.body || {};
  const project = await getProject(projectId);
  if (!project) return res.status(404).json({ error: "project_not_found" });
  if (!project.openai_api_key) return res.status(400).json({ error: "openai_api_key_missing" });

  const chat = await createChat({
    projectId,
    visitorId: visitorId || null,
    openaiApiKey: project.openai_api_key,
  });

  res.json({ chatId: chat.id, mode: chat.mode });
});

app.get("/api/widget/:projectId/chat/:chatId/messages", widgetCors, async (req, res) => {
  const { projectId, chatId } = req.params;
  const chat = await getChatById(chatId);
  if (!chat || chat.project_id !== projectId) return res.status(404).json({ error: "chat_not_found" });
  const items = await listMessages(chatId);
  res.json({ items });
});

app.get("/api/widget/:projectId/chat/:chatId/stream", widgetCors, async (req, res) => {
  const { projectId, chatId } = req.params;
  const message = String(req.query.message || "").trim();
  if (!message) return res.status(400).json({ error: "empty_message" });

  const chat = await getChatById(chatId);
  if (!chat || chat.project_id !== projectId) return res.status(404).json({ error: "chat_not_found" });
  const project = await getProject(projectId);
  if (!project) return res.status(404).json({ error: "project_not_found" });

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const sanitizeCitations = (text) => text.replace(/【[^】]*】/g, "");
  let rawStream = "";
  let sentClean = "";

  const sendSanitizedToken = (token) => {
    rawStream += token || "";
    const cleaned = sanitizeCitations(rawStream);
    const delta = cleaned.slice(sentClean.length);
    if (delta) {
      send("token", { t: delta });
      sentClean = cleaned;
    }
  };
  
  try {
    await touchChat(chatId);
    await addMessage({ chatId, role: "user", content: message });
    const userMessageCount = await countUserMessages(chatId);
    if (userMessageCount === 1) {
      await notifyProjectAboutFirstMessage(project, chat, message);
    }
    const contacts = extractContactInfo(message);
    if (contacts.length > 0) {
      await notifyProjectAboutContacts(project, chat, contacts, message);
    }

    if (chat.mode === "human") {
      send("waiting_for_human", { chatId });
      send("done", { chatId });
      return res.end();
    }

    if (!project.assistant_id) {
      send("error", { message: "assistant_id is empty for this project" });
      send("done", { chatId });
      return res.end();
    }
    if (!isLikelyAssistantId(project.assistant_id)) {
      send("error", { message: "assistant_id is invalid for this project" });
      send("done", { chatId });
      return res.end();
    }
    if (!project.openai_api_key) {
      send("error", { message: "openai_api_key is empty for this project" });
      send("done", { chatId });
      return res.end();
    }

    send("meta", { chatId, mode: "assistant" });

    const additionalInstructions = [project.instructions, NO_SOURCE_INSTRUCTION]
      .filter(Boolean)
      .join("\n\n");
      
    await runAssistantStream({
      apiKey: project.openai_api_key,
      threadId: chat.thread_id,
      assistantId: project.assistant_id,
      additionalInstructions,
      userMessage: message,
      onToken: (t) => sendSanitizedToken(t),
      onTool: (tool) => send("tool", tool),
      onDone: async (fullText) => {
        const finalText = sanitizeCitations(fullText || rawStream).trim();
        if (finalText) {
          if (finalText.length > sentClean.length) {
            send("token", { t: finalText.slice(sentClean.length) });
          }
          await addMessage({ chatId, role: "assistant", content: finalText });
        }
        send("done", { chatId });
        res.end();
      },
      onError: (err) => {
        send("error", { message: err?.message || String(err) });
        send("done", { chatId });
        res.end();
      },
    });
  } catch (e) {
    send("error", { message: e?.message || String(e) });
    send("done", { chatId });
    res.end();
  }
});

/**
 * ADMIN API (same-origin, cookie auth)
 */
app.post("/api/admin/login", loginHandler);
app.post("/api/admin/logout", logoutHandler);

// Projects CRUD
app.get("/api/admin/projects", requireAdmin, async (req, res) => {
  const items = await listProjects();
  res.json({ items });
});

app.post("/api/admin/projects", requireAdmin, async (req, res) => {
  const name = String(req.body?.name || "New Project");
  const assistant_id = String(req.body?.assistant_id || "");
  const openai_api_key = String(req.body?.openai_api_key || "");
  const instructions = String(req.body?.instructions || "");
  const allowed_origins = Array.isArray(req.body?.allowed_origins)
    ? req.body.allowed_origins.map(String)
    : [];
  const owner_id = typeof req.body?.owner_id === "string" ? req.body.owner_id : null;

  const project = await createProject({
    name,
    assistantId: assistant_id,
    openaiApiKey: openai_api_key,
    instructions,
    allowedOrigins: allowed_origins,
    ownerId: owner_id,
  });

  res.json({ project });
});

app.delete("/api/admin/projects/:projectId", requireAdmin, async (req, res) => {
  const ok = await deleteProject(req.params.projectId);
  if (!ok) return res.status(404).json({ error: "project_not_found" });
  res.json({ ok: true });
});

// Users management
app.get("/api/admin/users", requireAdmin, async (req, res) => {
  const items = await listUsers();
  res.json({ items });
});

app.post("/api/admin/users", requireAdmin, async (req, res) => {
  const email = String(req.body?.email || "").toLowerCase();
  const password = String(req.body?.password || "").trim();
  if (!email || !password) return res.status(400).json({ error: "email_and_password_required" });
  if (await findUserByEmail(email)) return res.status(409).json({ error: "user_exists" });

  const passwordHash = hashPassword(password);
  const user = await createUser({ email, passwordHash, role: "user" });
  res.json({ user });
});

app.patch("/api/admin/users/:userId", requireAdmin, async (req, res) => {
  const password = String(req.body?.password || "").trim();
  if (!password) return res.status(400).json({ error: "password_required" });
  const user = await updateUserPassword(req.params.userId, hashPassword(password));
  if (!user) return res.status(404).json({ error: "user_not_found" });
  res.json({ user });
});

app.delete("/api/admin/users/:userId", requireAdmin, async (req, res) => {
  const ok = await deleteUser(req.params.userId);
  if (!ok) return res.status(404).json({ error: "user_not_found" });
  res.json({ ok: true });
});

/**
 * USER API (cookie auth)
 */
app.get("/api/user/projects", requireUser, async (req, res) => {
  const items = await listProjects({ ownerId: req.auth.userId });
  res.json({ items });
});

app.post("/api/user/projects", requireUser, async (req, res) => {
  const name = String(req.body?.name || "New Project");
  const assistant_id = String(req.body?.assistant_id || "");
  const openai_api_key = String(req.body?.openai_api_key || "");
  const instructions = String(req.body?.instructions || "");
  const allowed_origins = Array.isArray(req.body?.allowed_origins)
    ? req.body.allowed_origins.map(String)
    : [];

  const project = await createProject({
    name,
    assistantId: assistant_id,
    openaiApiKey: openai_api_key,
    instructions,
    allowedOrigins: allowed_origins,
    ownerId: req.auth.userId,
  });

  res.json({ project });
});

app.get("/api/user/projects/:projectId", requireUser, async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project || project.owner_id !== req.auth.userId)
    return res.status(404).json({ error: "project_not_found" });
  res.json({ project });
});

app.get("/api/user/projects/:projectId/stats", requireUser, async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project || project.owner_id !== req.auth.userId)
    return res.status(404).json({ error: "project_not_found" });
  const stats = await getProjectStats(req.params.projectId);
  res.json({ stats });
});

app.patch("/api/user/projects/:projectId", requireUser, async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project || project.owner_id !== req.auth.userId)
    return res.status(404).json({ error: "project_not_found" });

  const patch = {};

  if (typeof req.body?.name === "string") patch.name = req.body.name;
  if (typeof req.body?.assistant_id === "string") patch.assistant_id = req.body.assistant_id;
  if (typeof req.body?.openai_api_key === "string") patch.openai_api_key = req.body.openai_api_key;
  if (typeof req.body?.instructions === "string") patch.instructions = req.body.instructions;
  if (Array.isArray(req.body?.allowed_origins)) patch.allowed_origins = req.body.allowed_origins.map(String);

  if (typeof req.body?.telegram_code === "string") {
    const code = req.body.telegram_code.trim();
    if (code) {
      const token = await consumeTelegramSecret(code);
      if (!token) return res.status(400).json({ error: "invalid_telegram_code" });
      await addProjectTelegramChat({
        projectId: project.id,
        chatId: token.chat_id,
        chatType: token.chat_type,
      });
      if (!project.telegram_chat_id) {
        patch.telegram_chat_id = token.chat_id;
      }
      if (!project.telegram_connected_at) {
        patch.telegram_connected_at = new Date();
      }
    }
  }

  if (req.body?.unlink_telegram === true) {
    await deleteProjectTelegramChats(project.id);
    patch.telegram_chat_id = null;
    patch.telegram_connected_at = null;
  }

  const updated = await updateProject(req.params.projectId, patch);
  res.json({ project: updated });
});

app.delete("/api/user/projects/:projectId", requireUser, async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project || project.owner_id !== req.auth.userId)
    return res.status(404).json({ error: "project_not_found" });
  await deleteProject(req.params.projectId);
  res.json({ ok: true });
});

app.get("/api/admin/projects/:projectId", requireAdmin, async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: "project_not_found" });
  res.json({ project });
});

app.get("/api/admin/projects/:projectId/stats", requireAdmin, async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: "project_not_found" });
  const stats = await getProjectStats(req.params.projectId);
  res.json({ stats });
});

app.get(
  "/api/admin/projects/:projectId/assistant-instructions",
  requireAdmin,
  async (req, res) => {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: "project_not_found" });
    if (!project.assistant_id) return res.status(400).json({ error: "assistant_id_missing" });
    if (!project.openai_api_key) return res.status(400).json({ error: "openai_api_key_missing" });

    const fallback = project.instructions || "";
    
    if (!isLikelyAssistantId(project.assistant_id)) {
      return res.json({
        instructions: fallback,
        source: "project",
        error: "assistant_id_invalid",
      });
    }
    
    try {
      const instructions = await fetchAssistantInstructions({
        apiKey: project.openai_api_key,
        assistantId: project.assistant_id,
      });
      res.json({ instructions, source: "assistant" });
    } catch (err) {
      const status = err?.status || err?.statusCode || 500;
      const message = err?.message || String(err);
      const payload = {
        instructions: fallback,
        source: "project",
        error: "failed_to_fetch_assistant",
        message,
      };

      if (status === 404) {
        console.info("assistant instructions fetch error (not found)", message);
        return res.json({ ...payload, error: "assistant_not_found" });
      }

      console.warn("assistant instructions fetch error", message);
      res.json(payload);
    }
  }
);

app.patch("/api/admin/projects/:projectId", requireAdmin, async (req, res) => {
  const current = await getProject(req.params.projectId);
  if (!current) return res.status(404).json({ error: "project_not_found" });
  
  const patch = {};

  if (typeof req.body?.name === "string") patch.name = req.body.name;
  if (typeof req.body?.assistant_id === "string") patch.assistant_id = req.body.assistant_id;

  // ✅ ВОТ ЭТА СТРОКА РЕШАЕТ ПРОБЛЕМУ: позволяет сохранять API key при PATCH
  if (typeof req.body?.openai_api_key === "string") patch.openai_api_key = req.body.openai_api_key;

  if (typeof req.body?.instructions === "string") patch.instructions = req.body.instructions;
  if (Array.isArray(req.body?.allowed_origins)) patch.allowed_origins = req.body.allowed_origins.map(String);
  if (Object.hasOwn(req.body || {}, "owner_id")) {
    patch.owner_id = typeof req.body.owner_id === "string" && req.body.owner_id ? req.body.owner_id : null;
  }

  if (typeof req.body?.telegram_code === "string") {
    const code = req.body.telegram_code.trim();
    if (code) {
      const token = await consumeTelegramSecret(code);
      if (!token) return res.status(400).json({ error: "invalid_telegram_code" });
      await addProjectTelegramChat({
        projectId: current.id,
        chatId: token.chat_id,
        chatType: token.chat_type,
      });
      if (!current.telegram_chat_id) {
        patch.telegram_chat_id = token.chat_id;
      }
      if (!current.telegram_connected_at) {
        patch.telegram_connected_at = new Date();
      }
    }
  }

  if (req.body?.unlink_telegram === true) {
    await deleteProjectTelegramChats(current.id);
    patch.telegram_chat_id = null;
    patch.telegram_connected_at = null;
  }

  const project = await updateProject(req.params.projectId, patch);
  if (!project) return res.status(404).json({ error: "project_not_found" });
  
  const assistantId = patch.assistant_id ?? current.assistant_id;
  const apiKey = patch.openai_api_key ?? current.openai_api_key;
  const instructions = patch.instructions ?? current.instructions;

  if (
    typeof req.body?.instructions === "string" &&
    assistantId &&
    apiKey &&
    isLikelyAssistantId(assistantId)
  ) {
    try {
      await updateAssistantInstructions({ apiKey, assistantId, instructions });
    } catch (err) {
      console.warn("assistant instructions update failed", err?.message || err);
      return res
        .status(500)
        .json({ error: "failed_to_update_assistant", message: err?.message || "" });
    }
  }
  
  res.json({ project });
});

// Chats and messages (scoped by project)
app.get("/api/admin/projects/:projectId/chats", requireAdmin, async (req, res) => {
  const { projectId } = req.params;
  await closeInactiveChats({ projectId });
  const status = req.query.status ? String(req.query.status) : null;
  const mode = req.query.mode ? String(req.query.mode) : null;
  const items = await listChats({ projectId, status, mode });
  const withNames = items.map((chat) => ({
    ...chat,
    display_name: getChatDisplayName(chat.id),
  }));
  res.json({ items: withNames });
});

app.get("/api/user/projects/:projectId/chats", requireUser, async (req, res) => {
  const { projectId } = req.params;
  const project = await getProject(projectId);
  if (!project || project.owner_id !== req.auth.userId)
    return res.status(404).json({ error: "project_not_found" });

  await closeInactiveChats({ projectId });
  const status = req.query.status ? String(req.query.status) : null;
  const mode = req.query.mode ? String(req.query.mode) : null;
  const items = await listChats({ projectId, status, mode });
  const withNames = items.map((chat) => ({
    ...chat,
    display_name: getChatDisplayName(chat.id),
  }));
  res.json({ items: withNames });
});

app.get("/api/admin/chats/:chatId/messages", requireAdmin, async (req, res) => {
  const items = await listMessages(req.params.chatId);
  res.json({ items });
});

app.get("/api/user/chats/:chatId/messages", requireUser, async (req, res) => {
  const chat = await getChatById(req.params.chatId);
  if (!chat) return res.status(404).json({ error: "chat_not_found" });

  const project = await getProject(chat.project_id);
  if (!project || project.owner_id !== req.auth.userId)
    return res.status(404).json({ error: "chat_not_found" });

  const items = await listMessages(chat.id);
  res.json({ items });
});

app.post("/api/user/chats/:chatId/takeover", requireUser, async (req, res) => {
  const chat = await getChatById(req.params.chatId);
  if (!chat) return res.status(404).json({ error: "chat_not_found" });

  const project = await getProject(chat.project_id);
  if (!project || project.owner_id !== req.auth.userId)
    return res.status(404).json({ error: "chat_not_found" });

  const updated = await setChatMode(chat.id, "human");
  res.json({ chat: updated });
});

app.post("/api/user/chats/:chatId/release", requireUser, async (req, res) => {
  const chat = await getChatById(req.params.chatId);
  if (!chat) return res.status(404).json({ error: "chat_not_found" });

  const project = await getProject(chat.project_id);
  if (!project || project.owner_id !== req.auth.userId)
    return res.status(404).json({ error: "chat_not_found" });

  const updated = await setChatMode(chat.id, "assistant");
  res.json({ chat: updated });
});

app.post("/api/user/chats/:chatId/message", requireUser, async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "empty" });

  const chat = await getChatById(req.params.chatId);
  if (!chat) return res.status(404).json({ error: "chat_not_found" });

  const project = await getProject(chat.project_id);
  if (!project || project.owner_id !== req.auth.userId)
    return res.status(404).json({ error: "chat_not_found" });

  await addMessage({ chatId: chat.id, role: "human", content: text });

  try {
    if (project?.openai_api_key) {
      await syncOperatorToThread(project.openai_api_key, chat.thread_id, text);
    }
  } catch (e) {
    console.warn("syncOperatorToThread error:", e?.message || e);
  }

  res.json({ ok: true });
});

app.post("/api/admin/chats/:chatId/takeover", requireAdmin, async (req, res) => {
  const chat = await setChatMode(req.params.chatId, "human");
  res.json({ chat });
});

app.post("/api/admin/chats/:chatId/release", requireAdmin, async (req, res) => {
  const chat = await setChatMode(req.params.chatId, "assistant");
  res.json({ chat });
});

app.post("/api/admin/chats/:chatId/message", requireAdmin, async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "empty" });

  const chat = await getChatById(req.params.chatId);
  if (!chat) return res.status(404).json({ error: "chat_not_found" });

  await addMessage({ chatId: chat.id, role: "human", content: text });

  try {
    const project = await getProject(chat.project_id);
    if (project?.openai_api_key) {
      await syncOperatorToThread(project.openai_api_key, chat.thread_id, text);
    }
  } catch (e) {
    console.warn("syncOperatorToThread error:", e?.message || e);
  }

  res.json({ ok: true });
});

app.delete("/api/admin/chats/:chatId", requireAdmin, async (req, res) => {
  const ok = await deleteChat(req.params.chatId);
  if (!ok) return res.status(404).json({ error: "chat_not_found" });
  res.json({ ok: true });
});

app.use((req, res) => res.status(404).json({ error: "not_found" }));

const port = Number(process.env.PORT || 3000);
app.listen(port, async () => {
  await ensureSchema();
  await pool.query("SELECT 1");
  console.log(`[ai-widget] listening on :${port}`);
});
