const $ = (s) => document.querySelector(s);

let selectedProjectId = null;
let selectedChatId = null;
let pollTimer = null;

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

async function login(){
  $("#loginErr").textContent = "";
  const login = $("#login").value.trim();
  const password = $("#password").value;
  await api("/api/admin/login", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ login, password })
  });
  $("#loginBox").style.display = "none";
  $("#app").style.display = "block";
  await refreshProjects(true);
}

async function logout(){
  await api("/api/admin/logout", { method:"POST" });
  location.reload();
}

async function refreshProjects(autoSelectFirst=false){
  const j = await api("/api/admin/projects");
  const items = j.items || [];
  const sel = $("#projectSelect");
  sel.innerHTML = "";
  for(const p of items){
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = `${p.name} — ${p.id}`;
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
}

async function createProject(){
  const name = $("#newName").value.trim() || "New Project";
  const j = await api("/api/admin/projects", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ name, openai_api_key:"", assistant_id:"", instructions:"", allowed_origins:[] })
  });
  $("#newName").value = "";
  selectedProjectId = j.project.id;
  await refreshProjects(false);
  $("#projectSelect").value = selectedProjectId;
  await loadProject(selectedProjectId);
  await refreshChats();
}

async function loadProject(projectId){
  const j = await api(`/api/admin/projects/${projectId}`);
  const p = j.project;
  selectedProjectId = p.id;

  $("#projectId").textContent = p.id;
  $("#apiKey").value = p.openai_api_key || "";
  $("#assistantId").value = p.assistant_id || "";
  $("#instructions").value = p.instructions || "";
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

  await api(`/api/admin/projects/${selectedProjectId}`, {
    method:"PATCH",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ openai_api_key, assistant_id, instructions, allowed_origins })
  });

  $("#saveOk").textContent = "Сохранено";
  setTimeout(()=> $("#saveOk").textContent = "", 1400);
}

async function refreshChats(){
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
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <div class="row" style="justify-content:space-between">
        <div class="mono">${escapeHtml(c.id)}</div>
        <span class="pill">${escapeHtml(c.mode)} • ${escapeHtml(c.status)}</span>
      </div>
      <div class="muted">updated: ${new Date(c.updated_at).toLocaleString()}</div>
      <div class="muted">visitor: ${escapeHtml(c.visitor_id || "-")}</div>
    `;
    div.addEventListener("click", ()=> openChat(c.id));
    box.appendChild(div);
  }
}

async function openChat(chatId){
  selectedChatId = chatId;
  $("#chatBox").style.display = "block";
  $("#chatId").textContent = chatId;
  await refreshChatView();
  startPolling();
}

async function refreshChatView(){
  if(!selectedChatId) return;
  const items = await api(`/api/admin/chats/${selectedChatId}/messages`);
  renderMessages(items.items || []);

  const chats = await api(`/api/admin/projects/${selectedProjectId}/chats`);
  const chat = (chats.items || []).find(x => x.id === selectedChatId);
  $("#chatMode").textContent = chat ? chat.mode : "unknown";
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
  await api(`/api/admin/chats/${selectedChatId}/takeover`, { method:"POST" });
  await refreshChats();
  await refreshChatView();
}

async function release(){
  if(!selectedChatId) return;
  await api(`/api/admin/chats/${selectedChatId}/release`, { method:"POST" });
  await refreshChats();
  await refreshChatView();
}

async function sendHuman(e){
  e.preventDefault();
  if(!selectedChatId) return;
  const textEl = $("#humanText");
  const text = textEl.value.trim();
  if(!text) return;

  await api(`/api/admin/chats/${selectedChatId}/message`, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ text })
  });
  textEl.value = "";
  await refreshChatView();
}

$("#btnLogin").addEventListener("click", ()=> login().catch(e => $("#loginErr").textContent = "Ошибка входа"));
$("#btnLogout").addEventListener("click", ()=> logout().catch(()=>{}));
$("#btnRefreshProjects").addEventListener("click", ()=> refreshProjects(false).catch(()=>{}));
$("#btnCreateProject").addEventListener("click", ()=> createProject().catch(()=>{}));
$("#btnSaveProject").addEventListener("click", ()=> saveProject().catch(()=>{}));
$("#btnRefreshChats").addEventListener("click", ()=> refreshChats().catch(()=>{}));
$("#projectSelect").addEventListener("change", async (e)=>{
  selectedProjectId = e.target.value;
  selectedChatId = null;
  $("#chatBox").style.display = "none";
  await loadProject(selectedProjectId);
  await refreshChats();
});
$("#btnTakeover").addEventListener("click", ()=> takeover().catch(()=>{}));
$("#btnRelease").addEventListener("click", ()=> release().catch(()=>{}));
$("#humanForm").addEventListener("submit", sendHuman);
