import { createHmac } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadBusiness } from "@/server/config";
import { FrontDesk } from "@/server/desk";
import { keepsFacts, resolveLlm } from "@/server/llm";
import { validateTwilioSignature } from "@/server/providers";
import { findSlots } from "@/server/slots";
import { zonedParts } from "@/server/time";
import { handleRetell, handleTwilio, handleVapi } from "@/server/webhooks";

const NOW = new Date("2026-11-13T21:00:00.000Z");
const dirs: string[] = [];

async function makeDesk(env: Record<string, string> = {}, fetchImpl?: typeof fetch) {
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
  });
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("shop config", () => {
  it("loads the sample detailing shop and a second tint shop", () => {
    const northline = loadBusiness("business/northline.yaml");
    const bay = loadBusiness("business/bay-tint.yaml");
    expect(northline.assistant_name).toBe("Maya");
    expect(northline.services.length).toBeGreaterThan(4);
    expect(northline.hours.sun).toBeNull();
    expect(bay.name).toBe("Bay Window Tint");
    expect(bay.hours.mon).toBeNull();
  });

  it("rejects a config that is missing the menu", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cfg-"));
    dirs.push(dir);
    const file = path.join(dir, "bad.yaml");
    await writeFile(file, "name: Only a name\n");
    expect(() => loadBusiness(file)).toThrow(/invalid/i);
  });
});

describe("calendar", () => {
  it("keeps Saturday inside shop hours and Sunday closed", () => {
    const business = loadBusiness("business/northline.yaml");
    const friday = zonedParts(NOW, business.timezone);
    expect(friday.weekday).toBe("fri");
    expect(friday.hour).toBe(15);
    const express = business.services.find((service) => service.id === "express-wash")!;
    const saturday = findSlots(business, { now: NOW, durationMin: express.duration_minutes, day: "2026-11-14", limit: 20 });
    expect(saturday.length).toBeGreaterThan(0);
    expect(saturday.every((slot) => zonedParts(new Date(slot.start), business.timezone).hour < 14)).toBe(true);
    expect(findSlots(business, { now: NOW, durationMin: 30, day: "2026-11-15", limit: 5 })).toHaveLength(0);
  });

  it("blocks a slot that is already booked", () => {
    const business = loadBusiness("business/northline.yaml");
    const open = findSlots(business, { now: NOW, durationMin: 180, day: "2026-11-17", exactTime: "08:00", limit: 1 });
    expect(open).toHaveLength(1);
    const blocked = findSlots(business, {
      now: NOW,
      durationMin: 180,
      day: "2026-11-17",
      exactTime: "08:00",
      busy: [{ start: open[0].start, end: open[0].end }],
      limit: 1,
    });
    expect(blocked).toHaveLength(0);
  });
});

