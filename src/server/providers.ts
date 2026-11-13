import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import type { Busy, EnvMap, OutboundMessage } from "./types";
import { nid } from "./types";

export type CalendarEvent = {
  start: string;
  end: string;
  timeZone: string;
  summary: string;
  description: string;
};

export interface CalendarProvider {
  readonly mode: "mock" | "google";
  listBusy(fromIso: string, toIso: string): Promise<Busy[]>;
  createEvent(event: CalendarEvent): Promise<{ eventId: string }>;
  cancelEvent(eventId: string): Promise<void>;
}

export interface CrmProvider {
  readonly mode: "local" | "google";
  record(row: string[]): Promise<{ ok: boolean; error?: string }>;
}

export interface MessageProvider {
  readonly mode: string;
  send(input: { to: string; body: string; subject?: string }): Promise<{ status: OutboundMessage["status"]; error?: string }>;
}

export class MockCalendar implements CalendarProvider {
  readonly mode = "mock" as const;
  async listBusy(): Promise<Busy[]> {
    return [];
  }
  async createEvent(): Promise<{ eventId: string }> {
    return { eventId: nid("evt") };
  }
  async cancelEvent(): Promise<void> {}
}

export class MockMessages implements MessageProvider {
  constructor(readonly mode: string) {}
  async send(): Promise<{ status: OutboundMessage["status"] }> {
    return { status: "logged" };
  }
}

export class LocalCrm implements CrmProvider {
  readonly mode = "local" as const;
  async record(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
}

type GoogleCreds = { clientEmail: string; privateKey: string; calendarId: string; spreadsheetId: string };

export function googleCreds(env: EnvMap): GoogleCreds | null {
  const clientEmail = env.GOOGLE_CLIENT_EMAIL;
  const privateKey = env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) return null;
  return {
    clientEmail,
    privateKey,
    calendarId: env.GOOGLE_CALENDAR_ID || "primary",
    spreadsheetId: env.GOOGLE_SHEETS_ID || "",
  };
}

function b64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export class GoogleAccess {
  private token?: { value: string; exp: number };
  constructor(
    private readonly creds: GoogleCreds,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async tokenValue(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.token && this.token.exp > now + 60) return this.token.value;
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = b64url(
      JSON.stringify({
        iss: this.creds.clientEmail,
        scope: "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/spreadsheets",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
      }),
    );
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${payload}`);
    const assertion = `${header}.${payload}.${signer.sign(this.creds.privateKey, "base64url")}`;
    const response = await this.fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    });
    if (!response.ok) throw new Error(`Google auth failed (${response.status})`);
    const json = (await response.json()) as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, exp: now + json.expires_in };
    return json.access_token;
  }
}

export class GoogleCalendar implements CalendarProvider {
  readonly mode = "google" as const;
  constructor(
    private readonly creds: GoogleCreds,
    private readonly auth: GoogleAccess,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async listBusy(fromIso: string, toIso: string): Promise<Busy[]> {
    const token = await this.auth.tokenValue();
    const response = await this.fetchImpl("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ timeMin: fromIso, timeMax: toIso, items: [{ id: this.creds.calendarId }] }),
    });
    if (!response.ok) throw new Error(`Google Calendar freeBusy failed (${response.status})`);
    const json = (await response.json()) as { calendars?: Record<string, { busy?: Busy[] }> };
    return json.calendars?.[this.creds.calendarId]?.busy ?? [];
  }

  async createEvent(event: CalendarEvent): Promise<{ eventId: string }> {
    const token = await this.auth.tokenValue();
    const response = await this.fetchImpl(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.creds.calendarId)}/events`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          summary: event.summary,
          description: event.description,
          start: { dateTime: event.start, timeZone: event.timeZone },
          end: { dateTime: event.end, timeZone: event.timeZone },
        }),
      },
    );
    if (!response.ok) throw new Error(`Google Calendar insert failed (${response.status})`);
    const json = (await response.json()) as { id: string };
    return { eventId: json.id };
  }

  async cancelEvent(eventId: string): Promise<void> {
    if (eventId.startsWith("evt_")) return;
    const token = await this.auth.tokenValue();
    const response = await this.fetchImpl(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.creds.calendarId)}/events/${encodeURIComponent(eventId)}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok && response.status !== 404 && response.status !== 410) {
      throw new Error(`Google Calendar delete failed (${response.status})`);
    }
  }
}

export class GoogleSheets implements CrmProvider {
  readonly mode = "google" as const;
  constructor(
    private readonly spreadsheetId: string,
    private readonly auth: GoogleAccess,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async record(row: string[]): Promise<{ ok: boolean; error?: string }> {
    if (!this.spreadsheetId) return { ok: false, error: "GOOGLE_SHEETS_ID is empty" };
    try {
      const token = await this.auth.tokenValue();
      const range = encodeURIComponent("Calls!A:J");
      const response = await this.fetchImpl(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(this.spreadsheetId)}/values/${range}:append?valueInputOption=USER_ENTERED`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ values: [row] }),
        },
      );
      if (!response.ok) return { ok: false, error: `Sheets append failed (${response.status})` };
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Sheets append failed" };
    }
  }
}

export class TwilioSms implements MessageProvider {
  readonly mode = "twilio";
  constructor(
    private readonly env: EnvMap,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async send(input: { to: string; body: string }): Promise<{ status: OutboundMessage["status"]; error?: string }> {
    const sid = this.env.TWILIO_ACCOUNT_SID;
    const token = this.env.TWILIO_AUTH_TOKEN;
    const from = this.env.TWILIO_FROM_NUMBER;
    if (!sid || !token || !from) return { status: "failed", error: "Twilio SMS is not configured" };
    const response = await this.fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: input.to, From: from, Body: input.body }),
    });
    if (!response.ok) return { status: "failed", error: `Twilio SMS failed (${response.status})` };
    return { status: "sent" };
  }
}

export class ResendEmail implements MessageProvider {
  readonly mode = "resend";
  constructor(
    private readonly env: EnvMap,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async send(input: { to: string; body: string; subject?: string }): Promise<{ status: OutboundMessage["status"]; error?: string }> {
    const key = this.env.RESEND_API_KEY;
    const from = this.env.NOTIFY_FROM_EMAIL;
    if (!key || !from) return { status: "failed", error: "Resend is not configured" };
    const response = await this.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [input.to], subject: input.subject ?? "Your appointment", text: input.body }),
    });
    if (!response.ok) return { status: "failed", error: `Resend failed (${response.status})` };
    return { status: "sent" };
  }
}

export function validateTwilioSignature(input: {
  url: string;
  params: Record<string, string>;
  signature: string;
  authToken: string;
}): boolean {
  const signed = input.url + Object.keys(input.params).sort().map((key) => key + input.params[key]).join("");
  const hmac = createHmac("sha1", input.authToken).update(signed).digest("base64");
  const a = Buffer.from(hmac);
  const b = Buffer.from(input.signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
