export type EnvMap = Record<string, string | undefined>;

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export type DayHours = { open: string; close: string };

export type Service = {
  id: string;
  name: string;
  duration_minutes: number;
  price: string;
  description: string;
  aliases: string[];
  deposit: boolean;
};

export type Faq = {
  id: string;
  triggers: string[];
  answer: string;
};

export type Business = {
  id: string;
  name: string;
  assistant_name: string;
  phone: string;
  transfer_number: string;
  email: string;
  timezone: string;
  address: string;
  greeting: string;
  hours_speech: string;
  menu_speech: string;
  hours: Record<Weekday, DayHours | null>;
  services: Service[];
  faqs: Faq[];
  booking: {
    slot_minutes: number;
    lead_time_hours: number;
    horizon_days: number;
    buffer_minutes: number;
  };
  policies: {
    cancellation: string;
    payment: string;
    dropoff: string;
  };
};

export type Slot = {
  start: string;
  end: string;
  timeLabel: string;
  dayLabel: string;
  speech: string;
};

export type Busy = { start: string; end: string };

export type Channel = "simulator" | "vapi" | "retell" | "twilio";

export type CallStatus = "in_progress" | "booked" | "completed" | "transferred" | "abandoned";

export type Phase = "conversation" | "booking" | "after_book" | "transferred" | "ended";

export type Pending = "service" | "name" | "phone" | "when" | "slot" | "else";

export type Customer = {
  name?: string;
  phone?: string;
  email?: string;
  vehicle?: string;
};

export type TranscriptLine = {
  role: "assistant" | "user";
  text: string;
  at: string;
};

export type LlmTrace = {
  provider: string;
  model?: string;
  fallback: boolean;
  note?: string;
};

export type CallRecord = {
  id: string;
  from?: string;
  channel: Channel;
  externalId?: string;
  startedAt: string;
  endedAt?: string;
  status: CallStatus;
  customer: Customer;
  serviceId?: string;
  pending?: Pending;
  offered: Slot[];
  selectedStart?: string;
  expectingBookYes?: boolean;
  phase: Phase;
  transcript: TranscriptLine[];
  bookingId?: string;
  transfer?: { number: string; reason: string };
  summary: string;
  seed?: boolean;
  llm?: LlmTrace;
};

export type Booking = {
  id: string;
  callId?: string;
  createdAt: string;
  start: string;
  end: string;
  serviceId: string;
  serviceName: string;
  customerName: string;
  phone: string;
  email?: string;
  vehicle?: string;
  status: "confirmed" | "cancelled";
  eventId?: string;
  calendarProvider: string;
  source: string;
  seed?: boolean;
};

export type OutboundMessage = {
  id: string;
  at: string;
  channel: "sms" | "email";
  audience: "customer" | "shop";
  to: string;
  subject?: string;
  body: string;
  status: "logged" | "sent" | "failed";
  provider: string;
  bookingId?: string;
  callId?: string;
  error?: string;
};

export type StoreData = {
  calls: CallRecord[];
  bookings: Booking[];
  messages: OutboundMessage[];
};

export type TurnAction = "continue" | "transfer" | "end" | "booked";

export type TurnResponse = {
  say: string;
  action: TurnAction;
  call: CallRecord;
  slots: Slot[];
  booking?: Booking;
};

export class DeskError extends Error {
  constructor(
    message: string,
    readonly code: "conflict" | "closed" | "config" | "not_found" | "provider",
  ) {
    super(message);
    this.name = "DeskError";
  }
}

export function nid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}
