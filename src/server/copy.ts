import type { Business, Service, Slot } from "./types";
import { clockLabel, WEEKDAY_NAME } from "./time";
import type { Weekday } from "./types";

export function durationSpeech(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours && rest) return `about ${hours} hour${hours > 1 ? "s" : ""} and ${rest} minutes`;
  if (hours === 1) return "about an hour";
  if (hours) return `about ${hours} hours`;
  return `about ${rest} minutes`;
}

export function priceBrief(service: Service): string {
  return `${service.name} is ${service.price}, ${durationSpeech(service.duration_minutes)}.`;
}

export function priceSpeech(service: Service): string {
  return `${priceBrief(service)} ${service.description}`;
}

export function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} or ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, or ${parts[parts.length - 1]}`;
}

export function offerSlots(slots: Slot[]): string {
  if (!slots.length) return "";
  if (slots.length === 1) return `I can do ${slots[0].speech}. Should I book it?`;
  const sameDay = slots.every((slot) => slot.dayLabel === slots[0].dayLabel);
  if (sameDay) return `I have ${joinList(slots.map((slot) => slot.timeLabel))} on ${slots[0].dayLabel}. Which works?`;
  return `I have ${joinList(slots.map((slot) => slot.speech))}. Which works?`;
}

export function bookedSpeech(business: Business, name: string, service: Service, when: string, phone: string): string {
  const first = name.split(" ")[0];
  const deposit = service.deposit ? ` ${business.policies.payment}` : "";
  return `You're booked, ${first}. ${service.name} on ${when}. I'll text ${phone}. We're at ${business.address}.${deposit} Anything else?`;
}

export function dayHoursSpeech(business: Business, weekday: Weekday): string {
  const label = WEEKDAY_NAME[weekday];
  const hours = business.hours[weekday];
  if (!hours) return `${label} we're closed.`;
  return `${label} we're open ${clockLabel(hours.open)} to ${clockLabel(hours.close)}.`;
}

export function smsBody(business: Business, name: string, service: string, when: string): string {
  return `${business.name}: ${name}, you're booked for ${service} on ${when}. ${business.address}. Call ${business.phone} to move it.`;
}

export function emailBody(business: Business, name: string, service: Service, when: string): string {
  const first = name.split(" ")[0];
  return [
    `Hi ${first},`,
    "",
    `You're booked at ${business.name}.`,
    "",
    service.name,
    when,
    business.address,
    "",
    business.policies.cancellation,
    service.deposit ? business.policies.payment : "",
    business.policies.dropoff,
    "",
    business.assistant_name,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function shopAlert(business: Business, name: string, phone: string, service: string, when: string): string {
  return `New booking from the receptionist at ${business.name}: ${name}, ${phone}, ${service}, ${when}.`;
}

export function firstName(name?: string): string | undefined {
  return name?.split(" ")[0];
}
