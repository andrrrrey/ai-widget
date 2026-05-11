(function () {
  const script = document.currentScript;
  const projectId = script.getAttribute("data-project-id");
  const title = script.getAttribute("data-title") || "Чат с помощником";
  const position = script.getAttribute("data-position") || "right";
  const embed = script.getAttribute("data-embed") === "true";
  const embedWidth = script.getAttribute("data-embed-width");
  const embedHeight = script.getAttribute("data-embed-height");
  const embedCenter = script.getAttribute("data-embed-center") === "true";
  
  if (!projectId) {
    console.error("[ai-widget] data-project-id is required");
    return;
  }

  if (embed) {
    document.documentElement.style.height = "100%";
    document.body.style.height = "100%";
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
    if (embedCenter) {
      document.body.style.display = "flex";
      document.body.style.alignItems = "center";
      document.body.style.justifyContent = "center";
    }
  }
  
  const BASE = new URL(script.src).origin;

  // Load CSS
  const cssUrl = BASE + "/widget/widget.css";
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = cssUrl;
  document.head.appendChild(link);

  // Visitor id
  const visitorKey = "aiw_visitor_id";
  let visitorId = localStorage.getItem(visitorKey);
  if (!visitorId) {
    visitorId = (crypto?.randomUUID?.() || String(Math.random()).slice(2) + Date.now());
    localStorage.setItem(visitorKey, visitorId);
  }

  let chatId = null;
  let isOpen = false;

 // UI
  let btn = null;
  let overlay = null;
  let overlayClose = null;
  let notifyBadge = null;
  let notifyBubble = null;

  if (!embed) {
    btn = document.createElement("button");
    btn.className = "aiw-fab " + (position === "left" ? "aiw-left" : "aiw-right");
    btn.innerHTML = "💬";
    notifyBadge = document.createElement("span");
    notifyBadge.className = "aiw-notify-badge";
    notifyBadge.textContent = "1";

    notifyBubble = document.createElement("div");
    notifyBubble.className = "aiw-notify-bubble";
    notifyBubble.textContent = "Спроси здесь ИИ";

    btn.appendChild(notifyBadge);
    btn.appendChild(notifyBubble);

    overlay = document.createElement("div");
    overlay.className = "aiw-overlay";

    overlayClose = document.createElement("button");
    overlayClose.className = "aiw-overlay-close";
    overlayClose.setAttribute("aria-label", "Закрыть окно чата");
    overlayClose.textContent = "✕";
  }

  const panel = document.createElement("div");
  panel.className = "aiw-panel";
  if (embed) panel.classList.add("aiw-embed");
  if (embedWidth) panel.style.width = embedWidth;
  if (embedHeight) panel.style.height = embedHeight;
  if (embed && embedCenter) panel.style.margin = "0";
  panel.innerHTML = `
    <div class="aiw-shell">
      <div class="aiw-hero">
        <svg class="aiw-sparkle" viewBox="0 0 64 64" fill="currentColor" aria-hidden="true">
          <path d="M33.6 10.2c.4-1.5 2.5-1.5 2.9 0l1.5 5.3c.1.4.4.7.8.8l5.3 1.5c1.5.4 1.5 2.5 0 2.9l-5.3 1.5c-.4.1-.7.4-.8.8l-1.5 5.3c-.4 1.5-2.5 1.5-2.9 0l-1.5-5.3c-.1-.4-.4-.7-.8-.8L26 20.7c-1.5-.4-1.5-2.5 0-2.9l5.3-1.5c.4-.1.7-.4.8-.8l1.5-5.3z"/>
          <path d="M18.4 28.8c.3-1.1 1.9-1.1 2.2 0l1 3.6c.1.3.3.5.6.6l3.6 1c1.1.3 1.1 1.9 0 2.2l-3.6 1c-.3.1-.5.3-.6.6l-1 3.6c-.3 1.1-1.9 1.1-2.2 0l-1-3.6c-.1-.3-.3-.5-.6-.6l-3.6-1c-1.1-.3-1.1-1.9 0-2.2l3.6-1c.3-.1.5-.3.6-.6l1-3.6z"/>
        </svg>
        <div class="aiw-title">Как я могу помочь?</div>
      </div>

      <div class="aiw-chat" aria-label="Chat messages" id="aiw-msgs"></div>
      <div class="aiw-status" id="aiw-status"></div>

      <div class="aiw-composerWrap">
        <form class="aiw-composer" id="aiw-form" role="group" aria-label="Message composer">
          <textarea
            class="aiw-input"
            id="aiw-input"
            placeholder="Спросите что-нибудь..."
            rows="1"
            aria-label="Введите сообщение"
          ></textarea>
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

  if (btn) document.body.appendChild(btn);
  if (overlay) document.body.appendChild(overlay);
  if (overlayClose) document.body.appendChild(overlayClose);
  document.body.appendChild(panel);

  const form = panel.querySelector("#aiw-form");
  const input = panel.querySelector("#aiw-input");
  const msgs = panel.querySelector("#aiw-msgs");
  const statusEl = panel.querySelector("#aiw-status");

  let shouldAutoScroll = true;

  // --- streaming state (чтобы polling не “затирал” печатающийся пузырь)
  const streamState = {
    active: false,
    assistantPEl: null, // <p> внутри пузыря ассистента
    acc: "",
    rafScroll: 0,
  };

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

  function scheduleScrollDuringStream() {
    if (!shouldAutoScroll) return;
    if (streamState.rafScroll) return;
    streamState.rafScroll = requestAnimationFrame(() => {
      streamState.rafScroll = 0;
      // во время стрима — только auto, иначе будет “прыгать”
      scrollToBottom(false);
    });
  }

  function renderMarkdown(text) {
    const escaped = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
    return escaped.replace(
      /\[([^\]]*)\]\((https?:\/\/[^)]*)\)|(https?:\/\/[^\s<")\]]+)/g,
      (_, linkText, linkUrl, plainUrl) => {
        const url = linkUrl || plainUrl;
        const label = linkText || url;
        return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      }
    );
  }

  function setRole(el, role) {
    const isUser = role === "user";
    el.className = "aiw-msg " + (isUser ? "aiw-right" : "aiw-left");
    const label = el.querySelector(".aiw-label");
    if (label) label.textContent = isUser ? "Я" : role === "human" ? "Оператор" : "ИИ";
  }

  function append(role, text, opts = {}) {
    const stickToBottom = opts.forceScroll || shouldAutoScroll;
    const item = document.createElement("div");
    item.className = "aiw-msg";
    const label = document.createElement("div");
    label.className = "aiw-label";

    const bubble = document.createElement("div");
    bubble.className = "aiw-bubble";
    const p = document.createElement("p");
    if (role === "user") {
      p.textContent = text;
    } else {
      p.innerHTML = renderMarkdown(text);
    }
    bubble.appendChild(p);

    item.appendChild(label);
    item.appendChild(bubble);

    setRole(item, role);

    msgs.appendChild(item);
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
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error || "start_failed");
    chatId = j.chatId;
    return chatId;
  }

  function renderMessages(items) {
    // ВАЖНО: во время streamState.active ничего не рендерим с сервера,
    // чтобы не “стёрло” печатающийся пузырь.
    if (streamState.active) return;

    const wasAtBottom = isAtBottom();

    // “Мягкая” синхронизация:
    // - обновляем существующие по индексу
    // - дорисовываем недостающее
    // - не удаляем лишнее (это может быть локальная отрисовка, пока сервер догоняет)
    items.forEach((item, idx) => {
      const existing = msgs.children[idx];
      if (existing) {
        setRole(existing, item.role);
        const bubbleText = existing.querySelector(".aiw-bubble p");
        if (bubbleText && bubbleText.textContent !== item.content) {
          if (item.role === "user") {
            bubbleText.textContent = item.content;
          } else {
            bubbleText.innerHTML = renderMarkdown(item.content);
          }
        }
      } else {
        append(item.role, item.content, { forceScroll: wasAtBottom });
      }
    });

    if (wasAtBottom) scrollToBottom(true);
  }

  let pollTimer = null;
  let pollInFlight = false;

  async function syncMessages() {
    if (!chatId || pollInFlight) return;
    if (streamState.active) return;
    pollInFlight = true;
    try {
      const r = await fetch(`${BASE}/api/widget/${projectId}/chat/${chatId}/messages`);
      if (!r.ok) throw new Error("messages_failed");
      const j = await r.json().catch(() => ({}));
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

  // --- textarea autosize (растёт вниз при вводе)
  function autoResizeTextarea(el) {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 180) + "px"; // максимум ~8-9 строк
  }
  autoResizeTextarea(input);

  input.addEventListener("input", () => autoResizeTextarea(input));

  // Enter = send, Shift+Enter = newline
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit?.();
    }
  });

  async function sendMessage(text) {
    await ensureChat();

    append("user", text);
    input.value = "";
    autoResizeTextarea(input);
    input.focus();

    setStatus("Печатает…");

    // На время SSE отключаем polling, чтобы не было “пропаданий”
    stopPollingMessages();
    streamState.active = true;
    streamState.assistantPEl = null;
    streamState.acc = "";

    const url = `${BASE}/api/widget/${projectId}/chat/${chatId}/stream?message=${encodeURIComponent(text)}`;
    const es = new EventSource(url);

    const finalizeStream = async (opts = {}) => {
      streamState.active = false;
      try {
        es.close();
      } catch {}
      if (!opts.keepStatus) setStatus("");

      // один раз синкнём, чтобы подтянуть финальный текст из БД
      await syncMessages();

      // включим polling обратно
      startPollingMessages();
    };

    es.addEventListener("token", (e) => {
      const data = JSON.parse(e.data);
      const t = data.t || "";

      if (!streamState.assistantPEl) {
        // Создаём пузырь ассистента один раз и дальше дописываем в него
        streamState.assistantPEl = append("assistant", "");
      }

      streamState.acc += t;
      streamState.assistantPEl.innerHTML = renderMarkdown(streamState.acc);

      // автоскролл без smooth, иначе “прыжки”
      scheduleScrollDuringStream();
    });

    es.addEventListener("waiting_for_human", async () => {
      setStatus("Оператор подключился. Подождите, пожалуйста…");
      await finalizeStream({ keepStatus: true });
    });

    es.addEventListener("error", async (e) => {
      let msg = "Ошибка";
      try {
        const data = e?.data ? JSON.parse(e.data) : null;
        if (data?.message) msg = "Ошибка: " + data.message;
      } catch {}
      setStatus(msg);
      await finalizeStream({ keepStatus: true });
    });

    es.addEventListener("done", async () => {
      await finalizeStream();
    });
  }

  async function openPanel() {
    isOpen = true;
    if (btn) btn.classList.add("aiw-hide");
    if (overlay) overlay.classList.add("aiw-show");
    if (overlayClose) overlayClose.classList.add("aiw-visible");
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
    if (overlay) overlay.classList.remove("aiw-show");
    if (overlayClose) overlayClose.classList.remove("aiw-visible");
    panel.classList.remove("aiw-open");
    stopPollingMessages();
    if (btn) setTimeout(() => btn.classList.remove("aiw-hide"), 200);
  }

  if (btn) {
    btn.addEventListener("click", async () => {
      if (isOpen) closePanel();
      else await openPanel();
    });
  }

  if (overlayClose) overlayClose.addEventListener("click", closePanel);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = String(input.value || "").trim();
    if (!text) return;
    try {
      await sendMessage(text);
    } catch (err) {
      console.error(err);
      setStatus("Не удалось отправить сообщение");
      streamState.active = false;
      startPollingMessages();
    }
  });

  msgs.addEventListener("scroll", () => {
    shouldAutoScroll = isAtBottom();
  });
  
  if (notifyBadge && notifyBubble) {
    setTimeout(() => {
      notifyBadge.classList.add("aiw-notify-show");
      notifyBubble.classList.add("aiw-notify-show");
    }, 3000);
  }

  if (embed) {
    openPanel();
  }
})();