describe("receptionist", () => {
  it("quotes a price from the config and knows the hours", async () => {
    const desk = await makeDesk();
    const call = await desk.startCall({ channel: "simulator" });
    const price = await desk.handleText(call.id, "How much is a full detail?");
    expect(price.say).toContain("$249 to $399");
    expect(price.say.toLowerCase()).not.toContain("lorem");
    const hours = await desk.handleText(call.id, "Are you open Sunday?");
    expect(hours.say.toLowerCase()).toContain("closed");
    const open = await desk.handleText(call.id, "Are you open right now?");
    expect(open.say.toLowerCase()).toContain("open right now");
  });

  it("answers the price and Saturday hours in the same question", async () => {
    const desk = await makeDesk();
    const call = await desk.startCall({ channel: "simulator" });
    const turn = await desk.handleText(call.id, "How much is a full detail and are you open Saturday?");
    expect(turn.say).toContain("$249 to $399");
    expect(turn.say.toLowerCase()).toContain("saturday");
    expect(turn.say).toMatch(/8:00 AM/);
  });

  it("books from one sentence and refuses a second booking on the same slot", async () => {
    const desk = await makeDesk();
    const first = await desk.startCall({ channel: "simulator", from: "+15125550148" });
    const booked = await desk.handleText(first.id, "Book a full detail next Tuesday at 10 AM for Alex Rivera, 512-555-0148.");
    expect(booked.action).toBe("booked");
    expect(booked.booking?.customerName).toBe("Alex Rivera");
    expect(booked.booking?.phone).toBe("(512) 555-0148");
    expect(booked.say).toContain("10:00 AM");
    const second = await desk.startCall({ channel: "simulator" });
    const again = await desk.handleText(second.id, "Book a full detail next Tuesday at 10 AM for Blair Quinn, 512-555-0166.");
    expect(again.action).not.toBe("booked");
    const snapshot = desk.store.read();
    const atTen = snapshot.bookings.filter((booking) => booking.start === booked.booking?.start && booking.status === "confirmed");
    expect(atTen).toHaveLength(1);
    expect(snapshot.messages.some((message) => message.channel === "sms" && message.bookingId === booked.booking?.id)).toBe(true);
    expect(snapshot.calls.find((call) => call.id === first.id)?.transcript.length).toBeGreaterThan(2);
  });

  it("offers morning slots and books the one the caller picks", async () => {
    const desk = await makeDesk();
    const call = await desk.startCall({ channel: "simulator" });
    await desk.handleText(call.id, "How much is a full detail?");
    const offer = await desk.handleText(call.id, "Book me next Tuesday morning. I'm Alex Rivera, 512-555-0148.");
    expect(offer.slots.length).toBeGreaterThan(0);
    const picked = await desk.handleText(call.id, "I'll take the first one.");
    expect(picked.action).toBe("booked");
    expect(picked.booking?.start).toBe(offer.slots[0].start);
  });

  it("will not book Sunday or a same-day time inside the lead window", async () => {
    const desk = await makeDesk();
    const sunday = await desk.startCall({ channel: "simulator" });
    const closed = await desk.handleText(sunday.id, "Book an express wash Sunday at 10 for Sam Lee, 512-555-0100.");
    expect(closed.action).not.toBe("booked");
    expect(closed.say.toLowerCase()).toContain("closed");
    const soon = await desk.startCall({ channel: "simulator" });
    const tooSoon = await desk.handleText(soon.id, "Book an express wash today at 3 for Sam Lee, 512-555-0100.");
    expect(tooSoon.action).not.toBe("booked");
    expect(tooSoon.say.toLowerCase()).toMatch(/notice|too soon/);
    const later = await desk.handleText(soon.id, "Today at 5 works.");
    expect(later.action).toBe("booked");
    expect(later.booking?.serviceId).toBe("express-wash");
  });

  it("keeps calendar, sheet, text, and email in mock mode when those keys are missing", async () => {
    const desk = await makeDesk({
      CALENDAR_PROVIDER: "google",
      CRM_PROVIDER: "google",
      SMS_PROVIDER: "twilio",
      EMAIL_PROVIDER: "resend",
    });
    const status = desk.providerStatus();
    expect(status.calendar.mode).toBe("mock");
    expect(status.crm.mode).toBe("local");
    expect(status.sms.mode).toBe("mock");
    expect(status.email.mode).toBe("mock");
    const call = await desk.startCall({ channel: "simulator" });
    const booked = await desk.handleText(call.id, "Book an express wash next Monday at 9 AM for Sam Lee, 512-555-0100.");
    expect(booked.action).toBe("booked");
    expect(desk.store.read().messages.some((message) => message.channel === "sms" && message.provider === "mock")).toBe(true);
  });

  it("transfers to the shop number and can cancel a booking", async () => {
    const desk = await makeDesk();
    const call = await desk.startCall({ channel: "simulator" });
    const booked = await desk.handleText(call.id, "Book an express wash next Monday at 9 AM for Jordan Hale, 512-555-0177.");
    expect(booked.action).toBe("booked");
    const cancelled = await desk.handleText(call.id, "Please cancel my appointment.");
    expect(cancelled.say.toLowerCase()).toContain("cancelled");
    expect(desk.store.read().bookings.find((booking) => booking.id === booked.booking?.id)?.status).toBe("cancelled");
    const transfer = await desk.handleText(call.id, "Can I talk to a manager?");
    expect(transfer.action).toBe("transfer");
    expect(transfer.call.transfer?.number).toBe("+15125550190");
    expect(transfer.call.status).toBe("transferred");
  });
});

