(function () {
  const script = document.currentScript;
  const projectId = script.getAttribute("data-project-id");
  const title = script.getAttribute("data-title") || "Чат с помощником";
  const position = script.getAttribute("data-position") || "right";

  if (!projectId) {
    console.error("[ai-widget] data-project-id is required");
    return;
  }

  const BASE = new URL(script.src).origin; // https://loginov.futuguru.com

  const cssUrl = BASE + "/widget/widget.css";
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = cssUrl;
  document.head.appendChild(link);

  const visitorKey = "aiw_visitor_id";
  let visitorId = localStorage.getItem(visitorKey);
  if (!visitorId) {
    visitorId = (crypto?.randomUUID?.() || String(Math.random()).slice(2) + Date.now());
    localStorage.setItem(visitorKey, visitorId);
  }

  let chatId = null;
  let isOpen = false;

  // UI
  const btn = document.createElement("button");
  btn.className = "aiw-fab " + (position === "left" ? "aiw-left" : "aiw-right");
  btn.innerHTML = "💬";

  const overlay = document.createElement("div");
  overlay.className = "aiw-overlay";

  const overlayClose = document.createElement("button");
  overlayClose.className = "aiw-overlay-close";
  overlayClose.setAttribute("aria-label", "Закрыть окно чата");
  overlayClose.textContent = "✕";

  const panel = document.createElement("div");
  panel.className = "aiw-panel";
  panel.innerHTML = `
    <div class="aiw-shell">
      <div class="aiw-hero">
        <div class="aiw-mark" aria-hidden="true">
          <svg width="26" height="26" viewBox="0 0 26 26" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M13 0.75C13.4142 0.75 13.75 1.08579 13.75 1.5V4.25C13.75 4.66421 13.4142 5 13 5C12.5858 5 12.25 4.66421 12.25 4.25V1.5C12.25 1.08579 12.5858 0.75 13 0.75Z" fill="#0B1220"/>
            <path d="M13 21C13.4142 21 13.75 21.3358 13.75 21.75V24.5C13.75 24.9142 13.4142 25.25 13 25.25C12.5858 25.25 12.25 24.9142 12.25 24.5V21.75C12.25 21.3358 12.5858 21 13 21Z" fill="#0B1220"/>
            <path d="M21 13C21 13.4142 21.3358 13.75 21.75 13.75H24.5C24.9142 13.75 25.25 13.4142 25.25 13C25.25 12.5858 24.9142 12.25 24.5 12.25H21.75C21.3358 12.25 21 12.5858 21 13Z" fill="#0B1220"/>
            <path d="M0.75 13C0.75 13.4142 1.08579 13.75 1.5 13.75H4.25C4.66421 13.75 5 13.4142 5 13C5 12.5858 4.66421 12.25 4.25 12.25H1.5C1.08579 12.25 0.75 12.5858 0.75 13Z" fill="#0B1220"/>
            <circle cx="13" cy="13" r="3.25" stroke="#0B1220" stroke-width="1.5"/>
          </svg>
        </div>
        <div class="aiw-heading">Ask our AI anything</div>
      </div>
      <div class="aiw-body">
        <div class="aiw-messages" id="aiw-msgs"></div>
        <div class="aiw-status" id="aiw-status"></div>
        <form class="aiw-form" id="aiw-form">
          <input class="aiw-input" id="aiw-input" placeholder="Ask me anything about your projects" autocomplete="off"/>
          <button class="aiw-send" type="submit" aria-label="Send">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M3.5 12L20.5 3.5L16 20.5L12.5 13.5L3.5 12Z" stroke="white" stroke-width="1.6" stroke-linejoin="round"/>
            </svg>
          </button>
        </form>
      </div>
    </div>
  `;

  document.body.appendChild(btn);
  document.body.appendChild(overlay);
  document.body.appendChild(overlayClose);
  document.body.appendChild(panel);

  const form = panel.querySelector("#aiw-form");
  const input = panel.querySelector("#aiw-input");
  const msgs = panel.querySelector("#aiw-msgs");
  const statusEl = panel.querySelector("#aiw-status");

  function setStatus(text) {
    statusEl.textContent = text || "";
  }

  function append(role, text) {
    const item = document.createElement("div");
    item.className = "aiw-msg aiw-" + role;
    item.innerHTML = `<div class="aiw-bubble">${escapeHtml(text)}</div>`;
    msgs.appendChild(item);
    msgs.scrollTop = msgs.scrollHeight;
    return item;
  }

  async function ensureChat() {
    if (chatId) return chatId;
    const r = await fetch(`${BASE}/api/widget/${projectId}/chat/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitorId }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error || "start_failed");
    chatId = j.chatId;
    return chatId;
  }

  async function sendMessage(text) {
    await ensureChat();

    append("user", text);
    input.value = "";
    input.focus();

    setStatus("Печатает…");

    // Stream assistant via SSE
    const url = `${BASE}/api/widget/${projectId}/chat/${chatId}/stream?message=${encodeURIComponent(text)}`;
    const es = new EventSource(url, { withCredentials: true });

    let assistantBubble = null;
    let acc = "";

    es.addEventListener("token", (e) => {
      const data = JSON.parse(e.data);
      const t = data.t || "";
      if (!assistantBubble) {
        assistantBubble = append("assistant", "");
      }
      acc += t;
      assistantBubble.querySelector(".aiw-bubble").textContent = acc;
      msgs.scrollTop = msgs.scrollHeight;
    });

    es.addEventListener("waiting_for_human", () => {
      setStatus("Оператор подключился. Подождите, пожалуйста…");
    });

    es.addEventListener("error", (e) => {
      try {
        const data = JSON.parse(e.data);
        setStatus("Ошибка: " + (data.message || "unknown"));
      } catch {
        setStatus("Ошибка");
      }
      es.close();
    });

    es.addEventListener("done", () => {
      setStatus("");
      es.close();
    });
  }

  async function openPanel() {
    isOpen = true;
    btn.classList.add("aiw-hide");
    overlay.classList.add("aiw-show");
    overlayClose.classList.add("aiw-visible");
    panel.classList.add("aiw-open");
    try {
      await ensureChat();
    } catch (e) {
      console.error(e);
    }
    setTimeout(() => input.focus(), 120);
  }

  function closePanel() {
    isOpen = false;
    overlay.classList.remove("aiw-show");
    overlayClose.classList.remove("aiw-visible");
    panel.classList.remove("aiw-open");
    setTimeout(() => btn.classList.remove("aiw-hide"), 200);
  }

  btn.addEventListener("click", async () => {
    if (isOpen) {
      closePanel();
    } else {
      await openPanel();
    }
  });

  overlayClose.addEventListener("click", closePanel);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = String(input.value || "").trim();
    if (!text) return;
    try {
      await sendMessage(text);
    } catch (err) {
      console.error(err);
      setStatus("Не удалось отправить сообщение");
    }
  });

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
})();
