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

const VOICE_STORAGE_KEY = "stq-display-voice";

function pickFemaleVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  return (
    voices.find((v) =>
      /female|zira|samantha|google uk english female/i.test(v.name),
    ) ?? null
  );
}

// Pick the announcement voice: prefer the staff's saved choice; fall
// back to a female voice; fall back to the first available voice so the
// announcement still plays even if nothing matches.
function pickAnnouncementVoice(): SpeechSynthesisVoice | null {
  if (!("speechSynthesis" in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  let preferred: SpeechSynthesisVoice | null = null;
  try {
    const savedUri = localStorage.getItem(VOICE_STORAGE_KEY);
    if (savedUri) preferred = voices.find((v) => v.voiceURI === savedUri) ?? null;
  } catch { /* ignore */ }
  return preferred ?? pickFemaleVoice(voices) ?? voices[0] ?? null;
}

function announcePatient(entry: QueueEntry) {
  const voice = pickAnnouncementVoice();
  if (!voice) return;
  const stream = streamFor(entry.visit_type);
  // Destination phrase depends on the current sub-stage. The initial
  // call sends the patient to Records (clinic) or the pharmacy window;
  // sub-stage transitions announce the next station.
  let where: string;
  if (stream === "pharmacy") {
    where = "the pharmacy window";
  } else if (entry.status === "with_nurse") {
    where = "the Nurse";
  } else if (entry.status === "with_doctor") {
    where = "the Doctor";
  } else {
    where = "the Records desk";
  }
  const ticket = entry.ticket_number ?? 0;
  const msg = new SpeechSynthesisUtterance(
    `Number ${ticket}, ${maskedDisplayName(entry.name)}. Please go to ${where}.`,
  );
  msg.voice = voice;
  window.speechSynthesis.speak(msg);
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

// Statuses that trigger an audio announcement on the public display.
// Each transition fires once (tracked by (id, status) pair).
const DISPLAY_ANNOUNCEABLE_STATUSES: QueueEntry["status"][] = [
  "called",
  "with_nurse",
  "with_doctor",
];

// Statuses that appear in the public "Now calling" banner. Clinic
// patients return to the waiting room between sub-stages, so the board
// must show them when they're being called to the next station.
//   called      = called to Records
//   with_nurse  = called to the Nurse (from the waiting room)
//   with_doctor = called to the Doctor (from the waiting room)
//   preparing   = pharmacy intermediate
// at_records is omitted -- once a patient has reached Records they're
// being attended and don't need to be on the banner.
const BANNER_STATUSES: QueueEntry["status"][] = [
  "called",
  "with_nurse",
  "with_doctor",
  "preparing",
];

// Top 3 currently in-progress, freshest first. Priority entries are
// hidden from the public display per spec.
function topCalled(entries: QueueEntry[]): QueueEntry[] {
  return entries
    .filter((e) => BANNER_STATUSES.includes(e.status) && !e.priority)
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

  // Track which (id, status) pairs we've already announced so a patient
  // gets one audio cue per sub-stage transition, not on every refresh.
  // Seeded from initial entries so we don't replay everything on mount.
  const announcedKeysRef = useRef<Set<string>>(
    new Set(
      initialEntries
        .filter((e) => DISPLAY_ANNOUNCEABLE_STATUSES.includes(e.status))
        .map((e) => `${e.id}:${e.status}`),
    ),
  );

  // Voice picker state. Voices populate after the first user
  // interaction on some browsers, so we listen for voiceschanged too.
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceUri, setVoiceUri] = useState<string>("");

  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    function refreshVoices() {
      setVoices(window.speechSynthesis.getVoices());
    }
    refreshVoices();
    window.speechSynthesis.addEventListener("voiceschanged", refreshVoices);
    try {
      const saved = localStorage.getItem(VOICE_STORAGE_KEY);
      if (saved) setVoiceUri(saved);
    } catch { /* ignore */ }
    return () => {
      window.speechSynthesis.removeEventListener("voiceschanged", refreshVoices);
    };
  }, []);

  function onSelectVoice(uri: string) {
    setVoiceUri(uri);
    try {
      if (uri) localStorage.setItem(VOICE_STORAGE_KEY, uri);
      else localStorage.removeItem(VOICE_STORAGE_KEY);
    } catch { /* ignore */ }
    // Speak a short preview with the new voice so staff can compare.
    if (uri && "speechSynthesis" in window && audioCtxRef.current) {
      const v = voices.find((x) => x.voiceURI === uri);
      if (v) {
        const msg = new SpeechSynthesisUtterance("Voice set.");
        msg.voice = v;
        window.speechSynthesis.speak(msg);
      }
    }
  }

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

      // Announce on any new (id, status) pair for an announceable status.
      // This covers the initial call AND each sub-stage transition
      // (with_nurse, with_doctor).
      const newAnnouncements = fresh.filter((e) => {
        if (!DISPLAY_ANNOUNCEABLE_STATUSES.includes(e.status)) return false;
        return !announcedKeysRef.current.has(`${e.id}:${e.status}`);
      });

      if (newAnnouncements.length > 0 && audioCtxRef.current) {
        playChime(audioCtxRef.current);
        // Call the name twice with a gap, so a patient who missed the
        // first announcement still hears the second.
        setTimeout(() => newAnnouncements.forEach((e) => announcePatient(e)), 1100);
        setTimeout(() => newAnnouncements.forEach((e) => announcePatient(e)), 5500);
      }

      // Update both refs.
      visibleCalledIdsRef.current = new Set(visible.map((e) => e.id));
      for (const e of fresh) {
        if (DISPLAY_ANNOUNCEABLE_STATUSES.includes(e.status)) {
          announcedKeysRef.current.add(`${e.id}:${e.status}`);
        }
      }
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
    const streams: Stream[] = ["clinical", "pharmacy"];
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
          {voices.length > 0 && (
            <div className="mt-3">
              <label className="block text-[10px] uppercase tracking-widest text-slate-500">
                Announcement voice
              </label>
              <select
                value={voiceUri}
                onChange={(e) => onSelectVoice(e.target.value)}
                className="mt-1 max-w-xs rounded bg-slate-800 px-2 py-1 text-xs text-slate-200"
              >
                <option value="">Auto (female if available)</option>
                {voices.map((v) => (
                  <option key={v.voiceURI} value={v.voiceURI}>
                    {v.name} ({v.lang})
                  </option>
                ))}
              </select>
            </div>
          )}
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
                    : e.status === "with_nurse"
                    ? "Please go to the Nurse"
                    : e.status === "with_doctor"
                    ? "Please go to the Doctor"
                    : "Please go to the Records desk"}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 px-10 py-8 lg:grid-cols-2">
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