describe("Groq", () => {
  it("defaults to openai/gpt-oss-120b on the Groq OpenAI-compatible API", () => {
    const settings = resolveLlm({});
    expect(settings.provider).toBe("groq");
    expect(settings.model).toBe("openai/gpt-oss-120b");
    expect(settings.baseUrl).toBe("https://api.groq.com/openai/v1");
    expect(settings.ready).toBe(false);
    expect(settings.reasoningEffort).toBe("low");
    const gemini = resolveLlm({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: "gem" });
    expect(gemini.provider).toBe("gemini");
    expect(gemini.ready).toBe(true);
    expect(resolveLlm({ LLM_PROVIDER: "none" }).provider).toBe("none");
  });

  it("calls Groq with the configured model and books from tool calls", async () => {
    const seen: Array<{ url: string; auth: string; body: Record<string, unknown> }> = [];
    const responses = [
      {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_check",
                  type: "function",
                  function: { name: "check_availability", arguments: JSON.stringify({ service: "full detail", when: "next Tuesday at 8 AM" }) },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_book",
                  type: "function",
                  function: {
                    name: "book_appointment",
                    arguments: JSON.stringify({
                      service: "full detail",
                      name: "Alex Rivera",
                      phone: "512-555-0148",
                      start: "2026-11-17T14:00:00.000Z",
                    }),
                  },
                },
              ],
            },
          },
        ],
      },
    ];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(url),
        auth: String((init?.headers as Record<string, string>).Authorization),
        body: JSON.parse(String(init?.body)),
      });
      const next = responses.shift();
      return new Response(JSON.stringify(next), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const desk = await makeDesk({ LLM_PROVIDER: "groq", GROQ_API_KEY: "gsk_test_key" }, fetchImpl);
    const call = await desk.startCall({ channel: "simulator" });
    const turn = await desk.handleText(call.id, "Book a full detail next Tuesday at 8 AM for Alex Rivera, 512-555-0148.");
    expect(seen[0].url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(seen[0].auth).toBe("Bearer gsk_test_key");
    expect(seen[0].body.model).toBe("openai/gpt-oss-120b");
    expect(seen[0].body.reasoning_effort).toBe("low");
    expect(JSON.stringify(seen[0].body)).not.toContain("gsk_test_key");
    expect(turn.action).toBe("booked");
    expect(turn.call.llm?.fallback).toBe(false);
    expect(turn.booking?.start).toBe("2026-11-17T14:00:00.000Z");
  });

  it("falls back to the built-in receptionist when Groq errors", async () => {
    const fetchImpl = (async () => new Response("rate limit", { status: 429 })) as typeof fetch;
    const desk = await makeDesk({ LLM_PROVIDER: "groq", GROQ_API_KEY: "gsk_test_key" }, fetchImpl);
    const call = await desk.startCall({ channel: "simulator" });
    const turn = await desk.handleText(call.id, "Book a full detail next Tuesday at 8 AM for Alex Rivera, 512-555-0148.");
    expect(turn.action).toBe("booked");
    expect(turn.call.llm?.fallback).toBe(true);
    expect(turn.call.llm?.note).toMatch(/429/);
  });

  it("fills in a price the model skipped on a two-part question", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "Yes, we're open Saturday from 8 to 2.", tool_calls: [] } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    const desk = await makeDesk({ LLM_PROVIDER: "groq", GROQ_API_KEY: "gsk_test_key" }, fetchImpl);
    const call = await desk.startCall({ channel: "simulator" });
    const turn = await desk.handleText(call.id, "How much is a full detail and are you open Saturday?");
    expect(turn.call.llm?.fallback).toBe(false);
    expect(turn.say).toContain("$249 to $399");
    expect(turn.say.toLowerCase()).toContain("saturday");
  });

  it("keeps a complete model answer from repeating the price", async () => {
    const line = "A full detail is $249 to $399. Saturday we're open 8:00 AM to 2:00 PM.";
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: line } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    const desk = await makeDesk({ LLM_PROVIDER: "groq", GROQ_API_KEY: "gsk_test_key" }, fetchImpl);
    const call = await desk.startCall({ channel: "simulator" });
    const turn = await desk.handleText(call.id, "How much is a full detail and are you open Saturday?");
    expect(turn.say.match(/\$249 to \$399/g)).toHaveLength(1);
    expect(turn.say.toLowerCase()).toContain("saturday");
  });

  it("still answers both parts when Groq fails", async () => {
    const fetchImpl = (async () => new Response("rate limit", { status: 429 })) as typeof fetch;
    const desk = await makeDesk({ LLM_PROVIDER: "groq", GROQ_API_KEY: "gsk_test_key" }, fetchImpl);
    const call = await desk.startCall({ channel: "simulator" });
    const turn = await desk.handleText(call.id, "How much is a full detail and are you open Saturday?");
    expect(turn.call.llm?.fallback).toBe(true);
    expect(turn.say).toContain("$249 to $399");
    expect(turn.say.toLowerCase()).toContain("saturday");
  });

  it("does not let a rephrase drop a price", () => {
    expect(keepsFacts("Full detail is $249 to $399 at 10:00 AM.", "Full detail is $249 to $399 at 10:00 AM, and we can take the truck.")).toBe(true);
    expect(keepsFacts("Full detail is $249 to $399.", "Full detail is affordable.")).toBe(false);
  });
});

