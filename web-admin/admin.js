const $ = (s) => document.querySelector(s);

let selectedProjectId = null;
let selectedChatId = null;
let selectedChatName = null;
let pollTimer = null;
let projectsCache = [];
let usersCache = [];
let currentSession = null;

const isAdmin = () => currentSession?.role === "admin";

function projectApiBase(){
  return isAdmin() ? "/api/admin/projects" : "/api/user/projects";
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
  if(page === "chats" && !isAdmin()) page = "settings";
  const pages = { chats: "#pageChats", settings: "#pageSettings", users: "#pageUsers" };
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
  showPage(isAdmin() ? "chats" : "settings");
  await refreshProjects(true);
  if(isAdmin()) await refreshUsers();
}

async function logout(){
  await api("/api/admin/logout", { method:"POST" });
  location.reload();
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
  if(isAdmin()) await refreshChats();
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

  const url = `${projectApiBase()}/${selectedProjectId}`;

  await api(url, {
    method:"PATCH",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ openai_api_key, assistant_id, instructions, allowed_origins })
  });

  $("#saveOk").textContent = "Сохранено";
  setTimeout(()=> $("#saveOk").textContent = "", 1400);
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
  if(!isAdmin()){
    const box = $("#chatList");
    if(box) box.innerHTML = `<div class="muted">Работа с чатами доступна только администратору</div>`;
    resetChatView();
    return;
  }
  if(!selectedProjectId) return;
  const mode = $("#filterMode").value;
  const status = $("#filterStatus").value;
  const qs = new URLSearchParams();
  if(mode) qs.set("mode", mode);
  if(status) qs.set("status", status);

  const j = await api(`/api/admin/projects/${selectedProjectId}/chats?${qs.toString()}`);
  renderChats(j.items || []);
}

function renderChats(items){
  const box = $("#chatList");
  box.innerHTML = "";
  if(!items.length){
    box.innerHTML = `<div class="muted">Пока нет чатов</div>`;
    return;
  }
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
        <span class="pill">${escapeHtml(c.mode)} • ${escapeHtml(c.status)}</span>
      </div>
      <div class="muted">updated: ${new Date(c.updated_at).toLocaleString()}</div>
      <div class="muted">visitor: ${escapeHtml(c.visitor_id || "-")}</div>
    `;
    div.addEventListener("click", ()=> openChat(c));
    box.appendChild(div);
  }
}

async function openChat(chat){
  if(!isAdmin()) return;
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
  if(!isAdmin()) return;
  if(!selectedChatId) return;
  const items = await api(`/api/admin/chats/${selectedChatId}/messages`);
  renderMessages(items.items || []);

  const chats = await api(`/api/admin/projects/${selectedProjectId}/chats`);
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
  if(!isAdmin()) return;
  if(pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async ()=>{
    try{ await refreshChatView(); } catch {}
  }, 1500);
}

async function takeover(){
  if(!isAdmin()) return;
  if(!selectedChatId) return;
  await api(`/api/admin/chats/${selectedChatId}/takeover`, { method:"POST" });
  await refreshChats();
  await refreshChatView();
}

async function release(){
  if(!isAdmin()) return;
  if(!selectedChatId) return;
  await api(`/api/admin/chats/${selectedChatId}/release`, { method:"POST" });
  await refreshChats();
  await refreshChatView();
}

async function sendHuman(e){
  if(!isAdmin()) return;
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
  
  await api(`/api/admin/chats/${selectedChatId}/message`, {
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
      <div>
        <div class="mono">${escapeHtml(u.email)}</div>
        <div class="muted">Создан: ${new Date(u.created_at).toLocaleString()}</div>
      </div>
      <span class="pill">${escapeHtml(u.role)}</span>
    `;
    box.appendChild(div);
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
});
$("#btnRelease").addEventListener("click", ()=> release().catch(()=>{}));
$("#humanForm").addEventListener("submit", sendHuman);
$("#btnOpenSettings").addEventListener("click", ()=> showPage("settings"));
$("#btnBackToChats").addEventListener("click", ()=> showPage("chats"));
$("#btnOpenUsers").addEventListener("click", ()=>{ showPage("users"); refreshUsers().catch(()=>{}); });
$("#userForm").addEventListener("submit", (e)=> createUserFromForm(e).catch(()=>{}));
$("#btnBackFromUsers").addEventListener("click", ()=> showPage("chats"));

showPage("chats");
