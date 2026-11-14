import type { Business, EnvMap } from "./types";

export type LlmMode = "tools" | "rephrase";

export type LlmSettings = {
  provider: "groq" | "gemini" | "none";
  mode: LlmMode;
  ready: boolean;
  model: string;
  baseUrl: string;
  apiKey: string;
  reasoningEffort?: string;
  detail: string;
};

export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

export type ChatResult = {
  content: string;
  toolCalls: ToolCall[];
};

const GROQ_MODEL = "openai/gpt-oss-120b";
const GROQ_BASE = "https://api.groq.com/openai/v1";

export function resolveLlm(env: EnvMap): LlmSettings {
  const requested = (env.LLM_PROVIDER ?? "groq").toLowerCase();
  const mode: LlmMode = env.LLM_MODE === "rephrase" ? "rephrase" : "tools";
  if (requested === "none" || requested === "off" || requested === "builtin") {
    return {
      provider: "none",
      mode,
      ready: false,
      model: "",
      baseUrl: "",
      apiKey: "",
      detail: "Built-in receptionist. Set LLM_PROVIDER=groq to use Groq.",
    };
  }
  if (requested === "gemini") {
    const apiKey = env.GEMINI_API_KEY ?? "";
    const model = env.GEMINI_MODEL || "gemini-2.0-flash";
    return {
      provider: "gemini",
      mode,
      ready: Boolean(apiKey),
      model,
      baseUrl: (env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai").replace(/\/$/, ""),
      apiKey,
      detail: apiKey
        ? `Gemini · ${model}`
        : "LLM_PROVIDER=gemini but GEMINI_API_KEY is empty. The built-in receptionist is answering.",
    };
  }
  const apiKey = env.GROQ_API_KEY ?? "";
  const model = env.GROQ_MODEL || GROQ_MODEL;
  return {
    provider: "groq",
    mode,
    ready: Boolean(apiKey),
    model,
    baseUrl: (env.GROQ_BASE_URL || GROQ_BASE).replace(/\/$/, ""),
    apiKey,
    reasoningEffort: env.GROQ_REASONING_EFFORT || "low",
    detail: apiKey
      ? `Groq · ${model} · free tier · ${mode} mode. A Groq error falls back to the built-in receptionist for that turn.`
      : `Groq · ${model} is the default, but GROQ_API_KEY is empty. The built-in receptionist is answering so the demo still runs.`,
  };
}

export function systemPrompt(business: Business): string {
  const services = business.services
    .map((service) => `${service.name} [${service.id}] ${service.price}, ${service.duration_minutes} min. ${service.description}`)
    .join("\n");
  const faqs = business.faqs.map((faq) => `${faq.triggers[0]}: ${faq.answer}`).join("\n");
  return [
    `You are ${business.assistant_name}, answering the phone at ${business.name}.`,
    "Speak in one or two short spoken sentences. No lists, no markdown.",
    "Never invent a price, a policy, or an open time. Prices and hours below are the only ones you may quote.",
    "Before you say a time is open, call check_availability. Before you tell the caller they are booked, call book_appointment and wait for ok:true.",
    "Collect a name and a mobile number before booking. Pass start as the ISO timestamp from check_availability.",
    "If the caller asks more than one question, answer every part in the same reply. Include the price and the hours when both are asked. Never answer only one part of a two-part question.",
    "If they ask for a person, manager, or owner, call transfer_call so the live call is forwarded. If they say goodbye, call end_call.",
    `Address: ${business.address}.`,
    `Hours: ${business.hours_speech}`,
    `Services:\n${services}`,
    `Policies: ${business.policies.cancellation} ${business.policies.payment} ${business.policies.dropoff}`,
    faqs ? `Notes:\n${faqs}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_shop_info",
      description:
        "Look up hours, address, services, a price, or shop policies. If the caller asked more than one thing, pass their words as question so every part is answered.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", enum: ["hours", "address", "services", "pricing", "policies"] },
          service: { type: "string" },
          question: { type: "string", description: "The caller's question, verbatim, when they asked more than one thing." },
        },
        required: ["topic"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_availability",
      description: "Find open appointment slots. Always call this before offering a time.",
      parameters: {
        type: "object",
        properties: {
          service: { type: "string", description: "Service name or id" },
          when: { type: "string", description: "When they want to come, in their words" },
        },
        required: ["service", "when"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "book_appointment",
      description: "Book a slot that check_availability just returned.",
      parameters: {
        type: "object",
        properties: {
          service: { type: "string" },
          name: { type: "string" },
          phone: { type: "string" },
          start: { type: "string", description: "ISO start from check_availability" },
          email: { type: "string" },
          vehicle: { type: "string" },
        },
        required: ["service", "name", "phone", "start"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "transfer_call",
      description: "Transfer the caller to a person at the shop.",
      parameters: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "end_call",
      description: "The caller is done.",
      parameters: { type: "object", properties: {} },
    },
  },
];

type Message = Record<string, unknown>;

export function spokenText(content: string | null | undefined): string {
  if (!content) return "";
  return content
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\|[^|]*\|>/g, "")
    .trim();
}

function asArgs(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

export function parseChat(payload: unknown): ChatResult {
  const root = (payload ?? {}) as { choices?: Array<{ message?: { content?: string | null; tool_calls?: unknown[] } }> };
  const message = root.choices?.[0]?.message;
  const toolCalls: ToolCall[] = [];
  for (const raw of message?.tool_calls ?? []) {
    const call = raw as { id?: string; function?: { name?: string; arguments?: unknown } };
    const name = call.function?.name;
    if (!name) continue;
    toolCalls.push({ id: call.id || `tool_${toolCalls.length}`, name, args: asArgs(call.function?.arguments) });
  }
  return { content: spokenText(message?.content), toolCalls };
}

export async function chatComplete(
  settings: LlmSettings,
  body: { messages: Message[]; tools?: unknown; tool_choice?: string; max_completion_tokens?: number },
  fetchImpl: typeof fetch = fetch,
): Promise<ChatResult> {
  if (!settings.ready) throw new Error(settings.detail);
  const payload: Record<string, unknown> = {
    model: settings.model,
    temperature: 0.3,
    max_completion_tokens: body.max_completion_tokens ?? 500,
    messages: body.messages,
  };
  if (body.tools) payload.tools = body.tools;
  if (body.tool_choice) payload.tool_choice = body.tool_choice;
  if (settings.provider === "groq" && settings.reasoningEffort && settings.model.includes("gpt-oss")) {
    payload.reasoning_effort = settings.reasoningEffort;
  }

  const send = (current: Record<string, unknown>) =>
    fetchImpl(`${settings.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(current),
      signal: AbortSignal.timeout(20_000),
    });

  let response = await send(payload);
  if (response.status === 400 && "reasoning_effort" in payload) {
    const text = await response.text();
    if (/reasoning/i.test(text)) {
      delete payload.reasoning_effort;
      response = await send(payload);
    } else {
      throw new Error(`LLM 400: ${text.slice(0, 240)}`);
    }
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM ${response.status}: ${text.slice(0, 240)}`);
  }
  return parseChat(await response.json());
}

const CLAIM = /\$[\d,]+(?:\s*(?:to|–|-)\s*\$[\d,]+)?|\b\d{1,2}:\d{2}\s*(?:AM|PM)\b|\(\d{3}\)\s*\d{3}-\d{4}/gi;

export function keepsFacts(original: string, rewritten: string): boolean {
  const facts = original.match(CLAIM) ?? [];
  const next = rewritten.toLowerCase();
  return facts.every((fact) => next.includes(fact.toLowerCase()));
}

export async function rephraseLine(settings: LlmSettings, line: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const result = await chatComplete(
    settings,
    {
      max_completion_tokens: 180,
      messages: [
        {
          role: "system",
          content:
            "Rewrite the receptionist's line so it sounds natural spoken aloud. Keep every price, time, date, phone number, and address unchanged. Do not add facts. One or two sentences. Return only the line.",
        },
        { role: "user", content: line },
      ],
    },
    fetchImpl,
  );
  const next = spokenText(result.content);
  if (!next || !keepsFacts(line, next)) return line;
  return next;
}
