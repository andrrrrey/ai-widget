import OpenAI from "openai";

function getClient(apiKey) {
  const key = apiKey || "";
  if (!key) throw new Error("openai_api_key is missing for this project");
  return new OpenAI({ apiKey: key });
}

export async function ensureThread(apiKey) {
  const client = getClient(apiKey);
  const thread = await client.beta.threads.create();
  return thread.id;
}

export async function syncOperatorToThread(apiKey, threadId, text) {
  const client = getClient(apiKey);
  await client.beta.threads.messages.create(threadId, {
    role: "assistant",
    content: `[OPERATOR] ${text}`,
  });
}

export async function runAssistantStream({ apiKey,
  threadId,
  assistantId,
  additionalInstructions,
  userMessage,
  onToken,
  onTool,
  onDone,
  onError,
}) {
  const client = getClient(apiKey);
  await client.beta.threads.messages.create(threadId, { role: "user", content: userMessage });

  // Prefer streaming if SDK supports it
  try {
    const streamFn = client.beta?.threads?.runs?.stream;
    if (typeof streamFn === "function") {
      let full = "";
      const stream = await client.beta.threads.runs.stream(threadId, {
        assistant_id: assistantId,
        additional_instructions: additionalInstructions || "",
      });

      stream.on("event", (e) => {
        if (e?.event?.startsWith("thread.run.step")) onTool?.({ event: e.event });
      });

      stream.on("textDelta", (delta) => {
        const t = delta?.value || "";
        if (t) {
          full += t;
          onToken?.(t);
        }
      });

      stream.on("error", (err) => onError?.(err));
      stream.on("end", async () => onDone?.(full));
      return;
    }
  } catch {
    // fall back to polling
  }

  // Polling fallback
  try {
    const run = await client.beta.threads.runs.create(threadId, {
      assistant_id: assistantId,
      additional_instructions: additionalInstructions || "",
    });

    const started = Date.now();
    while (true) {
      const r = await client.beta.threads.runs.retrieve(threadId, run.id);
      if (r.status === "completed") break;
      if (["failed", "cancelled", "expired"].includes(r.status)) {
        throw new Error(`Run ended with status: ${r.status}`);
      }
      if (Date.now() - started > 120_000) throw new Error("Run timeout (120s)");
      await new Promise((x) => setTimeout(x, 800));
    }

    const msgs = await client.beta.threads.messages.list(threadId, { limit: 20 });
    const last = msgs.data.find((m) => m.role === "assistant");
    const text = last?.content?.[0]?.text?.value || "";
    if (text) onToken?.(text);
    onDone?.(text);
  } catch (err) {
    onError?.(err);
  }
}

export async function fetchAssistantInstructions({ apiKey, assistantId }) {
  const client = getClient(apiKey);
  const assistant = await client.beta.assistants.retrieve(assistantId);
  return assistant?.instructions || "";
}

export async function updateAssistantInstructions({ apiKey, assistantId, instructions }) {
  const client = getClient(apiKey);
  await client.beta.assistants.update(assistantId, {
    instructions: instructions || "",
  });  
}