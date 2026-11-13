"use client";

import { Badge } from "@/components/ui/badge";
import type { Booking, Business, CallRecord } from "@/server/types";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

type Detail = { call: CallRecord; booking: Booking | null; business: Business };

export function CallDetail({ id }: { id: string }) {
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/calls/${id}`, { cache: "no-store" })
      .then(async (response) => {
        const json = (await response.json()) as Detail & { error?: string };
        if (!response.ok) throw new Error(json.error || "That call isn't on the desk.");
        if (!cancelled) setData(json);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "That call isn't on the desk.");
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <Link href="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <ArrowLeft className="size-4" /> Back to the desk
        </Link>
        <p className="font-heading mt-6 text-3xl">{error}</p>
      </main>
    );
  }
  if (!data) return <main className="px-4 py-10 text-muted-foreground">Opening the call…</main>;

  const { call, booking, business } = data;
  const zone = business.timezone;
  return (
    <main className="mx-auto grid max-w-5xl gap-8 px-4 py-8 lg:grid-cols-[1fr_280px]">
      <div>
        <Link href="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> Back to the desk
        </Link>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <h1 className="font-heading text-4xl">{call.customer.name || "Unknown caller"}</h1>
          <Badge variant="secondary">{call.status.replace("_", " ")}</Badge>
          {call.seed ? <Badge variant="outline">Sample</Badge> : null}
        </div>
        <p className="mt-2 text-muted-foreground">{call.summary}</p>
        <ol className="mt-6 space-y-3" data-testid="call-transcript">
          {call.transcript.map((line, index) => (
            <li key={`${line.at}-${index}`} className="grid grid-cols-[88px_1fr] gap-3 text-sm">
              <span className="text-muted-foreground">{line.role === "assistant" ? business.assistant_name : "Caller"}</span>
              <span>{line.text}</span>
            </li>
          ))}
        </ol>
      </div>
      <aside className="h-fit rounded-xl border border-border bg-card p-4 text-sm">
        <p className="text-xs tracking-[0.16em] text-muted-foreground uppercase">On the ticket</p>
        <dl className="mt-3 space-y-2">
          <Row label="Phone" value={call.customer.phone || call.from || "—"} />
          <Row label="Email" value={call.customer.email || "—"} />
          <Row label="Vehicle" value={call.customer.vehicle || "—"} />
          <Row label="Channel" value={call.channel} />
          <Row label="Language" value={call.llm?.model || call.llm?.provider || "Built-in"} />
        </dl>
        {call.llm?.note ? <p className="mt-3 text-muted-foreground">{call.llm.note}</p> : null}
        {booking ? (
          <div className="mt-4 rounded-lg bg-[oklch(0.95_0.02_100)] p-3 text-[oklch(0.22_0.02_150)]">
            <p className="font-medium">{booking.serviceName}</p>
            <p>{new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(booking.start))}</p>
            <p className="mt-1 text-xs uppercase opacity-70">{booking.status}</p>
          </div>
        ) : null}
        {call.transfer ? <p className="mt-4">Transfer flagged for {call.transfer.number}.</p> : null}
      </aside>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}
