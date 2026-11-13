import * as chrono from "chrono-node";
import type { Business, Pending } from "./types";
import type { PartOfDay } from "./slots";
import { pad, zonedParts, zonedTimeToUtc } from "./time";

const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const VEHICLE_RE = /\b((?:19|20)\d{2}\s+)?(white|black|red|blue|grey|gray|silver|green|pearl)\s+([a-z0-9]+)\b/i;

const NAME_INTRO =
  /(?:my name is|this is|i am|i'm|it’s|it's|name's|name is)\s+([a-z][a-z'’-]+(?:\s+[a-z][a-z'’-]+){0,3})/i;
const NAME_FOR = /\b(?:for|under the name|under)\s+([a-z][a-z'’-]+(?:\s+[a-z][a-z'’-]+){0,2})/i;

const STOP_NAME = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "at",
  "on",
  "for",
  "my",
  "our",
  "your",
  "number",
  "phone",
  "calling",
  "looking",
  "interested",
  "wondering",
  "hoping",
  "trying",
  "here",
  "good",
  "fine",
  "not",
  "just",
  "going",
  "gonna",
  "ready",
  "available",
  "next",
  "this",
  "today",
  "tomorrow",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "morning",
  "afternoon",
  "evening",
  "please",
  "thanks",
  "thank",
]);

const DAY_WORD: Record<string, string> = {
  monday: "mon",
  tuesday: "tue",
  wednesday: "wed",
  thursday: "thu",
  friday: "fri",
  saturday: "sat",
  sunday: "sun",
};

export type Intent =
  | "transfer"
  | "goodbye"
  | "hours"
  | "open_now"
  | "location"
  | "pricing"
  | "services"
  | "faq"
  | "book"
  | "cancel"
  | "provide"
  | "unknown";

export type Interpretation = {
  intent: Intent;
  serviceId?: string;
  name?: string;
  phone?: string;
  email?: string;
  vehicle?: string;
  day?: string;
  part?: PartOfDay;
  exactTime?: string;
  slotIndex?: number;
  yes: boolean;
  no: boolean;
  askedPrice: boolean;
  askedHours: boolean;
  askedOpenNow: boolean;
  askedLocation: boolean;
  faqId?: string;
  weekdayWord?: keyof typeof DAY_WORD;
};

export function normalizePhone(raw: string): string | undefined {
  const digits = raw.replace(/\D/g, "");
  const local = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (local.length !== 10) return undefined;
  return `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}`;
}

export function e164(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  const local = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return local.length === 10 ? `+1${local}` : phone;
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function cleanName(raw: string): string | undefined {
  const parts = raw.replace(/[,.].*$/, "").trim().split(/\s+/);
  const kept: string[] = [];
  for (const part of parts) {
    const token = part.toLowerCase();
    if (STOP_NAME.has(token)) break;
    kept.push(part);
    if (kept.length === 3) break;
  }
  if (!kept.length || !kept[0] || STOP_NAME.has(kept[0].toLowerCase())) return undefined;
  const titled = titleCase(kept.join(" "));
  return titled.trim() ? titled : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function matchService(text: string, business: Business): string | undefined {
  const hay = text.toLowerCase();
  let best: { id: string; len: number } | undefined;
  for (const service of business.services) {
    const labels = [service.name, service.id.replace(/-/g, " "), ...service.aliases];
    for (const label of labels) {
      const re = new RegExp(`\\b${escapeRegExp(label.toLowerCase())}\\b`, "i");
      if (re.test(hay) && (!best || label.length > best.len)) best = { id: service.id, len: label.length };
    }
  }
  return best?.id;
}

function matchFaq(text: string, business: Business): string | undefined {
  let best: { id: string; len: number } | undefined;
  for (const faq of business.faqs) {
    for (const trigger of faq.triggers) {
      const re = new RegExp(`\\b${escapeRegExp(trigger.toLowerCase())}\\b`, "i");
      if (re.test(text) && (!best || trigger.length > best.len)) best = { id: faq.id, len: trigger.length };
    }
  }
  return best?.id;
}

function shopNowAsUtc(now: Date, timeZone: string): Date {
  const parts = zonedParts(now, timeZone);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0));
}

export function parseWhen(
  text: string,
  now: Date,
  timeZone: string,
): { day?: string; part?: PartOfDay; exactTime?: string } {
  let part: PartOfDay | undefined;
  if (/\b(evening|tonight)\b/i.test(text)) part = "evening";
  else if (/\bafternoon\b/i.test(text)) part = "afternoon";
  else if (/\bmorning\b/i.test(text)) part = "morning";

  const hasClock = /\b\d{1,2}(:\d{2})?\s*(a\.?m\.?|p\.?m\.?)\b/i.test(text) || /\b\d{1,2}:\d{2}\b/.test(text) || /\bat\s+\d{1,2}\b/i.test(text);
  const cleaned = text.replace(PHONE_RE, " ").replace(/\$\d[\d,]*/g, " ");
  const results = chrono.parse(cleaned, shopNowAsUtc(now, timeZone), { forwardDate: true });
  if (!results.length) return { part };

  const start = results[0].start;
  const year = start.get("year");
  const month = start.get("month");
  const day = start.get("day");
  if (year == null || month == null || day == null) return { part };
  const ymd = `${year}-${pad(month)}-${pad(day)}`;
  if (!hasClock) return { day: ymd, part };

  let hour = start.get("hour");
  const minute = start.get("minute") ?? 0;
  if (hour == null) return { day: ymd, part };
  const explicitAm = /\ba\.?m\.?\b/i.test(text);
  const explicitPm = /\bp\.?m\.?\b/i.test(text);
  if (!explicitAm && !explicitPm && hour < 8 && hour + 12 <= 19) hour += 12;
  if (explicitPm && hour < 12) hour += 12;
  if (explicitAm && hour === 12) hour = 0;
  const exactTime = `${pad(hour)}:${pad(minute)}`;
  const instant = zonedTimeToUtc(ymd, exactTime, timeZone);
  const zoned = zonedParts(instant, timeZone);
  return { day: zoned.ymd, part, exactTime: `${pad(zoned.hour)}:${pad(zoned.minute)}` };
}

