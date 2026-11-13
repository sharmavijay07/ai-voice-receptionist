import type { Business, Busy, Slot } from "./types";
import { addDays, pad, weekdayOfYmd, zonedParts, zonedTimeToUtc, formatDay, formatLong, formatTime } from "./time";

export type PartOfDay = "morning" | "afternoon" | "evening";

export type SlotQuery = {
  now: Date;
  durationMin: number;
  busy?: Busy[];
  day?: string;
  part?: PartOfDay;
  exactTime?: string;
  limit?: number;
  ignoreLead?: boolean;
  ignoreBusy?: boolean;
};

export function makeSlot(start: Date, end: Date, timeZone: string): Slot {
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    timeLabel: formatTime(start, timeZone),
    dayLabel: formatDay(start, timeZone),
    speech: formatLong(start, timeZone),
  };
}

function overlaps(start: Date, end: Date, busy: Busy[], bufferMin: number): boolean {
  const buffer = bufferMin * 60_000;
  const a0 = start.getTime();
  const a1 = end.getTime();
  return busy.some((item) => {
    const b0 = new Date(item.start).getTime() - buffer;
    const b1 = new Date(item.end).getTime() + buffer;
    return a0 < b1 && b0 < a1;
  });
}

function inPart(hour: number, part: PartOfDay | undefined): boolean {
  if (!part) return true;
  if (part === "morning") return hour < 12;
  if (part === "afternoon") return hour >= 12 && hour < 17;
  return hour >= 17;
}

export function findSlots(business: Business, query: SlotQuery): Slot[] {
  const zone = business.timezone;
  const today = zonedParts(query.now, zone).ymd;
  const earliest = query.now.getTime() + (query.ignoreLead ? 0 : business.booking.lead_time_hours) * 3_600_000;
  const step = business.booking.slot_minutes * 60_000;
  const duration = query.durationMin * 60_000;
  const busy = query.ignoreBusy ? [] : (query.busy ?? []);
  const found: Slot[] = [];
  const horizon = business.booking.horizon_days;

  for (let offset = 0; offset <= horizon; offset += 1) {
    const ymd = addDays(today, offset);
    if (query.day && ymd !== query.day) continue;
    const hours = business.hours[weekdayOfYmd(ymd, zone)];
    if (!hours) continue;
    const open = zonedTimeToUtc(ymd, hours.open, zone).getTime();
    const close = zonedTimeToUtc(ymd, hours.close, zone).getTime();
    for (let cursor = open; cursor + duration <= close; cursor += step) {
      if (cursor < earliest) continue;
      const start = new Date(cursor);
      const parts = zonedParts(start, zone);
      if (!inPart(parts.hour, query.part)) continue;
      const hm = `${pad(parts.hour)}:${pad(parts.minute)}`;
      if (query.exactTime && hm !== query.exactTime) continue;
      const end = new Date(cursor + duration);
      if (overlaps(start, end, busy, business.booking.buffer_minutes)) continue;
      found.push(makeSlot(start, end, zone));
    }
  }
  return found.slice(0, query.limit ?? 3);
}
