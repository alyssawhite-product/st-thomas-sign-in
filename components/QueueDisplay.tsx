"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getBrowserSupabase } from "@/lib/supabase";
import type { QueueEntry, Stream } from "@/lib/types";
import { STREAM_LABELS, streamFor } from "@/lib/types";
import { maskedDisplayName } from "@/lib/queue-client";
import { PoweredBy } from "@/components/PoweredBy";

interface Props {
  initialEntries: QueueEntry[];
}

function playChime(ctx: AudioContext) {
  const notes = [523.25, 659.25, 783.99]; // C5 E5 G5
  notes.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.value = freq;
    const start = ctx.currentTime + i * 0.18;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.35, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.6);
    osc.start(start);
    osc.stop(start + 0.65);
  });
}

function getFemaleVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  return (
    voices.find((v) =>
      /female|zira|samantha|google uk english female/i.test(v.name),
    ) ?? null
  );
}

function announcePatient(entry: QueueEntry) {
  const voice = getFemaleVoice();
  if (!voice) return;
  const stream = streamFor(entry.visit_type);
  const where =
    stream === "pharmacy" ? "the pharmacy window" :
    stream === "records" ? "Records" :
    "the General Clinic";
  const ticket = entry.ticket_number ?? 0;
  const msg = new SpeechSynthesisUtterance(
    `Number ${ticket}, ${maskedDisplayName(entry.name)}. Please go to ${where}.`,
  );
  msg.voice = voice;
  window.speechSynthesis.speak(msg);
}

function waitMinutes(iso: string, now: number): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000));
}

function formatDate(now: number): string {
  return new Date(now).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function formatClock(now: number): string {
  return new Date(now).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

// Top 3 currently called or preparing, freshest first. Priority entries are
// hidden from the public display per spec.
function topCalled(entries: QueueEntry[]): QueueEntry[] {
  return entries
    .filter((e) => (e.status === "called" || e.status === "preparing") && !e.priority)
    .sort(
      (a, b) =>
        new Date(b.called_at ?? 0).getTime() -
        new Date(a.called_at ?? 0).getTime(),
    )
    .slice(0, 3);
}

export function QueueDisplay({ initialEntries }: Props) {
  const [entries, setEntries] = useState<QueueEntry[]>(initialEntries);
  const [now, setNow] = useState<number>(() => Date.now());
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const audioCtxRef = useRef<AudioContext | null>(null);

  const visibleCalledIdsRef = useRef<Set<string>>(
    new Set(topCalled(initialEntries).map((e) => e.id)),
  );

  function unlockAudio() {
    const ctx = new AudioContext();
    audioCtxRef.current = ctx;
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start();
    window.speechSynthesis.getVoices();
    setAudioUnlocked(true);
  }

  useEffect(() => {
    // 1s tick drives the wall-clock display in the header.
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const supabase = getBrowserSupabase();

    async function refresh() {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const { data } = await supabase
        .from("queue_entries")
        .select("*")
        .gte("created_at", today.toISOString())
        .order("priority", { ascending: false })
        .order("created_at", { ascending: true });
      const fresh = (data ?? []) as QueueEntry[];

      const visible = topCalled(fresh);
      const newlyVisible = visible.filter(
        (e) => !visibleCalledIdsRef.current.has(e.id),
      );

      if (newlyVisible.length > 0 && audioCtxRef.current) {
        playChime(audioCtxRef.current);
        // Call the name twice with a gap, so a patient who missed the
        // first announcement still hears the second.
        setTimeout(() => newlyVisible.forEach((e) => announcePatient(e)), 1100);
        setTimeout(() => newlyVisible.forEach((e) => announcePatient(e)), 5500);
      }

      visibleCalledIdsRef.current = new Set(visible.map((e) => e.id));
      setEntries(fresh);
    }

    const channel = supabase
      .channel("queue:display")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "queue_entries" },
        () => { void refresh(); },
      )
      .subscribe();

    const poll = setInterval(() => void refresh(), 2_000);

    return () => {
      void supabase.removeChannel(channel);
      clearInterval(poll);
    };
  }, []);

  const { calledNow, columns } = useMemo(() => {
    // Public display hides priority entries entirely and never reveals full
    // names. Waiting entries show only the ticket number.
    const waiting = entries
      .filter((e) => e.status === "waiting" && !e.priority)
      .sort(
        (a, b) =>
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      );
    const streams: Stream[] = ["records", "clinical", "pharmacy"];
    return {
      calledNow: topCalled(entries),
      columns: streams.map((s) => ({
        stream: s,
        label: STREAM_LABELS[s],
        patients: waiting.filter((e) => streamFor(e.visit_type) === s),
      })),
    };
  }, [entries]);

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      {!audioUnlocked && (
        <button
          onClick={unlockAudio}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-slate-950/90 text-white"
        >
          <span className="text-5xl">🔔</span>
          <span className="text-2xl font-semibold">Tap to enable sound</span>
          <span className="text-slate-400">Required for patient call alerts</span>
        </button>
      )}

      <header className="flex items-end justify-between gap-6 border-b border-slate-800 px-10 py-6">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-brand">
            St Thomas OPC
          </p>
          <h1 className="mt-1 text-4xl font-bold">Patient Queue</h1>
        </div>
        <div className="text-right">
          <p className="text-sm uppercase tracking-widest text-slate-400" suppressHydrationWarning>
            {formatDate(now)}
          </p>
          <p className="mt-1 font-mono text-4xl font-bold tabular-nums" suppressHydrationWarning>
            {formatClock(now)}
          </p>
        </div>
      </header>

      {calledNow.length > 0 && (
        <div className="mx-10 mt-8 flex flex-wrap gap-4">
          {calledNow.map((e) => {
            const stream = streamFor(e.visit_type);
            return (
              <div
                key={e.id}
                className="flex-1 min-w-56 rounded-lg bg-amber-400 px-6 py-5 text-slate-950"
              >
                <p className="text-sm font-bold uppercase tracking-widest">
                  Now calling — {STREAM_LABELS[stream]}
                </p>
                <div className="mt-1 text-6xl font-black">#{e.ticket_number ?? "—"}</div>
                <div className="mt-1 text-2xl font-bold">{maskedDisplayName(e.name)}</div>
                <div className="mt-0.5 text-sm">
                  {stream === "pharmacy"
                    ? "Please go to the pharmacy window"
                    : stream === "records"
                    ? "Please go to Records"
                    : "Please go to the General Clinic"}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 px-10 py-8 lg:grid-cols-3">
        {columns.map((col) => (
          <section key={col.stream}>
            <h2 className="mb-3 rounded-md bg-slate-800 px-4 py-2 text-center text-2xl font-semibold tracking-wide text-slate-100">
              {col.label}
              <span className="ml-2 text-base font-normal text-slate-400">
                ({col.patients.length})
              </span>
            </h2>
            {col.patients.length === 0 ? (
              <p className="rounded-lg bg-slate-900 px-4 py-6 text-center text-slate-600">
                No patients
              </p>
            ) : (
              <ol className="space-y-2">
                {col.patients.map((e) => (
                  <li
                    key={e.id}
                    className="flex items-center gap-4 rounded-lg bg-slate-900 px-4 py-3"
                  >
                    <span className="text-3xl font-black text-brand">
                      #{e.ticket_number ?? "—"}
                    </span>
                    <span className="text-xs text-slate-500">
                      {waitMinutes(e.created_at, now)} min waiting
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        ))}
      </div>

      <footer className="px-10 py-6">
        <PoweredBy variant="dark" />
      </footer>
    </div>
  );
}
