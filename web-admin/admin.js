const $ = (s) => document.querySelector(s);

let selectedProjectId = null;
let selectedChatId = null;
let selectedChatName = null;
let pollTimer = null;
let projectsCache = [];
let usersCache = [];
let currentSession = null;
let currentProjectOwnerId = null;
let currentPage = "chats";

const isAdmin = () => currentSession?.role === "admin";

function projectApiBase(){
  return isAdmin() ? "/api/admin/projects" : "/api/user/projects";
}

function chatApiBase(){
  return isAdmin() ? "/api/admin/chats" : "/api/user/chats";
}

async function fetchAssistantInstructions(projectId){
  if(!isAdmin()) return null;
  try {
    const data = await api(`/api/admin/projects/${projectId}/assistant-instructions`);
    return data?.instructions || "";
  } catch (err) {
    console.warn("assistant instructions load failed", err);
    return null;
  }
}

async function api(path, opts={}){
  const r = await fetch(path, { credentials:"include", ...opts });
  const ct = r.headers.get("content-type")||"";
  const data = ct.includes("application/json") ? await r.json() : await r.text();
  if(!r.ok) throw Object.assign(new Error(data?.error || "api_error"), { data, status:r.status });
  return data;
}

function escapeHtml(s){
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function showPage(page){
  currentPage = page;
  const pages = { chats: "#pageChats", settings: "#pageSettings", users: "#pageUsers", stats: "#pageStats" };
  Object.entries(pages).forEach(([key, sel])=>{
    const el = $(sel);
    if(el) el.style.display = key === page ? "block" : "none";
  });
}

function applyRoleVisibility(){
  document.querySelectorAll(".adminOnly").forEach(el => {
    el.style.display = isAdmin() ? "" : "none";
  });
}

async function login(){
  $("#loginErr").textContent = "";
  const login = $("#login").value.trim();
  const password = $("#password").value;
  const session = await api("/api/admin/login", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ login, password })
  });
  currentSession = session;
  applyRoleVisibility();
  $("#loginBox").style.display = "none";
  $("#app").style.display = "flex";
  showPage("chats");
  if(isAdmin()) await refreshUsers();
  await refreshProjects(true);
}

async function logout(){
  await api("/api/admin/logout", { method:"POST" });
  location.reload();
}

async function restoreSession(){
  try {
    const session = await api("/api/admin/session");
    currentSession = session;
    applyRoleVisibility();
    $("#loginBox").style.display = "none";
    $("#app").style.display = "flex";
    showPage("chats");
    if(isAdmin()) await refreshUsers();
    await refreshProjects(true);
  } catch (err) {
    $("#loginBox").style.display = "block";
    $("#app").style.display = "none";
  }
}

async function refreshProjects(autoSelectFirst=false){
  const j = await api(projectApiBase());
  const items = j.items || [];
  projectsCache = items;
  const sel = $("#projectSelect");
  sel.innerHTML = "";
  for(const p of items){
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }

  if(autoSelectFirst && items[0]){
    selectedProjectId = items[0].id;
    sel.value = selectedProjectId;
  } else if(selectedProjectId){
    sel.value = selectedProjectId;
  } else if(items[0]){
    selectedProjectId = items[0].id;
    sel.value = selectedProjectId;
  }

  if(selectedProjectId) await loadProject(selectedProjectId);
  await refreshChats();
  if(currentPage === "stats") await refreshStats();
}

async function createProject(){
  const name = prompt("Название проекта", "Новый проект")?.trim();
  if(!name) return;
  const j = await api(projectApiBase(), {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ name, openai_api_key:"", assistant_id:"", instructions:"", allowed_origins:[] })
  });
  selectedProjectId = j.project.id;
  await refreshProjects(false);
  $("#projectSelect").value = selectedProjectId;
  await loadProject(selectedProjectId);
  if(isAdmin()) await refreshChats();
}

