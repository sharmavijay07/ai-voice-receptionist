import { generateKeyPairSync } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildVapiAssistant, syncVapiAssistant } from "@/server/assistants";
import { loadBusiness } from "@/server/config";
import type { QueryFn } from "@/server/db";
import { FrontDesk } from "@/server/desk";
import { GoogleAccess, GoogleCalendar, GoogleSheets, gmailSmtpOptions, googleCreds, type Mailer } from "@/server/providers";
import { handleVapi } from "@/server/webhooks";

const NOW = new Date("2026-11-13T21:00:00.000Z");
const dirs: string[] = [];
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const serviceAccount = JSON.stringify({
  client_email: "desk@project.iam.gserviceaccount.com",
  private_key: pem,
});

async function makeDesk(
  env: Record<string, string> = {},
  fetchImpl?: typeof fetch,
  extra: { mailer?: Mailer; query?: QueryFn } = {},
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "desk-"));
  dirs.push(dir);
  return FrontDesk.create({
    env: {
      BUSINESS_CONFIG: "business/northline.yaml",
      LLM_PROVIDER: "none",
      CALENDAR_PROVIDER: "mock",
      CRM_PROVIDER: "local",
      SMS_PROVIDER: "mock",
      EMAIL_PROVIDER: "mock",
      ...env,
    },
    storePath: path.join(dir, "store.json"),
    now: () => NOW,
    seed: false,
    fetchImpl,
    ...extra,
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("gmail", () => {
  it("uses smtp.gmail.com port 465 and prefers Gmail over Resend", async () => {
    expect(gmailSmtpOptions("owner@gmail.com", "abcd efgh ijkl mnop")).toEqual({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: "owner@gmail.com", pass: "abcdefghijklmnop" },
    });
    const sent: Array<{ from: string; to: string; subject?: string; text: string }> = [];
    const mailer: Mailer = { send: async (input) => void sent.push(input) };
    const fetchImpl = (async (url: RequestInfo | URL) => {
      if (String(url).includes("resend")) throw new Error("Resend should not be called when Gmail is set");
      return new Response("unused", { status: 500 });
    }) as typeof fetch;
    const desk = await makeDesk(
      {
        GMAIL_USER: "owner@gmail.com",
        GMAIL_APP_PASSWORD: "abcd efgh ijkl mnop",
        SHOP_OWNER_EMAIL: "don@example.com",
        EMAIL_PROVIDER: "resend",
        RESEND_API_KEY: "re_test",
        NOTIFY_FROM_EMAIL: "maya@northline.example",
      },
      fetchImpl,
      { mailer },
    );
    expect(desk.providerStatus().email.mode).toBe("gmail");
    const call = await desk.startCall({ channel: "simulator" });
    const booked = await desk.handleText(
      call.id,
      "Book an express wash next Monday at 9 AM for Sam Lee, 512-555-0100, sam@example.com.",
    );
    expect(booked.action).toBe("booked");
    const emails = sent.filter((message) => message.from === "owner@gmail.com");
    expect(emails.map((message) => message.to).sort()).toEqual(["don@example.com", "sam@example.com"]);
    expect(emails.some((message) => message.subject?.includes("Booked"))).toBe(true);
    expect(emails.some((message) => message.to === "don@example.com" && message.subject?.includes("New booking"))).toBe(true);
    const stored = desk.store.read().messages.filter((message) => message.channel === "email");
    expect(stored.every((message) => message.provider === "gmail" && message.status === "sent")).toBe(true);
  });
});

describe("google", () => {
  it("reads a service account JSON, including base64", () => {
    const creds = googleCreds({ GOOGLE_SERVICE_ACCOUNT_JSON: serviceAccount, GOOGLE_CALENDAR_ID: "cal-1", GOOGLE_SHEETS_ID: "sheet-1" });
    expect(creds?.clientEmail).toBe("desk@project.iam.gserviceaccount.com");
    expect(creds?.privateKey).toContain("BEGIN PRIVATE KEY");
    expect(creds?.calendarId).toBe("cal-1");
    const encoded = Buffer.from(serviceAccount).toString("base64");
    expect(googleCreds({ GOOGLE_SERVICE_ACCOUNT_JSON: encoded })?.clientEmail).toBe("desk@project.iam.gserviceaccount.com");
    expect(googleCreds({ GOOGLE_SERVICE_ACCOUNT_JSON: "not-json" })).toBeNull();
  });

  it("retries calendar auth once on a 401", async () => {
    let oauth = 0;
    let busy = 0;
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const href = String(url);
      if (href.includes("oauth2.googleapis.com")) {
        oauth += 1;
        return json({ access_token: `tok-${oauth}`, expires_in: 3600 });
      }
      if (href.includes("freeBusy")) {
        busy += 1;
        if (busy === 1) return new Response("unauthorized", { status: 401 });
        return json({ calendars: { "cal-1": { busy: [{ start: "2026-11-17T14:00:00.000Z", end: "2026-11-17T17:00:00.000Z" }] } } });
      }
      return new Response("no", { status: 500 });
    }) as typeof fetch;
    const creds = googleCreds({ GOOGLE_SERVICE_ACCOUNT_JSON: serviceAccount, GOOGLE_CALENDAR_ID: "cal-1" })!;
    const calendar = new GoogleCalendar(creds, new GoogleAccess(creds, fetchImpl), fetchImpl);
    const slots = await calendar.listBusy("2026-11-13T00:00:00.000Z", "2026-11-20T00:00:00.000Z");
    expect(oauth).toBe(2);
    expect(slots).toHaveLength(1);
  });

  it("books on Google Calendar and creates the Calls tab when it is missing", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${href}`);
      if (href.includes("oauth2.googleapis.com")) return json({ access_token: "ya29.test", expires_in: 3600 });
      if (href.includes("freeBusy")) return json({ calendars: { "cal-1": { busy: [] } } });
      if (href.includes("/events") && method === "POST") return json({ id: "gcal-evt-1" });
      if (href.includes(":append")) return json({ updates: { updatedRows: 1 } });
      return new Response("no", { status: 500 });
    }) as typeof fetch;
    const desk = await makeDesk(
      {
        GOOGLE_SERVICE_ACCOUNT_JSON: serviceAccount,
        GOOGLE_CALENDAR_ID: "cal-1",
        GOOGLE_SHEETS_ID: "sheet-1",
      },
      fetchImpl,
    );
    expect(desk.calendar.mode).toBe("google");
    expect(desk.crm.mode).toBe("google");
    const call = await desk.startCall({ channel: "simulator" });
    const booked = await desk.handleText(call.id, "Book an express wash next Monday at 9 AM for Sam Lee, 512-555-0100.");
    expect(booked.action).toBe("booked");
    expect(booked.booking?.eventId).toBe("gcal-evt-1");
    expect(booked.booking?.calendarProvider).toBe("google");
    expect(calls.some((entry) => entry.includes(":append"))).toBe(true);

    const sheetCalls: string[] = [];
    const sheetFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url);
      const method = init?.method ?? "GET";
      sheetCalls.push(`${method} ${href}`);
      if (href.includes("oauth2.googleapis.com")) return json({ access_token: "ya29.test", expires_in: 3600 });
      if (href.includes(":append")) {
        if (!sheetCalls.some((entry) => entry.includes(":batchUpdate"))) return new Response("Unable to parse range: Calls!A:J", { status: 400 });
        return json({ updates: { updatedRows: 1 } });
      }
      if (href.includes("fields=sheets")) return json({ sheets: [{ properties: { title: "Sheet1" } }] });
      if (href.includes(":batchUpdate")) return json({ replies: [{}] });
      if (href.includes("/values/") && method === "PUT") return json({ updatedCells: 10 });
      return new Response("no", { status: 500 });
    }) as typeof fetch;
    const creds = googleCreds({ GOOGLE_SERVICE_ACCOUNT_JSON: serviceAccount, GOOGLE_SHEETS_ID: "sheet-1" })!;
    const sheets = new GoogleSheets("sheet-1", new GoogleAccess(creds, sheetFetch), sheetFetch);
    const recorded = await sheets.record(["now", "call", "from", "Sam", "512", "Express Wash", "booked", "Monday", "booked", "simulator"]);
    expect(recorded.ok).toBe(true);
    expect(sheetCalls.some((entry) => entry.includes(":batchUpdate"))).toBe(true);
    expect(sheetCalls.some((entry) => entry.startsWith("PUT") && entry.includes("Calls"))).toBe(true);
  });
});

describe("postgres call log", () => {
  it("reloads the book from a DATABASE_URL store after a new process", async () => {
    let saved: string | null = null;
    const query: QueryFn = async (sql, params) => {
      if (sql.includes("CREATE TABLE")) return { rows: [] };
      if (sql.startsWith("SELECT")) return { rows: saved ? [{ data: JSON.parse(saved) }] : [] };
      if (sql.startsWith("INSERT")) {
        saved = String(params?.[1]);
        return { rows: [] };
      }
      throw new Error(sql);
    };
    const first = await makeDesk({ DATABASE_URL: "postgres://user:pass@example/desk" }, undefined, { query });
    expect(first.store.persistent).toBe(true);
    const call = await first.startCall({ channel: "simulator" });
    const booked = await first.handleText(call.id, "Book an express wash next Monday at 9 AM for Sam Lee, 512-555-0100.");
    expect(booked.action).toBe("booked");
    const second = await makeDesk({ DATABASE_URL: "postgres://user:pass@example/desk" }, undefined, { query });
    expect(second.store.read().bookings.some((booking) => booking.id === booked.booking?.id)).toBe(true);
    expect(second.providerStatus().log.mode).toBe("postgres");
  });

  it("keeps the file log when Postgres cannot be reached", async () => {
    const query: QueryFn = async () => {
      throw new Error("connection refused");
    };
    const desk = await makeDesk({ DATABASE_URL: "postgres://user:pass@example/desk" }, undefined, { query });
    expect(desk.store.persistent).toBe(false);
    expect(desk.store.remoteError).toMatch(/connection refused/);
    expect(desk.providerStatus().log.mode).toBe("file");
    const call = await desk.startCall({ channel: "simulator" });
    const booked = await desk.handleText(call.id, "Book an express wash next Monday at 9 AM for Sam Lee, 512-555-0100.");
    expect(booked.action).toBe("booked");
  });
});

describe("vapi and retell assistants", () => {
  it("builds tools that point at the server and a transferCall destination", async () => {
    const desk = await makeDesk({
      PUBLIC_BASE_URL: "https://ai-voice-receptionist-mczp.onrender.com",
      TRANSFER_NUMBER: "+15125550199",
    });
    const assistant = desk.vapiAssistant();
    expect(assistant.model.provider).toBe("vapi");
    expect(assistant.model.version).toBe("latest");
    expect(assistant.serverUrl).toBe("https://ai-voice-receptionist-mczp.onrender.com/api/webhooks/vapi");
    const names = assistant.model.tools.map((tool) => tool.function?.name);
    expect(names).toEqual(expect.arrayContaining(["check_availability", "book_appointment", "get_shop_info", "transfer_call", "end_call"]));
    for (const tool of assistant.model.tools) {
      expect(tool.server?.url).toBe(assistant.serverUrl);
    }
    const transfer = assistant.model.tools.find((tool) => tool.type === "transferCall");
    expect(transfer?.destinations[0]).toMatchObject({ type: "number", number: "+15125550199", transferPlan: { mode: "blind-transfer" } });
    const moved = await desk.handleText((await desk.startCall({ channel: "simulator" })).id, "Can I talk to the owner?");
    expect(moved.call.transfer?.number).toBe("+15125550199");

    const groq = buildVapiAssistant(loadBusiness("business/northline.yaml"), { VAPI_MODEL_PROVIDER: "groq", PUBLIC_BASE_URL: "https://example.com" });
    expect(groq.model).toMatchObject({ provider: "groq", model: "openai/gpt-oss-120b" });
    const named = buildVapiAssistant(loadBusiness("business/northline.yaml"), {
      VAPI_MODEL_PROVIDER: "groq",
      VAPI_MODEL: "llama-3.3-70b-versatile",
      PUBLIC_BASE_URL: "https://example.com",
    });
    expect(named.model.model).toBe("llama-3.3-70b-versatile");

    const retell = desk.retellAssistant();
    const retellTransfer = retell.general_tools.find((tool) => tool.name === "transfer_call");
    expect(retellTransfer).toMatchObject({
      type: "transfer_call",
      transfer_destination: { type: "predefined", number: "+15125550199" },
      transfer_option: { type: "cold_transfer" },
    });
    const check = retell.general_tools.find((tool) => tool.name === "check_availability");
    expect(check && "url" in check ? check.url : undefined).toBe("https://ai-voice-receptionist-mczp.onrender.com/api/webhooks/retell");
  });

  it("forwards from a transfer-destination request and from a transfer tool call", async () => {
    const desk = await makeDesk({ PUBLIC_BASE_URL: "https://ai-voice-receptionist-mczp.onrender.com" });
    const asked = (await handleVapi(desk, {
      message: { type: "transfer-destination-request", call: { id: "vapi_x", customer: { number: "+15125550100" } } },
    })) as { destination: { type: string; number: string } };
    expect(asked.destination).toMatchObject({ type: "number", number: "+15125550190" });
    expect(desk.store.read().calls.find((call) => call.externalId === "vapi_x")?.status).toBe("transferred");

    const called = (await handleVapi(desk, {
      message: {
        type: "tool-calls",
        call: { id: "vapi_t" },
        toolCallList: [{ id: "t1", function: { name: "transfer_call", arguments: { reason: "owner" } } }],
      },
    })) as { results: Array<{ destination: { number: string }; result: { ok: boolean } }> };
    expect(called.results[0].result.ok).toBe(true);
    expect(called.results[0].destination.number).toBe("+15125550190");

    const info = (await handleVapi(desk, {
      message: {
        type: "tool-calls",
        call: { id: "vapi_q" },
        toolCallList: [
          {
            id: "t2",
            function: {
              name: "get_shop_info",
              arguments: { topic: "hours", question: "How much is a full detail and are you open Saturday?" },
            },
          },
        ],
      },
    })) as { results: Array<{ result: { speech: string } }> };
    expect(info.results[0].result.speech).toContain("$249 to $399");
    expect(info.results[0].result.speech.toLowerCase()).toContain("saturday");
  });

  it("creates or updates the assistant through the Vapi API", async () => {
    const business = loadBusiness("business/northline.yaml");
    const payload = buildVapiAssistant(business, {
      PUBLIC_BASE_URL: "https://ai-voice-receptionist-mczp.onrender.com",
      TRANSFER_NUMBER: "+15125550190",
    });
    const seen: Array<{ url: string; method: string; auth: string; body: typeof payload }> = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(url),
        method: init?.method ?? "GET",
        auth: String((init?.headers as Record<string, string>).Authorization),
        body: JSON.parse(String(init?.body)),
      });
      if (seen.length === 1) return new Response(JSON.stringify({ message: ["property server should not exist"] }), { status: 400 });
      return json({ id: "asst_123" });
    }) as typeof fetch;
    const updated = await syncVapiAssistant({ apiKey: "vapi_test_key", assistantId: "asst_123", payload, fetchImpl });
    expect(updated).toEqual({ id: "asst_123", created: false });
    expect(seen[0].method).toBe("PATCH");
    expect(seen[0].url).toBe("https://api.vapi.ai/assistant/asst_123");
    expect(seen[0].auth).toBe("Bearer vapi_test_key");
    expect(seen[0].body.model.tools.find((tool) => tool.type === "endCall")?.server?.url).toContain("/api/webhooks/vapi");
    expect(seen[1].body.model.tools.find((tool) => tool.type === "endCall")?.server).toBeUndefined();
    expect(seen[1].body.model.tools.find((tool) => tool.function?.name === "check_availability")?.server?.url).toContain("/api/webhooks/vapi");
    expect(JSON.stringify(seen[0].body)).not.toContain("vapi_test_key");

    seen.length = 0;
    const createdFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(url),
        method: init?.method ?? "GET",
        auth: "",
        body: JSON.parse(String(init?.body)),
      });
      return json({ id: "asst_new" });
    }) as typeof fetch;
    const created = await syncVapiAssistant({ apiKey: "vapi_test_key", payload, fetchImpl: createdFetch });
    expect(created).toEqual({ id: "asst_new", created: true });
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url).toBe("https://api.vapi.ai/assistant");
  });
});