describe("voice webhooks", () => {
  it("books through a Vapi tool call and logs the end of the call", async () => {
    const desk = await makeDesk();
    const checked = await handleVapi(desk, {
      message: {
        type: "tool-calls",
        call: { id: "vapi_1", customer: { number: "+15125550148" } },
        toolCallList: [
          { id: "t1", function: { name: "book_appointment", arguments: { service: "express wash", name: "Alex Rivera", phone: "512-555-0148", start: "2026-11-17T14:00:00.000Z" } } },
        ],
      },
    });
    const results = (checked as { results: Array<{ result: { ok: boolean } }> }).results;
    expect(results[0].result.ok).toBe(true);
    await handleVapi(desk, { message: { type: "end-of-call-report", call: { id: "vapi_1" }, summary: "Booked an express wash." } });
    const call = desk.store.read().calls.find((item) => item.externalId === "vapi_1");
    expect(call?.phase).toBe("ended");
    expect(call?.summary).toContain("express");
  });

  it("answers Retell with speech that includes the open time", async () => {
    const desk = await makeDesk();
    const result = (await handleRetell(desk, {
      name: "check_availability",
      args: { service: "express wash", when: "next Tuesday morning" },
      call: { call_id: "retell_1", from_number: "+15125550111" },
    })) as { result: string };
    expect(result.result).toMatch(/Tuesday/);
    expect(result.result).toContain("|");
  });

  it("speaks and transfers on Twilio", async () => {
    const desk = await makeDesk();
    const greet = await handleTwilio(desk, { CallSid: "CA1", From: "+15125550100" }, "https://desk.example", "Polly.Joanna-Neural");
    expect(greet).toContain("<Gather");
    expect(greet).toContain("Maya");
    const transfer = await handleTwilio(
      desk,
      { CallSid: "CA1", From: "+15125550100", SpeechResult: "Can I talk to a manager?" },
      "https://desk.example",
      "Polly.Joanna-Neural",
    );
    expect(transfer).toContain("<Dial>+15125550190</Dial>");
  });

  it("checks a Twilio signature", () => {
    const params = { CallSid: "CA1", From: "+15125550100" };
    const url = "https://desk.example/api/webhooks/twilio";
    const signed = url + Object.keys(params).sort().map((key) => key + params[key as keyof typeof params]).join("");
    const signature = createHmac("sha1", "token").update(signed).digest("base64");
    expect(validateTwilioSignature({ url, params, signature, authToken: "token" })).toBe(true);
    expect(validateTwilioSignature({ url, params, signature: "nope", authToken: "token" })).toBe(false);
  });
});
