import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import nodemailer from "nodemailer";
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

export const CALL_SHEET_HEADERS = ["Timestamp", "Call id", "From", "Customer", "Phone", "Service", "Status", "Appointment", "Summary", "Channel"];

function filled(value: string | undefined): boolean {
  return Boolean(value && value.trim());
}

function parseServiceAccount(raw?: string): { clientEmail: string; privateKey: string } | null {
  if (!raw?.trim()) return null;
  let text = raw.trim();
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) text = text.slice(1, -1);
  if (!text.startsWith("{")) {
    try {
      text = Buffer.from(text, "base64").toString("utf8");
    } catch {
      return null;
    }
  }
  try {
    const json = JSON.parse(text) as { client_email?: string; private_key?: string };
    if (!json.client_email || !json.private_key) return null;
    return { clientEmail: json.client_email, privateKey: json.private_key.replace(/\\n/g, "\n") };
  } catch {
    return null;
  }
}

export function googleCreds(env: EnvMap): GoogleCreds | null {
  const fromJson = parseServiceAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const clientEmail = fromJson?.clientEmail || env.GOOGLE_CLIENT_EMAIL;
  const privateKey = (fromJson?.privateKey || env.GOOGLE_PRIVATE_KEY)?.replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) return null;
  return {
    clientEmail,
    privateKey,
    calendarId: env.GOOGLE_CALENDAR_ID || "primary",
    spreadsheetId: env.GOOGLE_SHEETS_ID || "",
  };
}

export function googleCalendarEnabled(env: EnvMap, creds: GoogleCreds | null): boolean {
  if (!creds) return false;
  const provider = (env.CALENDAR_PROVIDER ?? "mock").toLowerCase();
  if (provider === "off" || provider === "none") return false;
  return filled(env.GOOGLE_CALENDAR_ID);
}

export function googleSheetsEnabled(env: EnvMap, creds: GoogleCreds | null): boolean {
  if (!creds || !filled(creds.spreadsheetId)) return false;
  const provider = (env.CRM_PROVIDER ?? "local").toLowerCase();
  return provider !== "off" && provider !== "none";
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

  clear(): void {
    this.token = undefined;
  }
}

async function authedFetch(auth: GoogleAccess, fetchImpl: typeof fetch, url: string, init: RequestInit, retry = true): Promise<Response> {
  const token = await auth.tokenValue();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetchImpl(url, { ...init, headers });
  if (response.status === 401 && retry) {
    auth.clear();
    return authedFetch(auth, fetchImpl, url, init, false);
  }
  return response;
}

async function googleError(response: Response, label: string, clientEmail: string): Promise<Error> {
  const detail = (await response.text()).slice(0, 180);
  return new Error(`${label} (${response.status}). Share it with ${clientEmail}. ${detail}`.trim());
}

export class GoogleCalendar implements CalendarProvider {
  readonly mode = "google" as const;
  constructor(
    private readonly creds: GoogleCreds,
    private readonly auth: GoogleAccess,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async listBusy(fromIso: string, toIso: string): Promise<Busy[]> {
    const response = await authedFetch(this.auth, this.fetchImpl, "https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeMin: fromIso, timeMax: toIso, items: [{ id: this.creds.calendarId }] }),
    });
    if (!response.ok) throw await googleError(response, "Google Calendar freeBusy failed", this.creds.clientEmail);
    const json = (await response.json()) as { calendars?: Record<string, { busy?: Busy[] }> };
    return json.calendars?.[this.creds.calendarId]?.busy ?? [];
  }