async function loadProject(projectId){
  const j = await api(`${projectApiBase()}/${projectId}`);
  const p = j.project;
  selectedProjectId = p.id;
  currentProjectOwnerId = p.owner_id || null;

  const projectName = projectsCache.find(x => x.id === p.id)?.name || "Проект";
  $("#projectBadge").textContent = projectName;
  $("#projectId").textContent = p.id;
  $("#apiKey").value = p.openai_api_key || "";
  $("#assistantId").value = p.assistant_id || "";
  let instructions = p.instructions || "";
  if(isAdmin() && p.assistant_id){
    const ai = await fetchAssistantInstructions(p.id);
    if(typeof ai === "string" && ai) instructions = ai;
  }
  $("#instructions").value = instructions;
  $("#origins").value = (p.allowed_origins || []).join("\n");

  if(isAdmin()) renderOwnerSelect(currentProjectOwnerId);
  renderTelegramSection(p);
}

async function refreshStats(){
  if(!selectedProjectId) return;
  $("#statsErr").textContent = "";
  const base = isAdmin() ? "/api/admin/projects" : "/api/user/projects";
  try {
    const j = await api(`${base}/${selectedProjectId}/stats`);
    renderStats(j.stats);
  } catch (err) {
    $("#statsErr").textContent = "Не удалось загрузить статистику проекта.";
  }
}

function renderStats(stats){
  const totalChats = stats?.totalChats ?? 0;
  const chatsWithContacts = stats?.chatsWithContacts ?? 0;
  const avgQuestions = stats?.avgQuestionsPerChat ?? 0;
  const avgFormatted = Number.isFinite(avgQuestions)
    ? avgQuestions.toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 })
    : "0";
  $("#statsTotalChats").textContent = totalChats.toLocaleString("ru-RU");
  $("#statsChatsWithContacts").textContent = chatsWithContacts.toLocaleString("ru-RU");
  $("#statsAvgQuestions").textContent = avgFormatted;

  const ratio = totalChats ? Math.min(1, chatsWithContacts / totalChats) : 0;
  $("#statsContactsBar").style.width = `${Math.round(ratio * 100)}%`;
  $("#statsContactsMeta").textContent = totalChats
    ? `${Math.round(ratio * 100)}% чатов с контактами`
    : "Нет данных для расчёта доли";
}

async function saveProject(){
  if(!selectedProjectId) return;
  $("#saveOk").textContent = "";

  const openai_api_key = $("#apiKey").value.trim();
  const assistant_id = $("#assistantId").value.trim();
  const instructions = $("#instructions").value;
  const allowed_origins = $("#origins").value
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);
  const owner_id = isAdmin()
    ? ($("#projectOwner")?.value?.trim() || null)
    : undefined;

  const url = `${projectApiBase()}/${selectedProjectId}`;

  await api(url, {
    method:"PATCH",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ openai_api_key, assistant_id, instructions, allowed_origins, owner_id })
  });

  if(isAdmin()) currentProjectOwnerId = owner_id;
  $("#saveOk").textContent = "Сохранено";
  setTimeout(()=> $("#saveOk").textContent = "", 1400);
}

function renderTelegramSection(project){
  const statusEl = $("#telegramStatus");
  const infoEl = $("#telegramInfo");
  const errEl = $("#telegramErr");
  const okEl = $("#telegramOk");
  errEl.textContent = "";
  okEl.textContent = "";

  if(project.telegram_chat_id){
    statusEl.textContent = "Подключено";
    statusEl.className = "pill";
    const connectedAt = project.telegram_connected_at
      ? new Date(project.telegram_connected_at).toLocaleString()
      : "";
    infoEl.textContent = `Чат ID: ${project.telegram_chat_id}${connectedAt ? ` • с ${connectedAt}` : ""}`;
  } else {
    statusEl.textContent = "Не подключено";
    statusEl.className = "pill muted";
    infoEl.textContent = "Получите код в Telegram-боте AI Widget и вставьте его здесь.";
  }
}

function renderOwnerSelect(ownerId){
  const select = $("#projectOwner");
  if(!select) return;
  select.innerHTML = "";
  const optNone = document.createElement("option");
  optNone.value = "";
  optNone.textContent = "Без владельца";
  select.appendChild(optNone);
  for(const u of usersCache){
    const opt = document.createElement("option");
    opt.value = u.id;
    opt.textContent = u.email;
    select.appendChild(opt);
  }
  select.value = ownerId || "";
}

