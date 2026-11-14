import { serviceById } from "./config";
import { dayHoursSpeech, priceSpeech } from "./copy";
import { interpret, type Interpretation } from "./nlu";
import { WEEKDAY_NAME, zonedParts, pad } from "./time";
import type { Business, Weekday } from "./types";

function isOpen(business: Business, now: Date): boolean {
  const parts = zonedParts(now, business.timezone);
  const hours = business.hours[parts.weekday];
  if (!hours) return false;
  const hm = `${pad(parts.hour)}:${pad(parts.minute)}`;
  return hm >= hours.open && hm < hours.close;
}

function weekdayOf(word: string): Weekday {
  return word.slice(0, 3) as Weekday;
}

export function spokenFacts(business: Business, heard: Interpretation, now: Date): string[] {
  const parts: string[] = [];
  const service = heard.serviceId ? serviceById(business, heard.serviceId) : undefined;
  const wantsPrice = heard.askedPrice || heard.intent === "pricing";
  if (wantsPrice) parts.push(service ? priceSpeech(service) : `${business.menu_speech} Which one do you want?`);
  if (heard.intent === "services" && !wantsPrice) parts.push(`${business.menu_speech} I can book any of those.`);
  if (heard.askedOpenNow && !heard.weekdayWord) {
    parts.push(
      isOpen(business, now)
        ? `Yes, we're open right now. ${business.hours_speech}`
        : `We're closed right now. ${business.hours_speech} I can still put you on the book.`,
    );
  } else if (heard.askedHours && heard.weekdayWord) {
    parts.push(dayHoursSpeech(business, weekdayOf(heard.weekdayWord)));
    parts.push(business.hours_speech);
  } else if (heard.askedHours) {
    parts.push(business.hours_speech);
  }
  if (heard.askedLocation || heard.intent === "location") {
    parts.push(`We're at ${business.address}. ${business.policies.dropoff}`);
  }
  if (heard.faqId && heard.intent !== "faq") {
    const faq = business.faqs.find((item) => item.id === heard.faqId);
    if (faq) parts.push(faq.answer);
  }
  return parts;
}

export function supplementReply(userText: string, reply: string, business: Business, now: Date): string {
  const heard = interpret(userText, business, now);
  const additions: string[] = [];
  const lower = reply.toLowerCase();
  const service = heard.serviceId ? serviceById(business, heard.serviceId) : undefined;
  if (heard.askedPrice && service && !lower.includes(service.price.toLowerCase())) additions.push(priceSpeech(service));
  else if (heard.askedPrice && !service && !reply.includes("$")) additions.push(business.menu_speech);
  if (heard.askedOpenNow && !heard.weekdayWord && !/open right now|closed right now/i.test(reply)) {
    additions.push(
      isOpen(business, now)
        ? `Yes, we're open right now. ${business.hours_speech}`
        : `We're closed right now. ${business.hours_speech}`,
    );
  } else if (heard.weekdayWord && (heard.askedHours || heard.askedOpenNow)) {
    const label = WEEKDAY_NAME[weekdayOf(heard.weekdayWord)].toLowerCase();
    if (!lower.includes(label)) additions.push(dayHoursSpeech(business, weekdayOf(heard.weekdayWord)));
  } else if (heard.askedHours && !/\b(open|closed|am|pm)\b/i.test(reply)) {
    additions.push(business.hours_speech);
  }
  if (heard.askedLocation && !lower.includes(business.address.toLowerCase())) {
    additions.push(`We're at ${business.address}. ${business.policies.dropoff}`);
  }
  if (!additions.length) return reply;
  return `${reply.trim()} ${additions.join(" ")}`.trim();
}
