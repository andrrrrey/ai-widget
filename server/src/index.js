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
  findUserByEmail,
  createProject,
  listProjects,
  getProject,
  updateProject,
  deleteProject,
  createChat,
  getChatById,
  listChats,
  listMessages,
  addMessage,
  setChatMode,
  touchChat,
} from "./lib/store.js";
import { widgetCors } from "./lib/widgetCors.js";
import { fetchAssistantInstructions, runAssistantStream, syncOperatorToThread } from "./lib/openai.js";

dotenv.config({ path: "/var/www/ai-widget/server/.env" });

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

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    await touchChat(chatId);
    await addMessage({ chatId, role: "user", content: message });

    if (chat.mode === "human") {
      send("waiting_for_human", { chatId });
      send("done", { chatId });
      return res.end();
    }

    const project = await getProject(projectId);
    if (!project) {
      send("error", { message: "project_not_found" });
      send("done", { chatId });
      return res.end();
    }
    if (!project.assistant_id) {
      send("error", { message: "assistant_id is empty for this project" });
      send("done", { chatId });
      return res.end();
    }
    if (!project.openai_api_key) {
      send("error", { message: "openai_api_key is empty for this project" });
      send("done", { chatId });
      return res.end();
    }

    send("meta", { chatId, mode: "assistant" });

    await runAssistantStream({
      apiKey: project.openai_api_key,
      threadId: chat.thread_id,
      assistantId: project.assistant_id,
      additionalInstructions: project.instructions || "",
      userMessage: message,
      onToken: (t) => send("token", { t }),
      onTool: (tool) => send("tool", tool),
      onDone: async (fullText) => {
        if (fullText && fullText.trim()) {
          await addMessage({ chatId, role: "assistant", content: fullText });
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

app.get(
  "/api/admin/projects/:projectId/assistant-instructions",
  requireAdmin,
  async (req, res) => {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: "project_not_found" });
    if (!project.assistant_id) return res.status(400).json({ error: "assistant_id_missing" });
    if (!project.openai_api_key) return res.status(400).json({ error: "openai_api_key_missing" });

    try {
      const instructions = await fetchAssistantInstructions({
        apiKey: project.openai_api_key,
        assistantId: project.assistant_id,
      });
      res.json({ instructions });
    } catch (err) {
      console.warn("assistant instructions fetch error", err?.message || err);
      res
        .status(500)
        .json({ error: "failed_to_fetch_assistant", message: err?.message || "" });
    }
  }
);

app.patch("/api/admin/projects/:projectId", requireAdmin, async (req, res) => {
  const patch = {};

  if (typeof req.body?.name === "string") patch.name = req.body.name;
  if (typeof req.body?.assistant_id === "string") patch.assistant_id = req.body.assistant_id;

  // ✅ ВОТ ЭТА СТРОКА РЕШАЕТ ПРОБЛЕМУ: позволяет сохранять API key при PATCH
  if (typeof req.body?.openai_api_key === "string") patch.openai_api_key = req.body.openai_api_key;

  if (typeof req.body?.instructions === "string") patch.instructions = req.body.instructions;
  if (Array.isArray(req.body?.allowed_origins)) patch.allowed_origins = req.body.allowed_origins.map(String);
  if (typeof req.body?.owner_id === "string") patch.owner_id = req.body.owner_id;

  const project = await updateProject(req.params.projectId, patch);
  if (!project) return res.status(404).json({ error: "project_not_found" });
  res.json({ project });
});

// Chats and messages (scoped by project)
app.get("/api/admin/projects/:projectId/chats", requireAdmin, async (req, res) => {
  const { projectId } = req.params;
  const status = req.query.status ? String(req.query.status) : null;
  const mode = req.query.mode ? String(req.query.mode) : null;
  const items = await listChats({ projectId, status, mode });
  res.json({ items });
});

app.get("/api/admin/chats/:chatId/messages", requireAdmin, async (req, res) => {
  const items = await listMessages(req.params.chatId);
  res.json({ items });
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

app.use((req, res) => res.status(404).json({ error: "not_found" }));

const port = Number(process.env.PORT || 3000);
app.listen(port, async () => {
  await ensureSchema();
  await pool.query("SELECT 1");
  console.log(`[ai-widget] listening on :${port}`);
});