async function linkTelegram(){
  if(!selectedProjectId) return;
  const code = $("#telegramCode").value.trim();
  $("#telegramErr").textContent = "";
  $("#telegramOk").textContent = "";
  if(!code){
    $("#telegramErr").textContent = "Введите код из бота";
    return;
  }

  try {
    await api(`${projectApiBase()}/${selectedProjectId}`, {
      method:"PATCH",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ telegram_code: code })
    });
    $("#telegramOk").textContent = "Телеграм подключён";
    $("#telegramCode").value = "";
    await loadProject(selectedProjectId);
  } catch(err){
    const codeName = err?.data?.error || err?.message || "api_error";
    if(codeName === "invalid_telegram_code"){
      $("#telegramErr").textContent = "Неверный или использованный код";
    } else {
      $("#telegramErr").textContent = "Не удалось подключить Телеграм";
    }
  }
}

async function unlinkTelegram(){
  if(!selectedProjectId) return;
  $("#telegramErr").textContent = "";
  $("#telegramOk").textContent = "";
  try {
    await api(`${projectApiBase()}/${selectedProjectId}`, {
      method:"PATCH",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ unlink_telegram: true })
    });
    $("#telegramOk").textContent = "Телеграм отключён";
    await loadProject(selectedProjectId);
  } catch(err){
    $("#telegramErr").textContent = "Не удалось отключить";
  }
}

async function deleteProject(){
  if(!selectedProjectId) return;
  if(!confirm("Удалить текущий проект? Это действие нельзя отменить.")) return;
  await api(`${projectApiBase()}/${selectedProjectId}`, { method:"DELETE" });
  selectedProjectId = null;
  resetChatView();
  await refreshProjects(true);
}

async function refreshChats(){
  if(!selectedProjectId) return;
  const mode = $("#filterMode").value;
  const status = $("#filterStatus").value;
  const qs = new URLSearchParams();
  if(mode) qs.set("mode", mode);
  if(status) qs.set("status", status);

  const base = isAdmin()
    ? `/api/admin/projects/${selectedProjectId}/chats`
    : `/api/user/projects/${selectedProjectId}/chats`;
  const j = await api(`${base}?${qs.toString()}`);
  renderChats(j.items || []);
}

