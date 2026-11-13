"use client";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "cn";
import type { Booking, Business, CallRecord, OutboundMessage } from "@/server/types";
import { ArrowUpRight, Phone } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Provider = { name: string; mode: string; ready: boolean; detail: string };

type Overview = {
  business: Business;
  configPath: string;
  providers: Record<string, Provider>;
  calls: CallRecord[];
  bookings: Booking[];
  messages: OutboundMessage[];
  stats: { callsToday: number; upcoming: number; transfersToday: number; confirmations: number };
};

const STATUS: Record<string, string> = {
  in_progress: "On the line",
  booked: "Booked",
  completed: "Wrapped",
  transferred: "Transferred",
  abandoned: "Dropped",
};

export function DeskHome() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/overview", { cache: "no-store" });
      const json = (await response.json()) as Overview & { error?: string };
      if (!response.ok) throw new Error(json.error || "The desk couldn't load.");
      setData(json);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The desk couldn't load.");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function pull() {
      if (!cancelled) await load();
    }
    const timer = window.setInterval(() => void pull(), 3000);
    const kick = window.setTimeout(() => void pull(), 0);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.clearTimeout(kick);
    };
  }, [load]);

  async function reset() {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    await fetch("/api/demo/reset", { method: "POST" });
    setConfirmReset(false);
    await load();
  }

  if (error && !data) {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-4 px-6">
        <p className="font-heading text-3xl">The desk did not come up.</p>
        <p className="text-muted-foreground">{error}</p>
        <Button onClick={() => void load()}>Try again</Button>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6">
        <p className="text-sm tracking-[0.16em] text-muted-foreground uppercase">Front desk</p>
        <p className="font-heading mt-3 text-4xl">Pulling the book…</p>
      </main>
    );
  }

  const { business } = data;
  const zone = business.timezone;

  return (
    <div className="mx-auto grid w-full min-w-0 max-w-6xl gap-8 overflow-x-clip px-4 py-6 lg:grid-cols-[260px_minmax(0,1fr)] lg:px-8 lg:py-8">
      <aside className="flex min-w-0 flex-col gap-6 lg:sticky lg:top-8 lg:max-h-[calc(100vh-4rem)] lg:overflow-auto">
        <div>
          <p className="text-xs tracking-[0.2em] text-muted-foreground uppercase">Front desk</p>
          <h1 className="font-heading mt-2 text-4xl leading-none text-balance">{business.name}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {business.assistant_name} is on the phone · {business.address}
          </p>
        </div>
        <Link href="/simulator" className={cn(buttonVariants({ size: "lg" }), "h-11 w-full px-4")} data-testid="open-phone">
          <Phone />
          Open the phone
        </Link>
        <ul className="space-y-3 text-sm">
          {Object.values(data.providers).map((provider) => (
            <li key={provider.name} className="flex gap-3">
              <span className={`mt-1 size-2 shrink-0 rounded-full ${provider.ready ? "bg-primary" : "bg-amber-300"}`} />
              <span>
                <span className="block text-foreground">
                  {provider.name} · {provider.mode}
                </span>
                <span className="block break-words text-muted-foreground">{provider.detail}</span>
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-auto hidden text-sm text-muted-foreground lg:block">
          <p className="text-foreground">Hours</p>
          <p className="mt-1">{business.hours_speech}</p>
          <p className="mt-4 text-xs">Config · {data.configPath}</p>
        </div>
      </aside>

      <main className="flex min-w-0 flex-col gap-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs tracking-[0.18em] text-muted-foreground uppercase">Today on the desk</p>
            <h2 className="font-heading text-4xl text-balance sm:text-5xl">Who called, who is coming in.</h2>
          </div>
          <Button variant={confirmReset ? "destructive" : "outline"} onClick={() => void reset()} data-testid="reset-demo">
            {confirmReset ? "Yes, restore the sample day" : "Reset demo"}
          </Button>
        </header>

        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="stats">
          <Stat label="Calls today" value={data.stats.callsToday} />
          <Stat label="Coming up" value={data.stats.upcoming} />
          <Stat label="Transfers" value={data.stats.transfersToday} />
          <Stat label="Confirmations" value={data.stats.confirmations} />
        </section>

        <section className="grid gap-6 xl:grid-cols-[1.3fr_0.7fr]">
          <div>
            <div className="mb-3 flex items-baseline justify-between">
              <h3 className="font-heading text-2xl">Calls</h3>
              <span className="text-xs text-muted-foreground">Refreshes every few seconds</span>
            </div>
            {data.calls.length === 0 ? (
              <Empty>No calls yet. Open the phone and ask {business.assistant_name} for a full detail.</Empty>
            ) : (
              <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border" data-testid="call-list">
                {data.calls.map((call) => (
                  <li key={call.id}>
                    <Link href={`/calls/${call.id}`} className="flex min-w-0 gap-4 px-4 py-3 transition-colors hover:bg-muted/60">
                      <time className="w-16 shrink-0 pt-0.5 text-sm text-muted-foreground">
                        {stamp(call.startedAt, zone)}
                      </time>
                      <span className="min-w-0 flex-1 overflow-hidden">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{call.customer.name || call.from || "Unknown caller"}</span>
                          <Badge variant={call.status === "transferred" ? "destructive" : call.status === "booked" ? "default" : "secondary"}>
                            {STATUS[call.status] ?? call.status}
                          </Badge>
                          {call.seed ? <Badge variant="outline">Sample</Badge> : null}
                        </span>
                        <span className="mt-1 block truncate text-sm text-muted-foreground">{call.summary}</span>
                      </span>
                      <ArrowUpRight className="mt-1 size-4 shrink-0 text-muted-foreground" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h3 className="font-heading mb-3 text-2xl">On the book</h3>
            {data.bookings.length === 0 ? (
              <Empty>No upcoming appointments. A booked call lands here.</Empty>
            ) : (
              <ul className="space-y-3" data-testid="booking-list">
                {data.bookings.map((booking) => (
                  <li key={booking.id} className="rounded-xl bg-[oklch(0.95_0.02_100)] p-4 text-[oklch(0.22_0.02_150)]">
                    <p className="text-xs tracking-[0.14em] uppercase opacity-70">{dayStamp(booking.start, zone)}</p>
                    <p className="font-heading text-3xl leading-none">{timeStamp(booking.start, zone)}</p>
                    <p className="mt-2 font-medium">{booking.serviceName}</p>
                    <p className="text-sm opacity-80">
                      {booking.customerName} · {booking.phone}
                      {booking.vehicle ? ` · ${booking.vehicle}` : ""}
                    </p>
                    {booking.seed ? <p className="mt-2 text-xs opacity-60">Sample appointment</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section>
          <h3 className="font-heading mb-3 text-2xl">Confirmation outbox</h3>
          {data.messages.length === 0 ? (
            <Empty>Texts and emails show up here. In demo mode they are logged, not sent.</Empty>
          ) : (
            <ul className="grid gap-3 md:grid-cols-2" data-testid="outbox">
              {data.messages.map((message) => (
                <li key={message.id} className="rounded-xl border border-border bg-card p-4">
                  <p className="flex flex-wrap items-center gap-2 text-xs tracking-[0.14em] text-muted-foreground uppercase">
                    {message.channel} · {message.audience}
                    <Badge variant="outline">{message.status === "logged" ? "Logged, not sent" : message.status}</Badge>
                  </p>
                  <p className="mt-2 text-sm">To {message.to}</p>
                  {message.subject ? <p className="text-sm font-medium">{message.subject}</p> : null}
                  <p className="mt-2 text-sm text-muted-foreground">{message.body}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <p className="font-heading text-4xl leading-none">{value}</p>
      <p className="mt-2 text-sm text-muted-foreground">{label}</p>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-xl border border-dashed border-border px-4 py-8 text-sm text-muted-foreground">{children}</p>;
}

function stamp(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}
function timeStamp(iso: string, timeZone: string) {
  return stamp(iso, timeZone);
}
function dayStamp(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(new Date(iso));
}
