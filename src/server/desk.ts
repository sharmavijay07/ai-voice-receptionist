import { loadBusiness, serviceById } from "./config";
import { nextTurn, summarize, type BookRequest } from "./dialogue";
import { emailBody, offerSlots, priceSpeech, shopAlert, smsBody } from "./copy";
import { chatComplete, rephraseLine, resolveLlm, systemPrompt, TOOLS, type LlmSettings, type ToolCall } from "./llm";
import { interpret, matchService, normalizePhone, parseWhen } from "./nlu";
import {
  GoogleAccess,
  GoogleCalendar,
  GoogleSheets,
  LocalCrm,
  MockCalendar,
  MockMessages,
  ResendEmail,
  TwilioSms,
  googleCreds,
  type CalendarProvider,
  type CrmProvider,
  type MessageProvider,
} from "./providers";
import { findSlots, type SlotQuery } from "./slots";
import { Store } from "./store";
import { formatLong, zonedParts } from "./time";
import {
  DeskError,
  nid,
  type EnvMap,
  type Booking,
  type Business,
  type CallRecord,
  type Channel,
  type OutboundMessage,
  type Slot,
  type TurnAction,
  type TurnResponse,
} from "./types";

const BOOKED_CLAIM =
  /\b(you(?:'| a)?re booked|you are booked|i(?:'| ha)?ve booked|i booked|booked you|appointment is set|you're all set|you are all set)\b/i;

export type DeskOptions = {
  env?: EnvMap;
  storePath: string;
  now?: () => Date;
  seed?: boolean;
  fetchImpl?: typeof fetch;
};

type ProviderState = { name: string; mode: string; ready: boolean; detail: string };

export class FrontDesk {
  readonly store: Store;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly env: EnvMap;
  private readonly nowFn: () => Date;
  private readonly fetchImpl: typeof fetch;
  private readonly configPath: string;
  readonly calendar: CalendarProvider;
  readonly crm: CrmProvider;
  readonly sms: MessageProvider;
  readonly email: MessageProvider;
  readonly llm: LlmSettings;

  private constructor(options: DeskOptions, wired: {
    calendar: CalendarProvider;
    crm: CrmProvider;
    sms: MessageProvider;
    email: MessageProvider;
  }) {
    this.env = options.env ?? {};
    this.store = new Store(options.storePath);
    this.nowFn = options.now ?? (() => new Date());
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.configPath = this.env.BUSINESS_CONFIG || "business/northline.yaml";
    this.calendar = wired.calendar;
    this.crm = wired.crm;
    this.sms = wired.sms;
    this.email = wired.email;
    this.llm = resolveLlm(this.env);
  }

  static async create(options: DeskOptions): Promise<FrontDesk> {
    const env = options.env ?? {};
    const fetchImpl = options.fetchImpl ?? fetch;
    const creds = googleCreds(env);
    const wantGoogleCal = (env.CALENDAR_PROVIDER ?? "mock") === "google";
    const wantSheets = (env.CRM_PROVIDER ?? "local") === "google";
    const auth = creds ? new GoogleAccess(creds, fetchImpl) : null;
    const calendar = wantGoogleCal && creds && auth ? new GoogleCalendar(creds, auth, fetchImpl) : new MockCalendar();
    const crm = wantSheets && creds && auth ? new GoogleSheets(creds.spreadsheetId, auth, fetchImpl) : new LocalCrm();
    const sms = (env.SMS_PROVIDER ?? "mock") === "twilio" ? new TwilioSms(env, fetchImpl) : new MockMessages("mock");
    const email = (env.EMAIL_PROVIDER ?? "mock") === "resend" ? new ResendEmail(env, fetchImpl) : new MockMessages("mock");
    const desk = new FrontDesk(options, { calendar, crm, sms, email });
    const safe = calendar.mode === "mock" && sms.mode === "mock" && email.mode === "mock";
    if (options.seed && safe && desk.store.isEmpty()) await desk.seedDemo();
    return desk;
  }

  business(): Business {
    return loadBusiness(this.configPath);
  }

  now(): Date {
    return this.nowFn();
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  providerStatus(): Record<string, ProviderState> {
    const google = googleCreds(this.env);
    const calendarReady = this.calendar.mode === "mock" || Boolean(google && this.env.GOOGLE_CALENDAR_ID);
    return {
      voice: {
        name: "Voice",
        mode: "Browser",
        ready: true,
        detail: "The browser simulator is live. Vapi, Retell, and Twilio webhooks use the same desk when you add credentials.",
      },
      llm: {
        name: "Language",
        mode: this.llm.ready ? `${this.llm.provider} · ${this.llm.model}` : this.llm.provider,
        ready: this.llm.ready,
        detail: this.llm.detail,
      },
      calendar: {
        name: "Calendar",
        mode: this.calendar.mode,
        ready: calendarReady,
        detail:
          this.calendar.mode === "google"
            ? calendarReady
              ? "Google Calendar checks free/busy and writes the event."
              : "CALENDAR_PROVIDER=google needs a service account and GOOGLE_CALENDAR_ID."
            : "Mock calendar. Bookings stay in the local desk log.",
      },
      crm: {
        name: "CRM",
        mode: this.crm.mode,
        ready: this.crm.mode === "local" || Boolean(google?.spreadsheetId),
        detail:
          this.crm.mode === "google"
            ? "Each call and booking is appended to the Calls tab."
            : "The dashboard is the CRM. Set CRM_PROVIDER=google to copy rows into a Sheet.",
      },
      sms: {
        name: "SMS",
        mode: this.sms.mode,
        ready: true,
        detail: this.sms.mode === "twilio" ? "Twilio sends the confirmation text." : "Texts are logged on the desk, not sent.",
      },
      email: {
        name: "Email",
        mode: this.email.mode,
        ready: true,
        detail: this.email.mode === "resend" ? "Resend sends the confirmation." : "Emails are logged on the desk, not sent.",
      },
    };
  }

  async callDetail(id: string) {
    const data = this.store.read();
    const call = data.calls.find((item) => item.id === id);
    if (!call) return null;
    return {
      call,
      booking: data.bookings.find((item) => item.id === call.bookingId || item.callId === call.id) ?? null,
      business: this.business(),
    };
  }

  async overview() {
    const business = this.business();
    const data = this.store.read();
    const now = this.now();
    const today = zonedParts(now, business.timezone).ymd;
    const onDay = (iso: string) => zonedParts(new Date(iso), business.timezone).ymd === today;
    const calls = [...data.calls].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const bookings = data.bookings
      .filter((booking) => booking.status === "confirmed" && booking.end > now.toISOString())
      .sort((a, b) => a.start.localeCompare(b.start));
    return {
      business,
      configPath: this.configPath,
      providers: this.providerStatus(),
      calls,
      bookings,
      messages: [...data.messages].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 12),
      stats: {
        callsToday: data.calls.filter((call) => onDay(call.startedAt)).length,
        upcoming: bookings.length,
        transfersToday: data.calls.filter((call) => call.status === "transferred" && onDay(call.startedAt)).length,
        confirmations: data.messages.length,
      },
    };
  }

  async startCall(input: { channel: Channel; from?: string; externalId?: string }): Promise<CallRecord> {
    return this.enqueue(async () => {
      if (input.externalId) {
        const existing = this.store
          .read()
          .calls.find((call) => call.channel === input.channel && call.externalId === input.externalId && call.phase !== "ended");
        if (existing) return existing;
      }
      const business = this.business();
      const at = this.now().toISOString();
      const call: CallRecord = {
        id: nid("call"),
        channel: input.channel,
        from: input.from,
        externalId: input.externalId,
        startedAt: at,
        status: "in_progress",
        customer: {},
        offered: [],
        phase: "conversation",
        transcript: [{ role: "assistant", text: business.greeting, at }],
        summary: "Call just started.",
        llm: this.llmTrace(false),
      };
      await this.saveCall(call);
      return call;
    });
  }

  async handleText(callId: string, text: string): Promise<TurnResponse> {
    return this.enqueue(() => this.handleUnlocked(callId, text));
  }

  async endCall(callId: string): Promise<CallRecord> {
    return this.enqueue(async () => {
      const call = this.must(callId);
      if (!call.endedAt) call.endedAt = this.now().toISOString();
      if (call.status === "in_progress") call.status = "completed";
      if (call.phase !== "transferred") call.phase = "ended";
      call.summary = summarize(call);
      await this.saveCall(call);
      if (!call.bookingId) await this.writeCrm(call);
      return call;
    });
  }

  async reset(): Promise<void> {
    await this.enqueue(async () => {
      await this.store.update((data) => {
        data.calls = [];
        data.bookings = [];
        data.messages = [];
      });
      if (this.calendar.mode === "mock" && this.sms.mode === "mock" && this.email.mode === "mock") await this.seedDemo();
    });
  }

  async runExternalTool(input: { channel: Channel; externalId: string; from?: string; name: string; args: Record<string, unknown> }) {
    return this.enqueue(async () => {
      const call = await this.ensureExternal(input.channel, input.externalId, input.from);
      const result = await this.execTool(call, { id: nid("tool"), name: input.name, args: input.args }, []);
      call.llm = { provider: input.channel, fallback: false, note: "Tool call from the voice provider." };
      call.summary = summarize(call);
      await this.saveCall(call);
      return result.payload;
    });
  }

  async finishExternal(input: { channel: Channel; externalId: string; from?: string; transcript?: string; summary?: string }) {
    return this.enqueue(async () => {
      const call = await this.ensureExternal(input.channel, input.externalId, input.from);
      if (input.transcript) {
        call.transcript.push({ role: "assistant", text: input.transcript.slice(0, 4000), at: this.now().toISOString() });
      }
      if (input.summary) call.summary = input.summary;
      if (!call.endedAt) call.endedAt = this.now().toISOString();
      if (call.status === "in_progress") call.status = "completed";
      if (call.phase !== "transferred") call.phase = "ended";
      await this.saveCall(call);
      if (!call.bookingId) await this.writeCrm(call);
      return call;
    });
  }

  vapiAssistant() {
    const business = this.business();
    const base = (this.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
    return {
      name: `${business.name} ${business.assistant_name}`,
      firstMessage: business.greeting,
      serverUrl: base ? `${base}/api/webhooks/vapi` : undefined,
      model: {
        provider: "groq",
        model: this.llm.model || "openai/gpt-oss-120b",
        messages: [{ role: "system", content: systemPrompt(business) }],
        tools: TOOLS,
      },
      voice: { provider: this.env.VAPI_VOICE_PROVIDER || "vapi", voiceId: this.env.VAPI_VOICE_ID || "Elliot" },
      endCallFunctionEnabled: true,
    };
  }

  private async handleUnlocked(callId: string, text: string): Promise<TurnResponse> {
    const call = this.must(callId);
    if (call.phase === "ended") return { say: "This call has ended.", action: "end", call, slots: [] };
    if (this.llm.ready && this.llm.mode === "tools") {
      const llm = await this.tryLlm(call, text);
      if (typeof llm !== "string") {
        await this.saveCall(llm.call);
        if (llm.action === "end" && !llm.booking) await this.writeCrm(llm.call);
        return llm;
      }
      const outcome = await this.applyDialogue(structuredClone(call), text);
      outcome.call.llm = { provider: this.llm.provider, model: this.llm.model, fallback: true, note: llm };
      outcome.call.summary = summarize(outcome.call);
      await this.saveCall(outcome.call);
      if (outcome.action === "end" && !outcome.booking) await this.writeCrm(outcome.call);
      return outcome;
    }
    const outcome = await this.applyDialogue(structuredClone(call), text);
    await this.saveCall(outcome.call);
    if (outcome.action === "end" && !outcome.booking) await this.writeCrm(outcome.call);
    return outcome;
  }

  private async tryLlm(call: CallRecord, text: string): Promise<TurnResponse | string> {
    const created: { id: string; eventId?: string }[] = [];
    const working = structuredClone(call);
    const at = this.now().toISOString();
    working.transcript.push({ role: "user", text: text.trim(), at });
    const heard = interpret(text, this.business(), this.now(), working.pending);
    if (heard.name) working.customer.name = heard.name;
    if (heard.phone) working.customer.phone = heard.phone;
    if (heard.email) working.customer.email = heard.email;
    if (heard.vehicle) working.customer.vehicle = heard.vehicle;
    if (heard.serviceId) working.serviceId = heard.serviceId;

    try {
      const history: Record<string, unknown>[] = [
        { role: "system", content: systemPrompt(this.business()) },
        ...working.transcript.slice(-8).map((line) => ({ role: line.role === "assistant" ? "assistant" : "user", content: line.text })),
      ];
      let booking: Booking | undefined;
      let action: TurnAction = "continue";
      let lastSpeech = "";
      let say = "";
      for (let round = 0; round < 2; round += 1) {
        const result = await chatComplete(
          this.llm,
          { messages: history, tools: TOOLS, tool_choice: "auto", max_completion_tokens: 500 },
          this.fetchImpl,
        );
        if (!result.toolCalls.length) {
          say = result.content;
          break;
        }
        history.push({
          role: "assistant",
          content: result.content || "",
          tool_calls: result.toolCalls.map((tool) => ({
            id: tool.id,
            type: "function",
            function: { name: tool.name, arguments: JSON.stringify(tool.args) },
          })),
        });
        for (const tool of result.toolCalls) {
          const executed = await this.execTool(working, tool, created);
          if (executed.booking) booking = executed.booking;
          if (executed.speech) lastSpeech = executed.speech;
          if (executed.action) action = executed.action;
          history.push({ role: "tool", tool_call_id: tool.id, content: JSON.stringify(executed.payload) });
        }
        say = result.content || lastSpeech;
      }
      say = say || lastSpeech;
      if (!say) throw new Error("Groq returned an empty reply");
      if (BOOKED_CLAIM.test(say) && !booking && !working.bookingId) {
        throw new Error("Groq confirmed a booking that was not created");
      }
      if (booking) {
        action = "booked";
        working.bookingId = booking.id;
        working.status = "booked";
        working.phase = "after_book";
        working.pending = "else";
      }
      if (action === "end") {
        working.phase = "ended";
        working.endedAt = at;
        if (working.status === "in_progress") working.status = "completed";
      }
      working.transcript.push({ role: "assistant", text: say, at });
      working.summary = summarize(working);
      working.llm = { provider: this.llm.provider, model: this.llm.model, fallback: false };
      return { say, action, call: working, slots: working.offered, booking };
    } catch (error) {
      await this.rollback(created);
      working.llm = {
        provider: this.llm.provider,
        model: this.llm.model,
        fallback: true,
        note: error instanceof Error ? error.message : "Groq failed",
      };
      return error instanceof Error ? error.message : "Groq failed";
    }
  }

  private async applyDialogue(call: CallRecord, text: string): Promise<TurnResponse> {
    const business = this.business();
    const now = this.now();
    const busy = await this.busy();
    const outcome = nextTurn(call, text, {
      business,
      now,
      slots: (query) => findSlots(business, { ...query, busy, now }),
    });
    let booking: Booking | undefined;
    let action: TurnAction = outcome.action === "book" || outcome.action === "cancel" ? "continue" : outcome.action;
    if (outcome.action === "book" && outcome.book) {
      try {
        booking = await this.bookUnlocked({ ...outcome.book, callId: outcome.call.id, source: outcome.call.channel });
        outcome.call.bookingId = booking.id;
        outcome.call.status = "booked";
        outcome.call.phase = "after_book";
        outcome.call.pending = "else";
        action = "booked";
      } catch (error) {
        const say = await this.failureSay(outcome.call, outcome.book, error);
        outcome.say = say;
        replaceLast(outcome.call, say);
        outcome.call.status = call.status === "booked" ? "booked" : "in_progress";
        outcome.call.phase = "booking";
        outcome.call.bookingId = call.bookingId;
        action = "continue";
      }
    }
    if (outcome.action === "cancel") {
      const cancelled = await this.cancelUnlocked(outcome.call);
      outcome.say = cancelled;
      replaceLast(outcome.call, cancelled);
      action = "continue";
    }
    if (this.llm.ready && this.llm.mode === "rephrase") {
      try {
        const polished = await rephraseLine(this.llm, outcome.say, this.fetchImpl);
        outcome.say = polished;
        replaceLast(outcome.call, polished);
        outcome.call.llm = { provider: this.llm.provider, model: this.llm.model, fallback: polished === outcome.say ? false : false };
      } catch (error) {
        outcome.call.llm = {
          provider: this.llm.provider,
          model: this.llm.model,
          fallback: true,
          note: error instanceof Error ? error.message : "Rephrase failed",
        };
      }
    } else if (!outcome.call.llm?.fallback) {
      outcome.call.llm = this.llmTrace(true);
    } else {
      outcome.call.llm = { ...outcome.call.llm, fallback: true };
    }
    if (!this.llm.ready) outcome.call.llm = this.llmTrace(true);
    outcome.call.summary = summarize(outcome.call);
    return { say: outcome.say, action, call: outcome.call, slots: outcome.call.offered, booking };
  }

  private llmTrace(fallback: boolean): CallRecord["llm"] {
    if (this.llm.provider === "none") return { provider: "builtin", fallback: true, note: this.llm.detail };
    return { provider: this.llm.provider, model: this.llm.model, fallback, note: fallback ? this.llm.detail : undefined };
  }

  private async failureSay(call: CallRecord, request: BookRequest, error: unknown): Promise<string> {
    if (!(error instanceof DeskError) || error.code !== "conflict") {
      return "I couldn't reach the calendar. I saved your details and the shop will confirm.";
    }
    const business = this.business();
    const service = serviceById(business, request.serviceId);
    if (!service) return "That time just got taken. What other day works?";
    const slots = findSlots(business, { now: this.now(), durationMin: service.duration_minutes, busy: await this.busy(), limit: 3 });
    call.offered = slots;
    call.pending = slots.length ? "slot" : "when";
    call.selectedStart = undefined;
    return slots.length ? `That time just got taken. ${offerSlots(slots)}` : "That time just got taken, and I don't see another opening. I can transfer you.";
  }

  private async execTool(
    call: CallRecord,
    tool: ToolCall,
    created: { id: string; eventId?: string }[],
  ): Promise<{ payload: Record<string, unknown>; speech?: string; booking?: Booking; action?: TurnAction }> {
    const business = this.business();
    const args = tool.args;
    if (tool.name === "get_shop_info") {
      const topic = String(args.topic ?? "services");
      const service = matchService(String(args.service ?? ""), business);
      const found = service ? serviceById(business, service) : undefined;
      let speech = business.menu_speech;
      if (topic === "hours") speech = business.hours_speech;
      else if (topic === "address") speech = `We're at ${business.address}. ${business.policies.dropoff}`;
      else if (topic === "policies") speech = `${business.policies.cancellation} ${business.policies.payment}`;
      else if (topic === "pricing" && found) speech = priceSpeech(found);
      else if (topic === "pricing") speech = business.menu_speech;
      return { payload: { speech }, speech };
    }
    if (tool.name === "check_availability") {
      const serviceId = matchService(String(args.service ?? ""), business);
      const service = serviceId ? serviceById(business, serviceId) : undefined;
      if (!service) return { payload: { ok: false, speech: `I didn't catch the service. ${business.menu_speech}` }, speech: business.menu_speech };
      const when = parseWhen(String(args.when ?? ""), this.now(), business.timezone);
      let slots = findSlots(business, {
        now: this.now(),
        durationMin: service.duration_minutes,
        busy: await this.busy(),
        day: when.day,
        part: when.exactTime ? undefined : when.part,
        exactTime: when.exactTime,
        limit: when.exactTime ? 1 : 3,
      });
      if (!slots.length) {
        slots = findSlots(business, {
          now: this.now(),
          durationMin: service.duration_minutes,
          busy: await this.busy(),
          day: when.exactTime ? undefined : when.day,
          part: when.part,
          limit: 3,
        });
      }
      call.serviceId = service.id;
      call.offered = slots;
      call.phase = "booking";
      call.pending = slots.length ? "slot" : "when";
      const speech = slots.length ? offerSlots(slots) : `I don't have a ${service.name} opening in that window.`;
      return { payload: { ok: slots.length > 0, speech, slots }, speech };
    }
    if (tool.name === "book_appointment") {
      const serviceId = matchService(String(args.service ?? call.serviceId ?? ""), business);
      if (!serviceId) return { payload: { ok: false, speech: "Which service should I book?" }, speech: "Which service should I book?" };
      const name = String(args.name ?? call.customer.name ?? "");
      const phone = normalizePhone(String(args.phone ?? call.customer.phone ?? "")) ?? "";
      call.customer.name = name || call.customer.name;
      if (phone) call.customer.phone = phone;
      if (args.email) call.customer.email = String(args.email);
      if (args.vehicle) call.customer.vehicle = String(args.vehicle);
      call.serviceId = serviceId;
      try {
        const booking = await this.bookUnlocked({
          callId: call.id,
          serviceId,
          start: String(args.start ?? ""),
          name,
          phone,
          email: call.customer.email,
          vehicle: call.customer.vehicle,
          source: call.channel,
        });
        created.push({ id: booking.id, eventId: booking.eventId });
        const speech = `Booked ${booking.serviceName} for ${booking.customerName} on ${formatLong(new Date(booking.start), business.timezone)}.`;
        return { payload: { ok: true, speech, bookingId: booking.id, start: booking.start }, speech, booking, action: "booked" };
      } catch (error) {
        const speech = error instanceof Error ? error.message : "That time is not open.";
        return { payload: { ok: false, speech }, speech };
      }
    }
    if (tool.name === "transfer_call") {
      call.status = "transferred";
      call.phase = "transferred";
      call.transfer = { number: business.transfer_number, reason: String(args.reason ?? "Caller asked for a person").slice(0, 180) };
      const speech = "I'll connect you with the shop now.";
      return { payload: { ok: true, speech, number: business.transfer_number }, speech, action: "transfer" };
    }
    if (tool.name === "end_call") {
      const speech = `Thanks for calling ${business.name}.`;
      return { payload: { ok: true, speech }, speech, action: "end" };
    }
    return { payload: { ok: false, speech: "I can't do that from this phone." }, speech: "I can quote a service, book a visit, or transfer you." };
  }

  private async bookUnlocked(input: BookRequest & { callId?: string; source: string; seed?: boolean }): Promise<Booking> {
    const business = this.business();
    const service = serviceById(business, input.serviceId);
    if (!service) throw new DeskError("I don't have that service on the menu.", "config");
    const phone = normalizePhone(input.phone);
    if (!input.name.trim()) throw new DeskError("I need a name for the appointment.", "conflict");
    if (!phone) throw new DeskError("I need a 10-digit mobile number.", "conflict");
    const start = new Date(input.start);
    if (Number.isNaN(start.getTime())) throw new DeskError("That time isn't one I can book.", "conflict");
    const parts = zonedParts(start, business.timezone);
    const slots = findSlots(business, {
      now: this.now(),
      durationMin: service.duration_minutes,
      busy: await this.busy(),
      day: parts.ymd,
      exactTime: `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`,
      limit: 4,
    });
    const match = slots.find((slot) => Math.abs(new Date(slot.start).getTime() - start.getTime()) < 60_000);
    if (!match) throw new DeskError("That time is no longer open.", "conflict");
    const event = await this.calendar.createEvent({
      start: match.start,
      end: match.end,
      timeZone: business.timezone,
      summary: `${service.name} — ${input.name.trim()}`,
      description: [`Phone: ${phone}`, input.vehicle ? `Vehicle: ${input.vehicle}` : "", input.email ? `Email: ${input.email}` : "", business.address]
        .filter(Boolean)
        .join("\n"),
    });
    const booking: Booking = {
      id: nid("book"),
      callId: input.callId,
      createdAt: this.now().toISOString(),
      start: match.start,
      end: match.end,
      serviceId: service.id,
      serviceName: service.name,
      customerName: input.name.trim(),
      phone,
      email: input.email,
      vehicle: input.vehicle,
      status: "confirmed",
      eventId: event.eventId,
      calendarProvider: this.calendar.mode,
      source: input.source,
      seed: input.seed,
    };
    await this.store.update((data) => {
      data.bookings.push(booking);
    });
    await this.notify(booking, service.deposit);
    await this.writeCrm(undefined, booking);
    await this.pingN8n(booking);
    return booking;
  }

  private async cancelUnlocked(call: CallRecord): Promise<string> {
    const phone = call.customer.phone;
    const data = this.store.read();
    const booking = data.bookings
      .filter((item) => item.status === "confirmed" && (!phone || item.phone === phone))
      .sort((a, b) => a.start.localeCompare(b.start))[0];
    if (!booking) return phone ? `I don't see an upcoming appointment for ${phone}. I can transfer you to the shop.` : "I need the phone number on the appointment before I can cancel it.";
    booking.status = "cancelled";
    await this.store.update((store) => {
      const found = store.bookings.find((item) => item.id === booking.id);
      if (found) found.status = "cancelled";
    });
    if (booking.eventId) {
      try {
        await this.calendar.cancelEvent(booking.eventId);
      } catch {
        /* the local book is already cancelled */
      }
    }
    const when = formatLong(new Date(booking.start), this.business().timezone);
    return `I cancelled the ${booking.serviceName} on ${when}. Want a different time?`;
  }

  private async notify(booking: Booking, deposit: boolean) {
    const business = this.business();
    const when = formatLong(new Date(booking.start), business.timezone);
    const sms: Omit<OutboundMessage, "id" | "at" | "status" | "provider"> = {
      channel: "sms",
      audience: "customer",
      to: booking.phone,
      body: smsBody(business, booking.customerName, booking.serviceName, when),
      bookingId: booking.id,
      callId: booking.callId,
    };
    await this.deliver(sms, this.sms);
    if (booking.email) {
      await this.deliver(
        {
          channel: "email",
          audience: "customer",
          to: booking.email,
          subject: `Booked — ${booking.serviceName}`,
          body: emailBody(business, booking.customerName, serviceById(business, booking.serviceId)!, when) + (deposit ? "" : ""),
          bookingId: booking.id,
          callId: booking.callId,
        },
        this.email,
      );
    }
    await this.deliver(
      {
        channel: "email",
        audience: "shop",
        to: business.email,
        subject: `New booking — ${booking.serviceName}`,
        body: shopAlert(business, booking.customerName, booking.phone, booking.serviceName, when),
        bookingId: booking.id,
        callId: booking.callId,
      },
      this.email,
    );
  }

  private async deliver(
    draft: Omit<OutboundMessage, "id" | "at" | "status" | "provider">,
    provider: MessageProvider,
  ) {
    let status: OutboundMessage["status"] = "logged";
    let error: string | undefined;
    try {
      const result = await provider.send({ to: draft.to, body: draft.body, subject: draft.subject });
      status = result.status;
      error = result.error;
    } catch (caught) {
      status = "failed";
      error = caught instanceof Error ? caught.message : "Send failed";
    }
    const message: OutboundMessage = {
      ...draft,
      id: nid("msg"),
      at: this.now().toISOString(),
      status,
      provider: provider.mode,
      error,
    };
    await this.store.update((data) => {
      data.messages.push(message);
    });
  }

  private async writeCrm(call?: CallRecord, booking?: Booking) {
    const business = this.business();
    const when = booking ? formatLong(new Date(booking.start), business.timezone) : "";
    const row = booking
      ? [booking.createdAt, booking.callId ?? "", booking.source, booking.customerName, booking.phone, booking.serviceName, "booked", when, business.name, booking.id]
      : [call?.endedAt ?? call?.startedAt ?? "", call?.id ?? "", call?.from ?? "", call?.customer.name ?? "", call?.customer.phone ?? "", call?.serviceId ?? "", call?.status ?? "", "", call?.summary ?? "", call?.channel ?? ""];
    const result = await this.crm.record(row);
    if (!result.ok && call) call.summary = `${call.summary} (sheet: ${result.error})`;
  }

  private async pingN8n(booking: Booking) {
    const url = this.env.N8N_WEBHOOK_URL;
    if (!url) return;
    try {
      await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.env.N8N_WEBHOOK_SECRET ? { "x-webhook-secret": this.env.N8N_WEBHOOK_SECRET } : {}),
        },
        body: JSON.stringify({ event: "booking.created", business: this.business().id, booking }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      /* n8n is optional glue */
    }
  }

  private async busy() {
    const business = this.business();
    const now = this.now();
    const end = new Date(now.getTime() + (business.booking.horizon_days + 1) * 86_400_000);
    const local = this.store
      .read()
      .bookings.filter((booking) => booking.status === "confirmed")
      .map((booking) => ({ start: booking.start, end: booking.end }));
    const remote = await this.calendar.listBusy(now.toISOString(), end.toISOString());
    return [...local, ...remote];
  }

  private async rollback(created: { id: string; eventId?: string }[]) {
    if (!created.length) return;
    const ids = new Set(created.map((item) => item.id));
    await this.store.update((data) => {
      data.bookings = data.bookings.filter((booking) => !ids.has(booking.id));
      data.messages = data.messages.filter((message) => !message.bookingId || !ids.has(message.bookingId));
    });
    for (const item of created) {
      if (!item.eventId) continue;
      try {
        await this.calendar.cancelEvent(item.eventId);
      } catch {
        /* best effort */
      }
    }
  }

  private async ensureExternal(channel: Channel, externalId: string, from?: string): Promise<CallRecord> {
    const existing = this.store.read().calls.find((call) => call.channel === channel && call.externalId === externalId);
    if (existing) return existing;
    const business = this.business();
    const at = this.now().toISOString();
    const call: CallRecord = {
      id: nid("call"),
      channel,
      externalId,
      from,
      startedAt: at,
      status: "in_progress",
      customer: {},
      offered: [],
      phase: "conversation",
      transcript: [{ role: "assistant", text: business.greeting, at }],
      summary: "Call just started.",
    };
    await this.saveCall(call);
    return call;
  }

  private must(id: string): CallRecord {
    const call = this.store.read().calls.find((item) => item.id === id);
    if (!call) throw new DeskError("That call isn't on the desk.", "not_found");
    return structuredClone(call);
  }

  private async saveCall(call: CallRecord) {
    await this.store.update((data) => {
      const index = data.calls.findIndex((item) => item.id === call.id);
      if (index >= 0) data.calls[index] = call;
      else data.calls.push(call);
    });
  }

  private async seedDemo() {
    const business = this.business();
    const now = this.now();
    const express = serviceById(business, "express-wash");
    const interior = serviceById(business, "interior-detail");
    if (!express || !interior) return;
    const morning = findSlots(business, { now, durationMin: express.duration_minutes, part: "morning", limit: 1 });
    const later = findSlots(business, {
      now,
      durationMin: interior.duration_minutes,
      busy: morning.map((slot) => ({ start: slot.start, end: slot.end })),
      limit: 8,
    }).find((slot) => !morning.some((item) => item.start === slot.start));
    if (morning[0]) {
      const booking = await this.bookUnlocked({
        serviceId: express.id,
        start: morning[0].start,
        name: "Jordan Hale",
        phone: "512-555-0177",
        vehicle: "Black truck",
        source: "seed",
        seed: true,
      });
      await this.saveCall(seedCall(business, now, "after_book", booking, [
        ["assistant", business.greeting],
        ["user", "Can I get an express wash tomorrow morning? Jordan Hale, 512-555-0177. Black truck."],
        ["assistant", `You're booked, Jordan. Express Wash on ${morning[0].speech}.`],
      ]));
      booking.callId = this.store.read().calls.at(-1)?.id;
      await this.store.update((data) => {
        const found = data.bookings.find((item) => item.id === booking.id);
        if (found) found.callId = booking.callId;
      });
    }
    if (later) {
      const booking = await this.bookUnlocked({
        serviceId: interior.id,
        start: later.start,
        name: "Priya Shah",
        phone: "737-555-0144",
        email: "priya@example.com",
        source: "seed",
        seed: true,
      });
      await this.saveCall(seedCall(business, now, "after_book", booking, [
        ["user", "I need an interior detail. Priya Shah, 737-555-0144."],
        ["assistant", `You're booked, Priya. Interior Detail on ${later.speech}.`],
      ]));
    }
    await this.saveCall(
      seedCall(business, now, "ended", undefined, [
        ["user", "How much is window tint on a sedan?"],
        ["assistant", "Window Tint is $249 to $449, about 2 hours and 30 minutes. Full vehicle, in a shade that's legal in Texas."],
      ], "completed"),
    );
    const transfer = seedCall(business, now, "transferred", undefined, [
      ["user", "I need to talk to a manager about a ceramic warranty."],
      ["assistant", "I'll connect you with the shop now."],
    ], "transferred");
    transfer.transfer = { number: business.transfer_number, reason: "Ceramic warranty" };
    await this.saveCall(transfer);
  }
}

function replaceLast(call: CallRecord, say: string) {
  const line = [...call.transcript].reverse().find((item) => item.role === "assistant");
  if (line) line.text = say;
  else call.transcript.push({ role: "assistant", text: say, at: new Date().toISOString() });
}

function seedCall(
  business: Business,
  now: Date,
  phase: CallRecord["phase"],
  booking: Booking | undefined,
  lines: Array<["user" | "assistant", string]>,
  status?: CallRecord["status"],
): CallRecord {
  const at = new Date(now.getTime() - 3_600_000).toISOString();
  return {
    id: nid("call"),
    channel: "simulator",
    from: booking?.phone,
    startedAt: at,
    endedAt: at,
    status: status ?? (booking ? "booked" : "completed"),
    customer: { name: booking?.customerName, phone: booking?.phone, email: booking?.email, vehicle: booking?.vehicle },
    serviceId: booking?.serviceId,
    offered: [],
    phase,
    transcript: lines.map(([role, text]) => ({ role, text, at })),
    bookingId: booking?.id,
    summary: booking ? `${booking.customerName} booked ${booking.serviceName}.` : lines.at(-1)?.[1] ?? "Sample call",
    seed: true,
    llm: { provider: "builtin", fallback: true, note: "Sample day, written ahead of time." },
  };
}

export function slotsFor(business: Business, query: SlotQuery): Slot[] {
  return findSlots(business, query);
}
