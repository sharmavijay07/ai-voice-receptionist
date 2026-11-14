import { spokenFacts } from "./answers";
import { serviceById } from "./config";
import { bookedSpeech, durationSpeech, offerSlots, priceBrief } from "./copy";
import { interpret, type Interpretation } from "./nlu";
import type { SlotQuery } from "./slots";
import { clockLabel, dayNameFromYmd, formatLong, pad, weekdayOfYmd, zonedParts } from "./time";
import type { Business, CallRecord, Pending, Slot, TurnAction } from "./types";

export type TurnContext = {
  business: Business;
  now: Date;
  slots: (query: SlotQuery) => Slot[];
};

export type BookRequest = {
  serviceId: string;
  start: string;
  name: string;
  phone: string;
  email?: string;
  vehicle?: string;
};

export type DialogueOutcome = {
  call: CallRecord;
  say: string;
  action: TurnAction | "book" | "cancel";
  book?: BookRequest;
};

function push(call: CallRecord, role: "assistant" | "user", text: string, at: string) {
  call.transcript.push({ role, text, at });
}

export function summarize(call: CallRecord): string {
  const name = call.customer.name ?? "Caller";
  const service = call.serviceId?.replace(/-/g, " ");
  if (call.status === "transferred") return `${name} asked for a person${service ? ` about ${service}` : ""}.`;
  if (call.bookingId && service) return `${name} booked ${service}.`;
  if (service) return `${name} asked about ${service}.`;
  return call.transcript.length > 1 ? "Call in progress." : "Call just started.";
}

function finish(
  call: CallRecord,
  say: string,
  at: string,
  action: DialogueOutcome["action"],
  book?: BookRequest,
): DialogueOutcome {
  push(call, "assistant", say, at);
  call.summary = summarize(call);
  return { call, say, action, book };
}

function hmOfSlot(slot: Slot, timeZone: string): string {
  const parts = zonedParts(new Date(slot.start), timeZone);
  return `${pad(parts.hour)}:${pad(parts.minute)}`;
}

function whenLabel(startIso: string, timeZone: string): string {
  return formatLong(new Date(startIso), timeZone);
}

function pickSlot(offered: Slot[], heard: Interpretation, timeZone: string): Slot | undefined {
  if (heard.slotIndex !== undefined) {
    const index = heard.slotIndex < 0 ? offered.length - 1 : heard.slotIndex;
    if (offered[index]) return offered[index];
  }
  if (heard.exactTime) {
    const match = offered.find((slot) => hmOfSlot(slot, timeZone) === heard.exactTime);
    if (match) return match;
  }
  if (heard.yes && offered.length === 1) return offered[0];
  return undefined;
}

function slotQuery(ctx: TurnContext, durationMin: number, extra: Partial<SlotQuery>): Slot[] {
  return ctx.slots({ now: ctx.now, durationMin, limit: 3, ...extra });
}

function reminder(call: CallRecord): string {
  if (call.pending === "name") return "What name should I put the appointment under?";
  if (call.pending === "phone") return "What number should I text the confirmation to?";
  if (call.pending === "when") return "What day should I look at?";
  if (call.pending === "service") return "Which service should I book?";
  if (call.pending === "slot" && call.offered.length) return offerSlots(call.offered);
  return "";
}

function recover(
  ctx: TurnContext,
  durationMin: number,
  serviceName: string,
  heard: Interpretation,
): { say: string; slots: Slot[] } {
  const business = ctx.business;
  const zone = business.timezone;
  const upcoming = slotQuery(ctx, durationMin, { limit: 3 });
  if (heard.day && !business.hours[weekdayOfYmd(heard.day, zone)]) {
    const label = dayNameFromYmd(heard.day, zone);
    return {
      slots: upcoming,
      say: `${label} we're closed. ${upcoming.length ? offerSlots(upcoming) : "I can transfer you to the shop."}`.trim(),
    };
  }
  const sameDay = heard.day ? slotQuery(ctx, durationMin, { day: heard.day, limit: 3 }) : [];
  if (heard.exactTime && heard.day) {
    const ignoredLead = slotQuery(ctx, durationMin, { day: heard.day, exactTime: heard.exactTime, ignoreLead: true, limit: 1 });
    const withLead = slotQuery(ctx, durationMin, { day: heard.day, exactTime: heard.exactTime, limit: 1 });
    if (ignoredLead.length && !withLead.length) {
      const slots = sameDay.length ? sameDay : upcoming;
      return {
        slots,
        say: `I need ${business.booking.lead_time_hours} hours' notice, so ${clockLabel(heard.exactTime)} is too soon. ${offerSlots(slots)}`.trim(),
      };
    }
  }
  if (heard.exactTime && sameDay.length) {
    return { slots: sameDay, say: `${clockLabel(heard.exactTime)} is already taken. ${offerSlots(sameDay)}` };
  }
  if (heard.day && !sameDay.length) {
    const label = dayNameFromYmd(heard.day, zone);
    const couldFit = slotQuery(ctx, durationMin, { day: heard.day, ignoreLead: true, ignoreBusy: true, limit: 1 });
    if (!couldFit.length) {
      return {
        slots: upcoming,
        say: `${serviceName} needs ${durationSpeech(durationMin)}, which doesn't fit ${label}. ${upcoming.length ? offerSlots(upcoming) : ""}`.trim(),
      };
    }
    const withoutLead = slotQuery(ctx, durationMin, { day: heard.day, ignoreLead: true, limit: 1 });
    if (withoutLead.length) {
      return {
        slots: upcoming,
        say: `I need ${business.booking.lead_time_hours} hours' notice, so ${label} is too soon. ${upcoming.length ? offerSlots(upcoming) : ""}`.trim(),
      };
    }
    return {
      slots: upcoming,
      say: `${label} is booked full. ${upcoming.length ? offerSlots(upcoming) : "I can transfer you to the shop."}`.trim(),
    };
  }
  if (heard.part && sameDay.length) return { slots: sameDay, say: `Nothing open in the ${heard.part}. ${offerSlots(sameDay)}` };
  if (!upcoming.length) {
    return {
      slots: [],
      say: `I don't have a ${serviceName} opening in the next ${business.booking.horizon_days} days. I can transfer you to the shop.`,
    };
  }
  return { slots: upcoming, say: offerSlots(upcoming) };
}

