import { systemPrompt, TOOLS } from "./llm";
import { e164 } from "./nlu";
import type { Business, EnvMap } from "./types";

export type VapiModelChoice = { provider: string; model?: string; version?: string };

export function publicBase(env: EnvMap): string {
  return (env.PUBLIC_BASE_URL || env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
}

export function transferDestination(business: Business, env: EnvMap): string {
  return e164(env.TRANSFER_NUMBER || env.VAPI_TRANSFER_NUMBER || business.transfer_number);
}

export function vapiModelChoice(env: EnvMap): VapiModelChoice {
  const provider = (env.VAPI_MODEL_PROVIDER || "vapi").trim().toLowerCase() || "vapi";
  const requested = env.VAPI_MODEL?.trim();
  if (provider === "groq") return { provider: "groq", model: requested || "openai/gpt-oss-120b" };
  if (provider === "vapi") return requested ? { provider: "vapi", model: requested, version: "latest" } : { provider: "vapi", version: "latest" };
  return { provider, model: requested || "gpt-4o-mini" };
}

const SERVER_TOOLS = new Set(["check_availability", "book_appointment", "get_shop_info"]);

export function buildVapiAssistant(business: Business, env: EnvMap) {
  const base = publicBase(env);
  const serverUrl = base ? `${base}/api/webhooks/vapi` : undefined;
  const server = serverUrl ? { url: serverUrl } : undefined;
  const number = transferDestination(business, env);
  const model = vapiModelChoice(env);
  const tools = [
    ...TOOLS.filter((tool) => SERVER_TOOLS.has(tool.function.name)).map((tool) => ({
      type: "function" as const,
      function: tool.function,
      ...(server ? { server } : {}),
    })),
    {
      type: "transferCall" as const,
      destinations: [
        {
          type: "number" as const,
          number,
          message: "I'll connect you with the shop now.",
          description: "A person at the shop",
          transferPlan: { mode: "blind-transfer" as const },
        },
      ],
      ...(server ? { server } : {}),
      function: {
        name: "transfer_call",
        description: "Forward the live call to a person at the shop.",
        parameters: {
          type: "object",
          properties: {
            destination: {
              type: "string",
              enum: [number],
              description: "The shop number to transfer to.",
            },
            reason: { type: "string" },
          },
          required: ["destination"],
        },
      },
    },
    {
      type: "endCall" as const,
      ...(server ? { server } : {}),
      function: {
        name: "end_call",
        description: "The caller is done. Say goodbye and hang up.",
        parameters: { type: "object", properties: {} },
      },
      messages: [{ type: "request-start", content: `Thanks for calling ${business.name}. Have a good one.` }],
    },
  ];
  return {
    name: `${business.name} ${business.assistant_name}`,
    firstMessage: business.greeting,
    ...(serverUrl ? { serverUrl } : {}),
    ...(env.VAPI_WEBHOOK_SECRET ? { serverUrlSecret: env.VAPI_WEBHOOK_SECRET } : {}),
    ...(serverUrl
      ? { server: { url: serverUrl, ...(env.VAPI_WEBHOOK_SECRET ? { secret: env.VAPI_WEBHOOK_SECRET } : {}) } }
      : {}),
    serverMessages: ["tool-calls", "transfer-destination-request", "status-update", "end-of-call-report", "function-call"],
    model: {
      ...model,
      messages: [{ role: "system", content: systemPrompt(business) }],
      tools,
    },
    voice: { provider: env.VAPI_VOICE_PROVIDER || "vapi", voiceId: env.VAPI_VOICE_ID || "Elliot" },
    endCallMessage: `Thanks for calling ${business.name}. Have a good one.`,
  };
}

export function buildRetellLlm(business: Business, env: EnvMap) {
  const base = publicBase(env);
  const url = base ? `${base}/api/webhooks/retell` : undefined;
  const number = transferDestination(business, env);
  const custom = (name: string, description: string, parameters: unknown) => ({
    type: "custom" as const,
    name,
    description,
    ...(url ? { url } : {}),
    speak_during_execution: false,
    speak_after_execution: true,
    parameters,
  });
  return {
    model: env.RETELL_MODEL || "gpt-4.1-mini",
    general_prompt: systemPrompt(business),
    general_tools: [
      ...TOOLS.filter((tool) => SERVER_TOOLS.has(tool.function.name)).map((tool) =>
        custom(tool.function.name, tool.function.description, tool.function.parameters),
      ),
      {
        type: "transfer_call" as const,
        name: "transfer_call",
        description: "Forward the live call to a person at the shop. Cold transfer, included in the call.",
        transfer_destination: { type: "predefined" as const, number },
        transfer_option: { type: "cold_transfer" as const, show_transferee_as_caller: false },
      },
      { type: "end_call" as const, name: "end_call", description: "The caller is done." },
    ],
  };
}

export function loosenVapiPayload<T>(payload: T): T {
  const copy = structuredClone(payload) as {
    serverUrl?: string;
    model?: { tools?: Array<{ type?: string; server?: unknown }> };
  };
  delete copy.serverUrl;
  for (const tool of copy.model?.tools ?? []) {
    if (tool.type && tool.type !== "function") delete tool.server;
  }
  return copy as T;
}

export async function syncVapiAssistant(input: {
  apiKey: string;
  assistantId?: string;
  payload: unknown;
  fetchImpl?: typeof fetch;
  apiBase?: string;
}): Promise<{ id: string; created: boolean }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = (input.apiBase ?? "https://api.vapi.ai").replace(/\/$/, "");
  const id = input.assistantId?.trim();
  const created = !id;
  const url = id ? `${base}/assistant/${encodeURIComponent(id)}` : `${base}/assistant`;
  const send = (body: unknown) =>
    fetchImpl(url, {
      method: created ? "POST" : "PATCH",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  let response = await send(input.payload);
  if (response.status === 400) {
    const text = await response.text();
    response = await send(loosenVapiPayload(input.payload));
    if (!response.ok) {
      const again = await response.text();
      throw new Error(`Vapi ${created ? "create" : "update"} failed (${response.status}): ${(again || text).slice(0, 300)}`);
    }
  } else if (!response.ok) {
    const text = await response.text();
    throw new Error(`Vapi ${created ? "create" : "update"} failed (${response.status}): ${text.slice(0, 300)}`);
  }
  const json = (await response.json()) as { id?: string };
  const nextId = json.id || id;
  if (!nextId) throw new Error("Vapi did not return an assistant id");
  return { id: nextId, created };
}
