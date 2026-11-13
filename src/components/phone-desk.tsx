"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Business, CallRecord, Slot, TurnAction } from "@/server/types";
import { ArrowLeft, Mic, Square } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type Turn = { say: string; action: TurnAction; call: CallRecord; slots: Slot[] };

type SpeechResult = { results: ArrayLike<ArrayLike<{ transcript: string }>> };
type SpeechRec = {
  lang: string;
  onresult: ((event: SpeechResult) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

const PROMPTS = ["How much is a ceramic coating?", "Are you open Saturday?", "I need to talk to a manager."];

export function PhoneDesk() {
  const [shop, setShop] = useState<Business | null>(null);
  const [llm, setLlm] = useState("");
  const [call, setCall] = useState<CallRecord | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  const [slots, setSlots] = useState<Slot[]>([]);
  const [micNote, setMicNote] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const recRef = useRef<SpeechRec | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      const overview = await fetch("/api/overview", { cache: "no-store" }).then((response) => response.json());
      if (cancelled) return;
      setShop(overview.business);
      setLlm(overview.providers?.llm?.detail ?? "");
      const started = await fetch("/api/calls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "simulator" }),
      }).then((response) => response.json());
      if (cancelled) return;
      if (started.call) {
        setCall(started.call);
        speak(started.call.transcript?.[0]?.text ?? "");
      } else setError(started.error || "The phone didn't connect.");
    }
    void boot();
    return () => {
      cancelled = true;
      window.speechSynthesis?.cancel();
      recRef.current?.stop();
    };
  }, []);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [call?.transcript.length]);

  async function send(text: string) {
    const line = text.trim();
    if (!line || !call || busy) return;
    setBusy(true);
    setError("");
    setDraft("");
    window.speechSynthesis?.cancel();
    try {
      const response = await fetch(`/api/calls/${call.id}/turns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: line }),
      });
      const turn = (await response.json()) as Turn & { error?: string };
      if (!response.ok) throw new Error(turn.error || "Maya dropped for a second.");
      setCall(turn.call);
      setSlots(turn.slots ?? []);
      speak(turn.say);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Maya dropped for a second. Try that again.");
    } finally {
      setBusy(false);
    }
  }

  function listen() {
    const host = window as unknown as {
      SpeechRecognition?: new () => SpeechRec;
      webkitSpeechRecognition?: new () => SpeechRec;
    };
    const Ctor = host.SpeechRecognition || host.webkitSpeechRecognition;
    if (!Ctor) {
      setMicNote("This browser doesn't capture speech. Type what the caller says.");
      return;
    }
    if (listening) {
      recRef.current?.stop();
      setListening(false);
      return;
    }
    window.speechSynthesis?.cancel();
    const rec = new Ctor();
    rec.lang = "en-US";
    rec.onresult = (event) => {
      const said = event.results[0]?.[0]?.transcript ?? "";
      if (said) void send(said);
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    recRef.current = rec;
    rec.start();
    setListening(true);
  }

  async function playSample() {
    if (!call || playing) return;
    setPlaying(true);
    const script = [
      "How much is a full detail?",
      "Please book a full detail next Tuesday morning. My name is Alex Rivera and my number is 512-555-0148.",
    ];
    let index = 0;
    let picked = false;
    let action: TurnAction = "continue";
    let offered: Slot[] = [];
    for (let step = 0; step < 6 && action !== "end" && action !== "transfer"; step += 1) {
      let line = "";
      if (offered.length && !picked && action !== "booked") {
        picked = true;
        line = "I'll take the first one.";
      } else if (action === "booked") line = "That's everything, thanks.";
      else if (index < script.length) line = script[index++];
      else break;
      setBusy(true);
      const response = await fetch(`/api/calls/${call.id}/turns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: line }),
      });
      const turn = (await response.json()) as Turn & { error?: string };
      setBusy(false);
      if (!response.ok) {
        setError(turn.error || "The sample call stopped.");
        break;
      }
      setCall(turn.call);
      setSlots(turn.slots ?? []);
      offered = turn.action === "booked" ? [] : (turn.slots ?? []);
      action = turn.action;
      speak(turn.say);
      if (line.startsWith("That's everything")) break;
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    setPlaying(false);
  }

  async function hangUp() {
    if (!call) return;
    window.speechSynthesis?.cancel();
    const response = await fetch(`/api/calls/${call.id}/end`, { method: "POST" });
    const json = (await response.json()) as { call?: CallRecord };
    if (json.call) setCall(json.call);
  }

  const assistant = shop?.assistant_name ?? "Maya";

  return (
    <div className="mx-auto grid w-full min-w-0 max-w-6xl gap-8 px-4 py-6 lg:grid-cols-[280px_minmax(0,1fr)] lg:px-8">
      <aside className="flex flex-col gap-5">
        <Link href="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> Back to the desk
        </Link>
        <div>
          <p className="text-xs tracking-[0.2em] text-muted-foreground uppercase">Bay phone</p>
          <h1 className="font-heading mt-2 text-4xl leading-none">{shop?.name ?? "Front desk"}</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            You are the caller. {assistant} answers from {shop ? "the shop config" : "the book"}. Speak, type, or play the sample call.
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">{llm || "Checking which voice is on duty."}</div>
        <div className="flex flex-col gap-2">
          {PROMPTS.map((prompt) => (
            <button
              key={prompt}
              type="button"
              className="rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-muted"
              onClick={() => setDraft(prompt)}
            >
              {prompt}
            </button>
          ))}
        </div>
      </aside>

      <section className="mx-auto flex w-full max-w-xl flex-col" data-testid="phone">
        <div className="flex items-center justify-between rounded-t-3xl border border-b-0 border-border bg-card px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="lamp size-2.5 rounded-full bg-primary" />
            <div>
              <p className="text-sm font-medium">{assistant}</p>
              <p className="text-xs text-muted-foreground">{call?.phase === "ended" ? "Call ended" : busy ? "Thinking" : listening ? "Listening" : "On the line"}</p>
            </div>
          </div>
          {call?.status === "transferred" ? <Badge variant="destructive">Transferring</Badge> : null}
          {call?.status === "booked" ? <Badge>Booked</Badge> : null}
        </div>
        <div ref={scroller} className="flex h-[28rem] flex-col gap-3 overflow-y-auto border border-border bg-[oklch(0.14_0.012_155)] px-4 py-4" data-testid="transcript" aria-live="polite">
          {call?.transcript.map((line, index) => (
            <p key={`${line.at}-${index}`} className={line.role === "assistant" ? "max-w-[90%] rounded-2xl rounded-bl-md bg-card px-3 py-2 text-sm" : "max-w-[90%] self-end rounded-2xl rounded-br-md bg-primary px-3 py-2 text-sm text-primary-foreground"}>
              {line.text}
            </p>
          ))}
          {!call && !error ? <p className="text-sm text-muted-foreground">Connecting the line…</p> : null}
        </div>
        {call?.transfer ? (
          <p className="border-x border-border bg-amber-200/15 px-4 py-3 text-sm" data-testid="transfer-banner">
            Live mode would dial {call.transfer.number}. This demo flags the transfer on the desk instead.
          </p>
        ) : null}
        {slots.length > 0 && call?.phase !== "ended" ? (
          <div className="flex flex-wrap gap-2 border-x border-border bg-card px-4 py-3">
            {slots.map((slot) => (
              <Button key={slot.start} variant="outline" size="sm" disabled={busy} onClick={() => void send(`I'll take ${slot.timeLabel}.`)}>
                {slot.timeLabel}
              </Button>
            ))}
          </div>
        ) : null}
        <form
          className="flex flex-col gap-3 rounded-b-3xl border border-t-0 border-border bg-card p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void send(draft);
          }}
        >
          <label className="text-xs text-muted-foreground" htmlFor="caller">
            What the caller says
          </label>
          <Textarea
            id="caller"
            value={draft}
            placeholder={`Ask ${assistant} about a price, a day, or a person.`}
            onChange={(event) => setDraft(event.target.value)}
            disabled={busy || call?.phase === "ended"}
            data-testid="caller-input"
          />
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {micNote ? <p className="text-sm text-muted-foreground">{micNote}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || !draft.trim() || call?.phase === "ended"} data-testid="send-turn">
              Send
            </Button>
            <Button type="button" variant={listening ? "secondary" : "outline"} onClick={listen} aria-pressed={listening} disabled={call?.phase === "ended"}>
              <Mic /> {listening ? "Stop mic" : "Speak"}
            </Button>
            <Button type="button" variant="outline" onClick={() => void playSample()} disabled={playing || busy || call?.phase === "ended"} data-testid="sample-call">
              {playing ? "Playing…" : "Play sample call"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => void hangUp()} disabled={!call || call.phase === "ended"}>
              <Square /> End call
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}

function speak(text: string) {
  if (!text || typeof window === "undefined" || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 1.02;
  const voice =
    window.speechSynthesis.getVoices().find((item) => /en-US/i.test(item.lang) && /female|samantha|google us/i.test(item.name)) ??
    window.speechSynthesis.getVoices().find((item) => /^en/i.test(item.lang));
  if (voice) utter.voice = voice;
  window.speechSynthesis.speak(utter);
}