function ready(call: CallRecord): boolean {
  return Boolean(call.serviceId && call.customer.name && call.customer.phone && call.selectedStart);
}

function advance(call: CallRecord, heard: Interpretation, ctx: TurnContext, at: string): DialogueOutcome {
  const business = ctx.business;
  if (call.phase === "conversation" || call.phase === "after_book" || call.phase === "transferred") call.phase = "booking";
  call.expectingBookYes = false;
  const service = call.serviceId ? serviceById(business, call.serviceId) : undefined;
  const price = heard.askedPrice && service ? `${priceBrief(service)} ` : "";

  if (call.offered.length) {
    const picked = pickSlot(call.offered, heard, business.timezone);
    if (picked) {
      call.selectedStart = picked.start;
      call.offered = [picked];
    } else if (heard.no) {
      call.offered = [];
      call.selectedStart = undefined;
      call.pending = "when";
      return finish(call, "No problem. What day should I look at instead?", at, "continue");
    } else if (heard.exactTime) {
      call.pending = "slot";
      return finish(call, `I don't have ${clockLabel(heard.exactTime)} in the times I offered. ${offerSlots(call.offered)}`, at, "continue");
    }
  }

  if (!service) {
    call.pending = "service";
    return finish(call, `${price}What should we book? ${business.menu_speech}`, at, "continue");
  }

  const askedWhen = Boolean(heard.day || heard.part || heard.exactTime);
  if (!call.selectedStart && askedWhen) {
    const exact =
      heard.exactTime && heard.day
        ? slotQuery(ctx, service.duration_minutes, { day: heard.day, exactTime: heard.exactTime, limit: 1 })
        : [];
    if (exact.length) {
      call.selectedStart = exact[0].start;
      call.offered = exact;
    } else {
      const opened =
        !heard.exactTime && (heard.day || heard.part)
          ? slotQuery(ctx, service.duration_minutes, { day: heard.day, part: heard.part, limit: 3 })
          : [];
      if (opened.length) {
        call.offered = opened;
        call.pending = "slot";
        return finish(call, `${price}${offerSlots(opened)}`, at, "continue");
      }
      const recovered = recover(ctx, service.duration_minutes, service.name, heard);
      call.offered = recovered.slots;
      call.pending = recovered.slots.length ? "slot" : "when";
      return finish(call, `${price}${recovered.say}`, at, "continue");
    }
  }

  if (ready(call) && service && call.selectedStart && call.customer.name && call.customer.phone) {
    const say = `${price}${bookedSpeech(business, call.customer.name, service, whenLabel(call.selectedStart, business.timezone), call.customer.phone)}`;
    call.pending = "else";
    call.phase = "after_book";
    call.status = "booked";
    return finish(call, say, at, "book", {
      serviceId: service.id,
      start: call.selectedStart,
      name: call.customer.name,
      phone: call.customer.phone,
      email: call.customer.email,
      vehicle: call.customer.vehicle,
    });
  }

  if (!call.customer.name) {
    call.pending = "name";
    const held = call.selectedStart ? `I can hold ${service.name} for ${whenLabel(call.selectedStart, business.timezone)}. ` : "";
    return finish(call, `${price}${held}Who is the appointment for?`, at, "continue");
  }
  if (!call.customer.phone) {
    call.pending = "phone";
    return finish(call, `${price}Thanks, ${call.customer.name.split(" ")[0]}. What's the best number for a confirmation text?`, at, "continue");
  }
  call.pending = "when";
  return finish(call, `${price}What day works for the ${service.name}? ${business.hours_speech}`, at, "continue");
}