function looksLikeBareName(text: string, business: Business): string | undefined {
  const cleaned = text.replace(/[.!?]/g, "").trim();
  if (!/^[a-z][a-z'’-]+(\s+[a-z][a-z'’-]+){0,2}$/i.test(cleaned)) return undefined;
  if (matchService(cleaned, business)) return undefined;
  if (/^(yes|yeah|yep|no|nope|ok|okay|tomorrow|today|morning|afternoon|evening)$/i.test(cleaned)) return undefined;
  return cleanName(cleaned);
}

export function interpret(text: string, business: Business, now: Date, pending?: Pending): Interpretation {
  const trimmed = text.trim();
  const phoneRaw = trimmed.match(PHONE_RE)?.[0];
  const phone = phoneRaw ? normalizePhone(phoneRaw) : undefined;
  const email = trimmed.match(EMAIL_RE)?.[0];
  const vehicleMatch = trimmed.match(VEHICLE_RE);
  const vehicle = vehicleMatch ? titleCase(vehicleMatch[0]) : undefined;
  const serviceId = matchService(trimmed, business);
  const faqId = matchFaq(trimmed, business);
  const when = parseWhen(trimmed, now, business.timezone);
  const intro = trimmed.match(NAME_INTRO);
  const namedFor = trimmed.match(NAME_FOR);
  let name = (intro?.[1] ? cleanName(intro[1]) : undefined) ?? (namedFor?.[1] ? cleanName(namedFor[1]) : undefined);
  if (!name && pending === "name") name = looksLikeBareName(trimmed, business);

  let slotIndex: number | undefined;
  if (/\b(first|earliest|1st|number one)\b/i.test(trimmed)) slotIndex = 0;
  else if (/\b(second|2nd)\b/i.test(trimmed)) slotIndex = 1;
  else if (/\b(third|3rd)\b/i.test(trimmed)) slotIndex = 2;
  else if (/\blast\b/i.test(trimmed)) slotIndex = -1;

  const yes = /^(yes|yeah|yep|yup|sure|ok|okay|please do|do it|book it|that works|perfect|sounds good|go ahead|confirm|let's do it|lets do it)\b/i.test(trimmed);
  const no = /^(no|nope|nah|not that|different time|another time|none of (those|these))\b/i.test(trimmed);
  const goodbye = /^(no thanks|no thank you|that'?s all|that is all|that'?s everything|nothing else|i'?m good|im good|all set|goodbye|bye|hang up)\b/i.test(trimmed);
  const transfer = /\b(transfer me|real person|actual person|human being|live person|talk to (a |the )?(person|human|manager|owner|representative|operator)|speak to (a |the )?(person|human|manager|owner|operator)|customer service|a manager|the owner|the manager)\b/i.test(trimmed);
  const askedPrice = /\b(how much|price|pricing|cost|quote|rates?)\b/i.test(trimmed);
  const bookWords = /\b(book|schedule|appointment|reservation|come in|drop[\s-]?off|set up|sign me up|reserve)\b/i.test(trimmed);
  const weekdayWord = Object.keys(DAY_WORD).find((word) => new RegExp(`\\b${word}\\b`, "i").test(trimmed)) as
    | keyof typeof DAY_WORD
    | undefined;
  const askedOpenNow = /\b(open now|are you open|still open|open today|are you guys open)\b/i.test(trimmed);
  const askedHours =
    /\b(hours|what time (do you|are you)|when (are you|do you) open|when do you close|opening time|are you open)\b/i.test(trimmed) ||
    (askedOpenNow && Boolean(weekdayWord));
  const askedLocation = /\b(where are you|address|located|directions|parking)\b/i.test(trimmed);
  const services = /\b(what do you (offer|do)|services|menu|options)\b/i.test(trimmed);
  const policy = /\bpolicy\b/i.test(trimmed);
  const cancel = /\bcancel\b/i.test(trimmed) && !policy;

  const bookingPending = pending === "service" || pending === "name" || pending === "phone" || pending === "when" || pending === "slot";

  let intent: Intent = "unknown";
  if (transfer) intent = "transfer";
  else if (pending === "slot" && (slotIndex !== undefined || when.exactTime || yes || no)) intent = "provide";
  else if (pending === "name" && name) intent = "provide";
  else if (pending === "phone" && phone) intent = "provide";
  else if (goodbye && pending !== "slot") intent = "goodbye";
  else if (cancel) intent = "cancel";
  else if (askedOpenNow && !weekdayWord) intent = "open_now";
  else if (askedHours) intent = "hours";
  else if (askedLocation) intent = "location";
  else if (bookWords || (bookingPending && (name || phone || when.day || serviceId || slotIndex !== undefined))) intent = "book";
  else if (askedPrice) intent = "pricing";
  else if (faqId && !bookWords) intent = "faq";
  else if (services) intent = "services";
  else if (serviceId) intent = "pricing";
  else if (bookingPending) intent = "provide";

  return {
    intent,
    serviceId,
    name,
    phone,
    email,
    vehicle,
    day: when.day,
    part: when.part,
    exactTime: when.exactTime,
    slotIndex,
    yes,
    no,
    askedPrice,
    askedHours,
    askedOpenNow,
    askedLocation,
    faqId,
    weekdayWord,
  };
}
