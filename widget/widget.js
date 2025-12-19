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
        <svg class="aiw-sparkle" viewBox="0 0 64 64" fill="currentColor" aria-hidden="true">
          <path d="M33.6 10.2c.4-1.5 2.5-1.5 2.9 0l1.5 5.3c.1.4.4.7.8.8l5.3 1.5c1.5.4 1.5 2.5 0 2.9l-5.3 1.5c-.4.1-.7.4-.8.8l-1.5 5.3c-.4 1.5-2.5 1.5-2.9 0l-1.5-5.3c-.1-.4-.4-.7-.8-.8L26 20.7c-1.5-.4-1.5-2.5 0-2.9l5.3-1.5c.4-.1.7-.4.8-.8l1.5-5.3z"/>
          <path d="M18.4 28.8c.3-1.1 1.9-1.1 2.2 0l1 3.6c.1.3.3.5.6.6l3.6 1c1.1.3 1.1 1.9 0 2.2l-3.6 1c-.3.1-.5.3-.6.6l-1 3.6c-.3 1.1-1.9 1.1-2.2 0l-1-3.6c-.1-.3-.3-.5-.6-.6l-3.6-1c-1.1-.3-1.1-1.9 0-2.2l3.6-1c.3-.1.5-.3.6-.6l1-3.6z"/>
        </svg>
        <div class="aiw-title">Ask our AI anything</div>
      </div>

      <div class="aiw-chat" aria-label="Chat messages" id="aiw-msgs"></div>
      <div class="aiw-status" id="aiw-status"></div>

      <div class="aiw-composerWrap">
        <form class="aiw-composer" id="aiw-form" role="group" aria-label="Message composer">
          <input class="aiw-input" id="aiw-input" placeholder="Ask me anything about your projects" autocomplete="off"/>
          <button class="aiw-send" type="submit" aria-label="Send">
            <svg viewBox="0 0 24 24" fill="none" stroke="rgba(130,140,155,.95)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M22 2L11 13" />
              <path d="M22 2L15 22l-4-9-9-4 20-7z" />
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

  let renderedCount = 0;
  let shouldAutoScroll = true;

  function setStatus(text) {
    statusEl.textContent = text || "";
  }

  function isAtBottom() {
    const threshold = 24;
    return msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight <= threshold;
  }

  function scrollToBottom(useSmooth = true) {
    msgs.scrollTo({ top: msgs.scrollHeight, behavior: useSmooth ? "smooth" : "auto" });
  }

  function append(role, text, opts = {}) {
    const stickToBottom = opts.forceScroll || shouldAutoScroll;
    const item = document.createElement("div");
    const isUser = role === "user";
    item.className = "aiw-msg " + (isUser ? "aiw-right" : "aiw-left");

    const label = document.createElement("div");
    label.className = "aiw-label";
    label.textContent = isUser ? "ME" : role === "human" ? "OPERATOR" : "OUR AI";

    const bubble = document.createElement("div");
    bubble.className = "aiw-bubble";
    const p = document.createElement("p");
    p.textContent = text;
    bubble.appendChild(p);

    item.appendChild(label);
    item.appendChild(bubble);

    msgs.appendChild(item);
    renderedCount++;
    if (stickToBottom) scrollToBottom(true);
    return p;
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

  function renderMessages(items) {
    const wasAtBottom = isAtBottom();

    if (msgs.children.length > items.length) {
      msgs.innerHTML = "";
      renderedCount = 0;
    }

    items.forEach((item, idx) => {
      const existing = msgs.children[idx];
      if (existing) {
        const bubbleText = existing.querySelector(".aiw-bubble p");
        if (bubbleText && bubbleText.textContent !== item.content) {
          bubbleText.textContent = item.content;
        }
      } else {
        append(item.role, item.content, { forceScroll: wasAtBottom });
      }
    });

    renderedCount = items.length;
    if (wasAtBottom) scrollToBottom(true);
  }

  let pollTimer = null;
  let pollInFlight = false;

  async function syncMessages() {
    if (!chatId || pollInFlight) return;
    pollInFlight = true;
    try {
      const r = await fetch(`${BASE}/api/widget/${projectId}/chat/${chatId}/messages`);
      if (!r.ok) throw new Error("messages_failed");
      const j = await r.json();
      if (Array.isArray(j.items)) renderMessages(j.items);
    } catch (e) {
      console.warn("syncMessages failed", e);
    } finally {
      pollInFlight = false;
    }
  }

  function startPollingMessages() {
    if (pollTimer) return;
    pollTimer = setInterval(syncMessages, 2000);
  }

  function stopPollingMessages() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
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

    let assistantText = null;
    let acc = "";

    es.addEventListener("token", (e) => {
      const data = JSON.parse(e.data);
      const t = data.t || "";
      if (!assistantText) {
        assistantText = append("assistant", "");
      }
      acc += t;
      assistantText.textContent = acc;
      if (shouldAutoScroll) scrollToBottom(true);
    });

    es.addEventListener("waiting_for_human", () => {
      setStatus("Оператор подключился. Подождите, пожалуйста…");
      startPollingMessages();
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
      await syncMessages();
      startPollingMessages();
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
    stopPollingMessages();
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

  msgs.addEventListener("scroll", () => {
    shouldAutoScroll = isAtBottom();
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