function renderChats(items){
  const box = $("#chatList");
  box.innerHTML = "";
  if(!items.length){
    box.innerHTML = `<div class="muted">Пока нет чатов</div>`;
    return;
  }
  const formatStatus = (status) => {
    if(status === "closed") return "Закрытый";
    if(status === "open") return "Открытый";
    return status || "-";
  };
  for(const c of items){
    const title = c.display_name || c.id;
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <div class="row" style="justify-content:space-between">
        <div>
          <div style="font-weight:700">${escapeHtml(title)}</div>
          <div class="mono muted" style="font-size:12px">${escapeHtml(c.id)}</div>
        </div>
        <span class="pill">${escapeHtml(c.mode)} • ${escapeHtml(formatStatus(c.status))}</span>
      </div>
      <div class="muted">updated: ${new Date(c.updated_at).toLocaleString()}</div>
      <div class="muted">visitor: ${escapeHtml(c.visitor_id || "-")}</div>
    `;
    div.addEventListener("click", ()=> openChat(c));
    box.appendChild(div);
  }
}

async function openChat(chat){
  const chatId = typeof chat === "string" ? chat : chat?.id;
  if(!chatId) return;
  selectedChatId = chatId;
  selectedChatName = typeof chat === "object" ? (chat.display_name || chat.id) : chatId;
  $("#chatPlaceholder").style.display = "none";
  $("#chatBox").style.display = "block";
  $("#chatId").textContent = selectedChatName || chatId;
  await refreshChatView();
  startPolling();
}

async function refreshChatView(){
  if(!selectedChatId) return;
  const messagesUrl = isAdmin()
    ? `/api/admin/chats/${selectedChatId}/messages`
    : `/api/user/chats/${selectedChatId}/messages`;
  const items = await api(messagesUrl);
  renderMessages(items.items || []);

  const chatsUrl = isAdmin()
    ? `/api/admin/projects/${selectedProjectId}/chats`
    : `/api/user/projects/${selectedProjectId}/chats`;
  const chats = await api(chatsUrl);
  const chat = (chats.items || []).find(x => x.id === selectedChatId);
  if(chat){
    selectedChatName = chat.display_name || chat.id;
    $("#chatId").textContent = selectedChatName;
    $("#chatMode").textContent = chat.mode;
  } else {
    $("#chatMode").textContent = "unknown";
  }
}

function renderMessages(items){
  const box = $("#messages");
  box.innerHTML = "";
  for(const m of items){
    const div = document.createElement("div");
    div.className = "msg " + m.role;
    div.innerHTML = `<div class="bubble">${escapeHtml(m.content)}</div>`;
    box.appendChild(div);
  }
  box.scrollTop = box.scrollHeight;
}

function startPolling(){
  if(pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async ()=>{
    try{ await refreshChatView(); } catch {}
  }, 1500);
}

async function takeover(){
  if(!selectedChatId) return;
  await api(`${chatApiBase()}/${selectedChatId}/takeover`, { method:"POST" });
  await refreshChats();
  await refreshChatView();
}

async function release(){
  if(!selectedChatId) return;
  await api(`${chatApiBase()}/${selectedChatId}/release`, { method:"POST" });
  await refreshChats();
  await refreshChatView();
}

async function deleteChat(){
  if(!selectedChatId || !isAdmin()) return;
  if(!confirm("Удалить этот чат? Сообщения будут удалены без возможности восстановления.")) return;
  await api(`/api/admin/chats/${selectedChatId}`, { method:"DELETE" });
  resetChatView();
  await refreshChats();
}

async function sendHuman(e){
  e.preventDefault();
  if(!selectedChatId) return;
  const textEl = $("#humanText");
  const text = textEl.value.trim();
  if(!text) return;

  try {
    await takeover();
  } catch (err) {
    console.warn("takeover failed", err);
    return;
  }
  
  await api(`${chatApiBase()}/${selectedChatId}/message`, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ text })
  });
  textEl.value = "";
  await refreshChatView();
}

function resetChatView(){
  selectedChatId = null;
  $("#chatBox").style.display = "none";
  $("#chatPlaceholder").style.display = "flex";
}

async function refreshUsers(){
  if(!isAdmin()) return;
  const j = await api("/api/admin/users");
  usersCache = j.items || [];
  renderUsers(usersCache);
  if(selectedProjectId) renderOwnerSelect(currentProjectOwnerId);
}

function renderUsers(items){
  const box = $("#userList");
  box.innerHTML = "";
  if(!items.length){
    box.innerHTML = `<div class="muted">Пока нет пользователей</div>`;
    return;
  }

  for(const u of items){
    const div = document.createElement("div");
    div.className = "userRow";
    div.innerHTML = `
      <div class="userInfo">
        <div class="mono">${escapeHtml(u.email)}</div>
        <div class="muted">Создан: ${new Date(u.created_at).toLocaleString()}</div>
      </div>
      <div class="userActions">
        <span class="pill">${escapeHtml(u.role)}</span>
        <button class="ghost btnUserPassword" type="button">Сменить пароль</button>
        <button class="ghost danger btnUserDelete" type="button">Удалить</button>
      </div>
    `;
    div.querySelector(".btnUserPassword").addEventListener("click", ()=> changeUserPassword(u));
    div.querySelector(".btnUserDelete").addEventListener("click", ()=> removeUser(u));
    box.appendChild(div);
  }
}

async function changeUserPassword(user){
  const password = prompt(`Новый пароль для ${user.email}`)?.trim();
  if(!password) return;
  $("#userErr").textContent = "";
  $("#userOk").textContent = "";
  try{
    await api(`/api/admin/users/${user.id}`, {
      method:"PATCH",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ password })
    });
    $("#userOk").textContent = "Пароль обновлён";
    setTimeout(()=> $("#userOk").textContent = "", 2000);
  } catch(err){
    $("#userErr").textContent = "Не удалось обновить пароль";
  }
}

async function removeUser(user){
  if(!confirm(`Удалить пользователя ${user.email}?`)) return;
  $("#userErr").textContent = "";
  $("#userOk").textContent = "";
  try{
    await api(`/api/admin/users/${user.id}`, { method:"DELETE" });
    $("#userOk").textContent = "Пользователь удалён";
    await refreshUsers();
    if(selectedProjectId) await loadProject(selectedProjectId);
    setTimeout(()=> $("#userOk").textContent = "", 2000);
  } catch(err){
    $("#userErr").textContent = "Не удалось удалить пользователя";
  }
}

async function createUserFromForm(e){
  if(!isAdmin()) return;
  e.preventDefault();
  $("#userErr").textContent = "";
  $("#userOk").textContent = "";
  const email = $("#newUserEmail").value.trim().toLowerCase();
  const password = $("#newUserPassword").value;
  if(!email || !password){
    $("#userErr").textContent = "Укажите email и пароль";
    return;
  }

  try{
    await api("/api/admin/users", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ email, password })
    });

    $("#newUserEmail").value = "";
    $("#newUserPassword").value = "";
    $("#userOk").textContent = "Пользователь создан";
    await refreshUsers();
    setTimeout(()=> $("#userOk").textContent = "", 2000);
  } catch(err){
    const code = err?.data?.error || err?.message || "api_error";
    if(code === "user_exists"){
      $("#userErr").textContent = "Такой пользователь уже существует";
    } else if(code === "email_and_password_required"){
      $("#userErr").textContent = "Нужно указать email и пароль";
    } else {
      $("#userErr").textContent = "Не удалось создать пользователя. Попробуйте ещё раз.";
    }
  }
}

$("#btnLogin").addEventListener("click", ()=> login().catch(e => $("#loginErr").textContent = "Ошибка входа"));
$("#btnLogout").addEventListener("click", ()=> logout().catch(()=>{}));
$("#btnRefreshProjects").addEventListener("click", ()=> refreshProjects(false).catch(()=>{}));
$("#btnCreateProject").addEventListener("click", ()=> createProject().catch(()=>{}));
$("#btnSaveProject").addEventListener("click", ()=> saveProject().catch(()=>{}));
$("#btnDeleteProject").addEventListener("click", ()=> deleteProject().catch(()=>{}));
$("#btnRefreshChats").addEventListener("click", ()=> refreshChats().catch(()=>{}));
$("#projectSelect").addEventListener("change", async (e)=>{
  selectedProjectId = e.target.value;
  resetChatView();
  await loadProject(selectedProjectId);
  await refreshChats();
  if(currentPage === "stats") await refreshStats();
});
$("#btnRelease").addEventListener("click", ()=> release().catch(()=>{}));
$("#btnDeleteChat").addEventListener("click", ()=> deleteChat().catch(()=>{}));
$("#humanForm").addEventListener("submit", sendHuman);
$("#btnOpenSettings").addEventListener("click", ()=> showPage("settings"));
$("#btnBackToChats").addEventListener("click", ()=> showPage("chats"));
$("#btnOpenStats").addEventListener("click", ()=>{ showPage("stats"); refreshStats().catch(()=>{}); });
$("#btnOpenUsers").addEventListener("click", ()=>{ showPage("users"); refreshUsers().catch(()=>{}); });
$("#btnRefreshStats").addEventListener("click", ()=> refreshStats().catch(()=>{}));
$("#btnBackFromStats").addEventListener("click", ()=> showPage("chats"));
$("#btnLinkTelegram").addEventListener("click", ()=> linkTelegram().catch(()=>{}));
$("#btnUnlinkTelegram").addEventListener("click", ()=> unlinkTelegram().catch(()=>{}));
$("#userForm").addEventListener("submit", (e)=> createUserFromForm(e).catch(()=>{}));
$("#btnBackFromUsers").addEventListener("click", ()=> showPage("chats"));

showPage("chats");
restoreSession();