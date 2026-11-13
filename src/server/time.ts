import type { Weekday } from "./types";

export const WEEKDAY_NAME: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

const SHORT_WEEKDAY: Record<string, Weekday> = {
  Sun: "sun",
  Mon: "mon",
  Tue: "tue",
  Wed: "wed",
  Thu: "thu",
  Fri: "fri",
  Sat: "sat",
};

export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: Weekday;
  ymd: string;
};

export function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const bag: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== "literal") bag[part.type] = part.value;
  }
  let hour = Number(bag.hour);
  if (hour === 24) hour = 0;
  const weekday = SHORT_WEEKDAY[bag.weekday];
  if (!weekday) throw new Error(`Unexpected weekday ${bag.weekday} for ${timeZone}`);
  const year = Number(bag.year);
  const month = Number(bag.month);
  const day = Number(bag.day);
  return {
    year,
    month,
    day,
    hour,
    minute: Number(bag.minute),
    weekday,
    ymd: `${year}-${pad(month)}-${pad(day)}`,
  };
}

export function offsetMinutes(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/** Wall-clock time in `timeZone` as a UTC instant. */
export function zonedTimeToUtc(ymd: string, hm: string, timeZone: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  const [hh, mm] = hm.split(":").map(Number);
  const utcGuess = Date.UTC(y, m - 1, d, hh, mm, 0);
  const first = offsetMinutes(new Date(utcGuess), timeZone);
  let utc = utcGuess - first * 60_000;
  const second = offsetMinutes(new Date(utc), timeZone);
  if (second !== first) utc = utcGuess - second * 60_000;
  return new Date(utc);
}

export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function weekdayOfYmd(ymd: string, timeZone: string): Weekday {
  return zonedParts(zonedTimeToUtc(ymd, "12:00", timeZone), timeZone).weekday;
}

export function formatTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function formatDay(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(date);
}

export function formatLong(date: Date, timeZone: string): string {
  return `${formatDay(date, timeZone)} at ${formatTime(date, timeZone)}`;
}

export function clockLabel(hm: string): string {
  const [hRaw, mRaw] = hm.split(":").map(Number);
  const suffix = hRaw >= 12 ? "PM" : "AM";
  const hour = hRaw % 12 || 12;
  return mRaw === 0 ? `${hour}:00 ${suffix}` : `${hour}:${pad(mRaw)} ${suffix}`;
}

export function dayNameFromYmd(ymd: string, timeZone: string): string {
  return formatDay(zonedTimeToUtc(ymd, "12:00", timeZone), timeZone);
}
