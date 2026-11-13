import type { FrontDesk } from "./desk";
import { validateTwilioSignature } from "./providers";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function argsOf(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return {};
}

export function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

type VapiTool = { id: string; name: string; args: Record<string, unknown> };

function vapiTools(message: Record<string, unknown>): VapiTool[] {
  const list = (message.toolCallList ?? message.toolCalls ?? message.toolWithToolCallList) as unknown;
  if (Array.isArray(list)) {
    return list
      .map((item, index) => {
        const row = record(item);
        const fn = record(row.function);
        const name = String(fn.name ?? row.name ?? "");
        if (!name) return undefined;
        return { id: String(row.id ?? `tool_${index}`), name, args: argsOf(fn.arguments ?? row.arguments ?? row.parameters) };
      })
      .filter((item): item is VapiTool => Boolean(item));
  }
  const single = record(message.functionCall);
  if (single.name) return [{ id: "function_call", name: String(single.name), args: argsOf(single.parameters ?? single.arguments) }];
  return [];
}

export async function handleVapi(desk: FrontDesk, body: unknown): Promise<unknown> {
  const root = record(body);
  const message = Object.keys(record(root.message)).length ? record(root.message) : root;
  const type = String(message.type ?? "");
  const call = record(message.call);
  const externalId = String(call.id ?? root.callId ?? "vapi");
  const from = String(record(call.customer).number ?? "") || undefined;

  if (type === "assistant-request") return { assistant: desk.vapiAssistant() };

  if (type === "transfer-destination-request") {
    await desk.runExternalTool({
      channel: "vapi",
      externalId,
      from,
      name: "transfer_call",
      args: { reason: "Vapi asked for a transfer destination" },
    });
    const number = desk.transferNumber();
    return {
      destination: { type: "number", number },
      message: { type: "request-start", message: "I'll connect you with the shop now." },
    };
  }

  if (type === "status-update" && String(message.status ?? "") === "forwarding") {
    await desk.runExternalTool({
      channel: "vapi",
      externalId,
      from,
      name: "transfer_call",
      args: { reason: "Vapi is forwarding the call" },
    });
    return { ok: true };
  }

  if (type === "tool-calls" || type === "function-call") {
    const results = [];
    for (const tool of vapiTools(message)) {
      const result = await desk.runExternalTool({ channel: "vapi", externalId, from, name: tool.name, args: tool.args });
      const entry: Record<string, unknown> = { name: tool.name, toolCallId: tool.id, result };
      if (typeof result.number === "string") {
        entry.destination = { type: "number", number: result.number, message: result.speech };
      }
      results.push(entry);
    }
    return { results };
  }

  if (type === "end-of-call-report") {
    const artifact = record(message.artifact);
    const transcript = typeof artifact.transcript === "string" ? artifact.transcript : typeof message.transcript === "string" ? message.transcript : "";
    const summary = typeof message.summary === "string" ? message.summary : "";
    await desk.finishExternal({ channel: "vapi", externalId, from, transcript, summary });
    return { ok: true };
  }
  return { ok: true };
}

export async function handleRetell(desk: FrontDesk, body: unknown): Promise<unknown> {
  const root = record(body);
  const call = record(root.call);
  const externalId = String(call.call_id ?? root.call_id ?? "retell");
  const from = String(call.from_number ?? root.from_number ?? "") || undefined;
  if (typeof root.name === "string") {
    const result = await desk.runExternalTool({
      channel: "retell",
      externalId,
      from,
      name: root.name,
      args: record(root.args),
    });
    const speech = typeof result.speech === "string" ? result.speech : JSON.stringify(result);
    const slots = Array.isArray(result.slots)
      ? (result.slots as Array<{ label?: string; start?: string }>).map((slot) => `${slot.label} | ${slot.start}`).join("\n")
      : "";
    const payload: Record<string, unknown> = { result: slots ? `${speech}\n${slots}` : speech };
    if (typeof result.number === "string") payload.transfer_number = result.number;
    return payload;
  }
  const event = String(root.event ?? "");
  if (event === "call_started") {
    await desk.startCall({ channel: "retell", externalId, from });
    return { ok: true };
  }
  if (event === "call_ended" || event === "call_analyzed") {
    const analysis = record(call.call_analysis);
    await desk.finishExternal({
      channel: "retell",
      externalId,
      from,
      transcript: typeof call.transcript === "string" ? call.transcript : "",
      summary: typeof analysis.call_summary === "string" ? analysis.call_summary : "",
    });
    return { ok: true };
  }
  return { ok: true };
}

export async function handleTwilio(desk: FrontDesk, params: Record<string, string>, baseUrl: string, voice: string): Promise<string> {
  const callSid = params.CallSid || "twilio";
  const from = params.From;
  const speech = params.SpeechResult?.trim();
  const action = `${baseUrl.replace(/\/$/, "")}/api/webhooks/twilio`;
  if (!speech) {
    const call = await desk.startCall({ channel: "twilio", externalId: callSid, from });
    return gather(call.transcript[0]?.text ?? "How can I help you?", action, voice);
  }
  const existing = await desk.startCall({ channel: "twilio", externalId: callSid, from });
  const turn = await desk.handleText(existing.id, speech);
  if (turn.action === "transfer" && turn.call.transfer) {
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${xmlEscape(voice)}">${xmlEscape(turn.say)}</Say><Dial>${xmlEscape(turn.call.transfer.number)}</Dial></Response>`;
  }
  if (turn.action === "end") {
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${xmlEscape(voice)}">${xmlEscape(turn.say)}</Say><Hangup/></Response>`;
  }
  return gather(turn.say, action, voice);
}

function gather(say: string, action: string, voice: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Gather input="speech" action="${xmlEscape(action)}" method="POST" speechTimeout="auto" language="en-US"><Say voice="${xmlEscape(voice)}">${xmlEscape(say)}</Say></Gather><Say voice="${xmlEscape(voice)}">I didn't catch that. Call again anytime.</Say></Response>`;
}

export function twilioAuthorized(input: {
  url: string;
  params: Record<string, string>;
  signature: string | null;
  authToken?: string;
}): boolean {
  if (!input.authToken) return true;
  if (!input.signature) return false;
  return validateTwilioSignature({ url: input.url, params: input.params, signature: input.signature, authToken: input.authToken });
}