  async createEvent(event: CalendarEvent): Promise<{ eventId: string }> {
    const response = await authedFetch(
      this.auth,
      this.fetchImpl,
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.creds.calendarId)}/events`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          summary: event.summary,
          description: event.description,
          start: { dateTime: event.start, timeZone: event.timeZone },
          end: { dateTime: event.end, timeZone: event.timeZone },
        }),
      },
    );
    if (!response.ok) throw await googleError(response, "Google Calendar insert failed", this.creds.clientEmail);
    const json = (await response.json()) as { id: string };
    return { eventId: json.id };
  }

  async cancelEvent(eventId: string): Promise<void> {
    if (eventId.startsWith("evt_")) return;
    const response = await authedFetch(
      this.auth,
      this.fetchImpl,
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.creds.calendarId)}/events/${encodeURIComponent(eventId)}`,
      { method: "DELETE" },
    );
    if (!response.ok && response.status !== 404 && response.status !== 410) {
      throw await googleError(response, "Google Calendar delete failed", this.creds.clientEmail);
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
      let response = await this.append(row);
      if (!response.ok && (response.status === 400 || response.status === 404)) {
        const detail = await response.text();
        const missing = response.status === 404 || /unable to parse range|not found/i.test(detail);
        if (!missing) return { ok: false, error: `Sheets append failed (${response.status}): ${detail.slice(0, 180)}` };
        const created = await this.ensureCallsTab();
        if (!created.ok) return created;
        response = await this.append(row);
      }
      if (!response.ok) {
        const detail = await response.text();
        return { ok: false, error: `Sheets append failed (${response.status}): ${detail.slice(0, 180)}` };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Sheets append failed" };
    }
  }

  private append(row: string[]): Promise<Response> {
    const range = encodeURIComponent("Calls!A:J");
    return authedFetch(
      this.auth,
      this.fetchImpl,
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(this.spreadsheetId)}/values/${range}:append?valueInputOption=USER_ENTERED`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: [row] }),
      },
    );
  }

  private async ensureCallsTab(): Promise<{ ok: boolean; error?: string }> {
    const id = encodeURIComponent(this.spreadsheetId);
    const meta = await authedFetch(this.auth, this.fetchImpl, `https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets.properties.title`, {
      method: "GET",
    });
    if (!meta.ok) {
      const detail = await meta.text();
      return { ok: false, error: `Sheets lookup failed (${meta.status}). Share the spreadsheet with the service account. ${detail.slice(0, 160)}` };
    }
    const json = (await meta.json()) as { sheets?: Array<{ properties?: { title?: string } }> };
    const exists = json.sheets?.some((sheet) => sheet.properties?.title === "Calls");
    if (exists) return { ok: true };
    const add = await authedFetch(this.auth, this.fetchImpl, `https://sheets.googleapis.com/v4/spreadsheets/${id}:batchUpdate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: "Calls" } } }] }),
    });
    if (!add.ok) {
      const detail = await add.text();
      return { ok: false, error: `Could not add the Calls tab (${add.status}): ${detail.slice(0, 160)}` };
    }
    const header = await authedFetch(
      this.auth,
      this.fetchImpl,
      `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent("Calls!A1:J1")}?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: [CALL_SHEET_HEADERS] }),
      },
    );
    if (!header.ok) {
      const detail = await header.text();
      return { ok: false, error: `Could not write Calls headers (${header.status}): ${detail.slice(0, 160)}` };
    }
    return { ok: true };
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

export type MailMessage = { from: string; to: string; subject?: string; text: string };

export type Mailer = {
  send(input: MailMessage): Promise<void>;
};

export function gmailSmtpOptions(user: string, pass: string) {
  return {
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass: pass.replace(/\s+/g, "") },
  };
}

export function createGmailMailer(user: string, pass: string): Mailer {
  const transport = nodemailer.createTransport(gmailSmtpOptions(user, pass));
  return {
    async send(input) {
      await transport.sendMail({ from: input.from, to: input.to, subject: input.subject, text: input.text });
    },
  };
}

export class GmailEmail implements MessageProvider {
  readonly mode = "gmail";
  constructor(
    private readonly env: EnvMap,
    private readonly mailer?: Mailer,
  ) {}

  async send(input: { to: string; body: string; subject?: string }): Promise<{ status: OutboundMessage["status"]; error?: string }> {
    const user = this.env.GMAIL_USER?.trim();
    const pass = this.env.GMAIL_APP_PASSWORD;
    if (!user || !pass?.trim()) return { status: "failed", error: "Gmail is not configured" };
    try {
      const mailer = this.mailer ?? createGmailMailer(user, pass);
      await mailer.send({
        from: user,
        to: input.to,
        subject: input.subject ?? "Your appointment",
        text: input.body,
      });
      return { status: "sent" };
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : "Gmail send failed" };
    }
  }
}

export function selectEmail(env: EnvMap, fetchImpl: typeof fetch, mailer?: Mailer): MessageProvider {
  if (filled(env.GMAIL_USER) && filled(env.GMAIL_APP_PASSWORD)) return new GmailEmail(env, mailer);
  if ((env.EMAIL_PROVIDER ?? "mock") === "resend" && filled(env.RESEND_API_KEY) && filled(env.NOTIFY_FROM_EMAIL)) {
    return new ResendEmail(env, fetchImpl);
  }
  return new MockMessages("mock");
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