function merge(call: CallRecord, heard: Interpretation) {
  if (heard.serviceId) call.serviceId = heard.serviceId;
  if (heard.name) call.customer.name = heard.name;
  if (heard.phone) call.customer.phone = heard.phone;
  if (heard.email) call.customer.email = heard.email;
  if (heard.vehicle) call.customer.vehicle = heard.vehicle;
}

function endCall(call: CallRecord, say: string, at: string): DialogueOutcome {
  call.phase = "ended";
  call.endedAt = at;
  if (call.status === "in_progress") call.status = "completed";
  call.pending = undefined;
  return finish(call, say, at, "end");
}

function inBooking(call: CallRecord, heard: Interpretation): boolean {
  return (
    heard.intent === "book" ||
    heard.intent === "provide" ||
    call.phase === "booking" ||
    call.pending === "slot" ||
    call.pending === "name" ||
    call.pending === "phone" ||
    call.pending === "when" ||
    call.pending === "service"
  );
}

export function nextTurn(call: CallRecord, text: string, ctx: TurnContext): DialogueOutcome {
  const trimmed = text.trim();
  const at = ctx.now.toISOString();
  const next: CallRecord = structuredClone(call);
  if (!trimmed) {
    return finish(next, "I didn't catch that. I can quote a service, check the calendar, or connect you with the shop.", at, "continue");
  }
  push(next, "user", trimmed, at);
  const heard = interpret(trimmed, ctx.business, ctx.now, next.pending);
  if (next.expectingBookYes && heard.yes && heard.intent !== "transfer" && heard.intent !== "goodbye") heard.intent = "book";
  merge(next, heard);
  const business = ctx.business;
  const service = next.serviceId ? serviceById(business, next.serviceId) : undefined;

  if (heard.intent === "transfer") {
    next.status = "transferred";
    next.phase = "transferred";
    next.transfer = { number: business.transfer_number, reason: trimmed.slice(0, 180) };
    return finish(next, "I'll connect you with the shop now.", at, "transfer");
  }

  if (next.pending === "else" && (heard.intent === "goodbye" || heard.no) && heard.intent !== "book") {
    const first = next.customer.name?.split(" ")[0];
    const bye = next.bookingId
      ? `You're all set${first ? `, ${first}` : ""}. We'll see you then.`
      : `Thanks for calling ${business.name}. Have a good one.`;
    return endCall(next, bye, at);
  }

  if (heard.intent === "goodbye") return endCall(next, `Thanks for calling ${business.name}. Have a good one.`, at);
  if (heard.intent === "cancel") return finish(next, "Let me check the book.", at, "cancel");

  if (isInfoQuestion(heard)) {
    const parts = spokenFacts(business, heard, ctx.now);
    if (parts.length) {
      const locationOnly = heard.intent === "location" && !heard.askedPrice && !heard.askedHours && !heard.askedOpenNow;
      const servicesOnly = heard.intent === "services" && !heard.askedPrice && !heard.askedHours && !heard.askedOpenNow;
      if (next.phase === "booking" || isCollecting(next.pending)) {
        return finish(next, `${parts.join(" ")} ${reminder(next)}`.trim(), at, "continue");
      }
      if (!locationOnly && !servicesOnly) next.expectingBookYes = true;
      const invite = locationOnly || servicesOnly ? "" : " Want me to book a visit?";
      return finish(next, `${parts.join(" ")}${invite}`.trim(), at, "continue");
    }
  }

  if (inBooking(next, heard)) return advance(next, heard, ctx, at);

  if (heard.intent === "faq" && heard.faqId) {
    const faq = business.faqs.find((item) => item.id === heard.faqId);
    next.expectingBookYes = Boolean(service);
    return finish(next, `${faq?.answer ?? ""}${service ? " Want me to book it?" : ""}`.trim(), at, "continue");
  }

  return finish(next, `I can quote a service, check ${business.name}'s calendar, or connect you with the shop. What do you need?`, at, "continue");
}

function isInfoQuestion(heard: Interpretation): boolean {
  if (heard.intent === "book" || heard.intent === "provide" || heard.intent === "cancel" || heard.intent === "transfer" || heard.intent === "goodbye") {
    return false;
  }
  return (
    heard.intent === "hours" ||
    heard.intent === "open_now" ||
    heard.intent === "location" ||
    heard.intent === "pricing" ||
    heard.intent === "services" ||
    heard.askedPrice ||
    heard.askedHours ||
    heard.askedOpenNow ||
    heard.askedLocation
  );
}

function isCollecting(pending?: Pending): boolean {
  return pending === "service" || pending === "name" || pending === "phone" || pending === "when" || pending === "slot";
}
