import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { Business, Service, Weekday } from "./types";

const hm = z.string().regex(/^\d{2}:\d{2}$/, "use HH:MM");
const windowSchema = z.object({ open: hm, close: hm }).nullable();

const businessSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  assistant_name: z.string().min(1),
  phone: z.string().min(7),
  transfer_number: z.string().min(7),
  email: z.string().min(3),
  timezone: z.string().min(1),
  address: z.string().min(1),
  greeting: z.string().min(1),
  hours_speech: z.string().min(1),
  menu_speech: z.string().min(1),
  hours: z.object({
    mon: windowSchema,
    tue: windowSchema,
    wed: windowSchema,
    thu: windowSchema,
    fri: windowSchema,
    sat: windowSchema,
    sun: windowSchema,
  }),
  services: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        duration_minutes: z.number().int().positive(),
        price: z.string().min(1),
        description: z.string().min(1),
        aliases: z.array(z.string()).default([]),
        deposit: z.boolean().default(false),
      }),
    )
    .min(1),
  faqs: z
    .array(
      z.object({
        id: z.string().min(1),
        triggers: z.array(z.string().min(1)).min(1),
        answer: z.string().min(1),
      }),
    )
    .default([]),
  booking: z.object({
    slot_minutes: z.number().int().positive(),
    lead_time_hours: z.number().nonnegative(),
    horizon_days: z.number().int().positive(),
    buffer_minutes: z.number().nonnegative().default(0),
  }),
  policies: z.object({
    cancellation: z.string().min(1),
    payment: z.string().min(1),
    dropoff: z.string().min(1),
  }),
});

type Cache = { path: string; mtimeMs: number; business: Business };

let cache: Cache | null = null;

export function clearBusinessCache(): void {
  cache = null;
}

export function resolveConfigPath(configPath: string): string {
  return path.isAbsolute(configPath) ? configPath : path.join(process.cwd(), configPath);
}

export function loadBusiness(configPath: string): Business {
  const abs = resolveConfigPath(configPath);
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(abs).mtimeMs;
  } catch {
    throw new Error(`Business config not found at ${configPath}`);
  }
  if (cache && cache.path === abs && cache.mtimeMs === mtimeMs) return cache.business;
  const raw = parse(readFileSync(abs, "utf8"));
  const parsed = businessSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Business config ${configPath} is invalid: ${detail}`);
  }
  const ids = new Set<string>();
  for (const service of parsed.data.services) {
    if (ids.has(service.id)) throw new Error(`Duplicate service id ${service.id} in ${configPath}`);
    ids.add(service.id);
  }
  const business = parsed.data as Business;
  cache = { path: abs, mtimeMs, business };
  return business;
}

export function serviceById(business: Business, id: string): Service | undefined {
  return business.services.find((service) => service.id === id);
}

export function weekdayHours(business: Business, weekday: Weekday) {
  return business.hours[weekday];
}
