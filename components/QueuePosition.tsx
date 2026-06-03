"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { getBrowserSupabase } from "@/lib/supabase";
import type { QueueEntry, QueueStatus } from "@/lib/types";
import { DEPARTMENTS, streamFor } from "@/lib/types";
import { patientTransferAction, requestHelpAction } from "@/app/actions";

const AVG_MINUTES_PER_PATIENT = 8;
const KIOSK_TIMEOUT_SECONDS = 10;

// Sub-stage transitions that should give the patient a chime + buzz on
// their phone. No TTS on the phone -- audio announcements are reserved
// for the public display.
const NOTIFY_STATUSES: QueueStatus[] = ["called", "with_nurse", "with_doctor", "preparing"];

function playPatientChime() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
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
  } catch {
    // Audio may be blocked until the user interacts. Vibration usually
    // still works -- swallow the error and rely on the buzz.
  }
}

function buzzPhone() {
  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    navigator.vibrate([200, 100, 200, 100, 400]);
  }
}

interface Props {
  initialEntry: QueueEntry;
  initialAhead: number;
}

interface State {
  status: QueueStatus;
  ahead: number;
  visitType: string;
  ticketNumber: number | null;
  createdAt: string;
  helpRequestedAt: string | null;
}

export function QueuePosition({ initialEntry, initialAhead }: Props) {
  const router = useRouter();
  const [state, setState] = useState<State>({
    status: initialEntry.status,
    ahead: initialAhead,
    visitType: initialEntry.visit_type,
    ticketNumber: initialEntry.ticket_number,
    createdAt: initialEntry.created_at,
    helpRequestedAt:
      (initialEntry as { help_requested_at?: string | null }).help_requested_at ?? null,
  });
  const [kioskSecondsLeft, setKioskSecondsLeft] = useState<number | null>(null);
  // Track the last status we notified on so the chime + buzz fires once
  // per transition, not every render.
  const lastNotifiedStatusRef = useRef<QueueStatus | null>(
    NOTIFY_STATUSES.includes(initialEntry.status) ? initialEntry.status : null,
  );

  useEffect(() => {
    if (
      NOTIFY_STATUSES.includes(state.status) &&
      lastNotifiedStatusRef.current !== state.status
    ) {
      playPatientChime();
      buzzPhone();
    }
    lastNotifiedStatusRef.current = NOTIFY_STATUSES.includes(state.status)
      ? state.status
      : lastNotifiedStatusRef.current;
  }, [state.status]);

  const kioskTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const isKiosk =
      typeof window !== "undefined" && localStorage.getItem("kiosk") === "true";
    if (!isKiosk) return;

    setKioskSecondsLeft(KIOSK_TIMEOUT_SECONDS);
    let remaining = KIOSK_TIMEOUT_SECONDS;

    kioskTimerRef.current = setInterval(() => {
      remaining -= 1;
      setKioskSecondsLeft(remaining);
      if (remaining <= 0) {
        clearInterval(kioskTimerRef.current!);
        router.push("/");
      }
    }, 1000);

    return () => {
      if (kioskTimerRef.current) clearInterval(kioskTimerRef.current);
    };
  }, [router]);

  useEffect(() => {
    const supabase = getBrowserSupabase();

    async function refresh() {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const { data: meRow } = await supabase
        .from("queue_entries")
        .select("status, created_at, visit_type, ticket_number, help_requested_at")
        .eq("id", initialEntry.id)
        .maybeSingle();

      if (!meRow) return;

      const myStream = streamFor(meRow.visit_type as string);
      const { data: aheadRows } = await supabase
        .from("queue_entries")
        .select("id, priority, created_at, visit_type")
        .eq("status", "waiting")
        .gte("created_at", today.toISOString());

      const filteredAhead = (aheadRows ?? []).filter((r) => {
        if (streamFor((r as { visit_type: string }).visit_type) !== myStream) return false;
        if ((r as { priority?: boolean }).priority) return true;
        return (
          new Date((r as { created_at: string }).created_at).getTime() <
          new Date(meRow.created_at as string).getTime()
        );
      });

      setState({
        status: (meRow.status as QueueStatus) ?? "waiting",
        ahead: meRow.status === "waiting" ? filteredAhead.length : 0,
        visitType: meRow.visit_type as string,
        ticketNumber: (meRow.ticket_number as number | null) ?? null,
        createdAt: meRow.created_at as string,
        helpRequestedAt: (meRow.help_requested_at as string | null) ?? null,
      });
    }

    void refresh();

    const channel = supabase
      .channel(`queue:${initialEntry.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "queue_entries" },
        () => { void refresh(); },
      )
      .subscribe();

    return () => { void supabase.removeChannel(channel); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialEntry.id]);

  const kioskBanner = kioskSecondsLeft !== null && (
    <div className="mt-6 flex items-center justify-between rounded-lg bg-slate-100 px-4 py-3 text-sm text-slate-600">
      <span>Returning to check-in in {kioskSecondsLeft}s&hellip;</span>
      <button
        onClick={() => router.push("/")}
        className="ml-4 rounded-md bg-brand px-3 py-1.5 text-sm font-semibold text-white"
      >
        Check in another patient
      </button>
    </div>
  );

  const inProgress =
    state.status === "called" ||
    state.status === "at_records" ||
    state.status === "with_nurse" ||
    state.status === "with_doctor" ||
    state.status === "preparing";

  const helpRequested = Boolean(state.helpRequestedAt);

  if (inProgress) {
    const myStream = streamFor(state.visitType);
    // Headline + body copy adapt to the current sub-stage so the patient
    // always knows where to go (or where they are).
    let headline: string;
    let bodyLine: string;
    // Help-requested fast-track: patient pressed Request Help and was
    // auto-escalated to with_nurse. They stay seated -- a nurse comes
    // to them. Override the normal "Please go to the Nurse" copy so
    // they don't get up.
    if (helpRequested && state.status === "with_nurse") {
      headline = "A nurse is on the way to you";
      bodyLine = "Please stay seated. A nurse will come to check on you.";
    } else if (myStream === "pharmacy") {
      if (state.status === "preparing") {
        headline = "Pharmacist is preparing your order";
        bodyLine = "Please wait near the pharmacy window";
      } else {
        headline = "You're being called";
        bodyLine = "Please go to the pharmacy window";
      }
    } else {
      switch (state.status) {
        case "called":
          headline = "You're being called";
          bodyLine = "Please go to the Records desk";
          break;
        case "at_records":
          headline = "You're at the Records desk";
          bodyLine = "Wait here until you are called by the Nurse";
          break;
        case "with_nurse":
          headline = "Please go to the Nurse";
          bodyLine = "After the Nurse, you'll wait to see the Doctor";
          break;
        case "with_doctor":
          headline = "Please go to the Doctor";
          bodyLine = "";
          break;
        default:
          headline = "You're being called";
          bodyLine = "Please go to the Records desk";
      }
    }
    return (
      <>
        <section className="rounded-xl bg-amber-100 p-8 text-center ring-4 ring-amber-400">
          <p className="text-sm font-semibold uppercase tracking-wide text-amber-700">
            {headline}
          </p>
          {state.ticketNumber !== null && (
            <p className="mt-2 text-5xl font-black text-amber-900">
              #{state.ticketNumber}
            </p>
          )}
          {bodyLine && (
            <h2 className="mt-3 text-2xl font-bold text-amber-900">{bodyLine}</h2>
          )}
        </section>
        <RequestHelpButton token={initialEntry.token} alreadyRequested={helpRequested} />
        {kioskBanner}
      </>
    );
  }

  if (state.status === "seen") {
    return (
      <>
        <section className="rounded-xl bg-brand-light p-8 text-center">
          <h2 className="text-2xl font-bold text-brand-dark">You have been seen</h2>
          <p className="mt-3 text-slate-700">Thank you for visiting St Thomas OPC.</p>
        </section>
        {kioskBanner}
      </>
    );
  }

  const position = state.ahead + 1;
  const wait = state.ahead * AVG_MINUTES_PER_PATIENT;
  // BB5: surface the most-recent transfer prominently so the patient
  // gets clear feedback that their move went through. The entry's
  // transferred_from is set by transferEntry on every move.
  const transferredFromLabel = friendlyVisitTypeLabel(initialEntry.transferred_from);
  const currentDestinationLabel = friendlyVisitTypeLabel(state.visitType);

  return (
    <>
      {transferredFromLabel && (
        <section className="rounded-xl border-2 border-emerald-300 bg-emerald-50 p-5 text-center">
          <p className="text-sm font-semibold uppercase tracking-wider text-emerald-700">
            You&apos;ve been moved
          </p>
          <p className="mt-1 text-lg font-semibold text-emerald-900">
            From {transferredFromLabel} → {currentDestinationLabel}
          </p>
          {state.ticketNumber !== null && (
            <p className="mt-1 text-sm text-emerald-800">
              Your new ticket is <span className="font-mono font-bold">#{state.ticketNumber}</span>.
            </p>
          )}
        </section>
      )}
      {/* EE3: ticket is the primary identity (matches what the
          display calls out). Position is a smaller supporting line so
          patients aren't confused by two big numbers. */}
      <section className="rounded-xl bg-brand-light p-8 text-center">
        {state.ticketNumber !== null && (
          <>
            <p className="text-sm font-semibold uppercase tracking-wide text-brand">
              Your ticket
            </p>
            <p className="mt-1 text-7xl font-black text-brand-dark">
              #{state.ticketNumber}
            </p>
          </>
        )}
        <p className="mt-5 text-slate-700">
          {state.ahead === 0
            ? <>You&apos;re next in line.</>
            : <>
                You&apos;re position <strong>{position}</strong> — {state.ahead} {state.ahead === 1 ? "person" : "people"} ahead of you.
              </>}
        </p>
        {state.ahead > 0 && (
          <p className="mt-1 text-sm text-slate-500">
            Rough wait: about {wait} minute{wait === 1 ? "" : "s"}
          </p>
        )}
      </section>
      {/* EE13: reference token gets its own card so it's impossible
          to miss. This is the patient's recovery key if they lose
          the page. */}
      <section className="mt-6 rounded-xl border border-slate-300 bg-white p-5 text-center">
        <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Your reference code
        </p>
        <p className="mt-1 font-mono text-3xl font-bold tracking-widest text-slate-800">
          {initialEntry.token}
        </p>
        <p className="mt-2 text-sm text-slate-600">
          Write this down. You can use it to find your place again from any phone.
        </p>
      </section>
      <TransferForm token={initialEntry.token} currentVisitType={state.visitType} />
      <RequestHelpButton token={initialEntry.token} alreadyRequested={helpRequested} />
      <NewCheckInLink />
      {kioskBanner}
    </>
  );
}

// BB6 + EE7: visible "New check-in" link for shared kiosks. Confirms
// before navigating away so a personal-phone user doesn't lose their
// queue position view by accident.
function NewCheckInLink() {
  function onClick(e: React.MouseEvent) {
    if (
      !window.confirm(
        "Start a new check-in? Your current queue position will still be saved — you can come back using your reference code.",
      )
    ) {
      e.preventDefault();
    }
  }
  return (
    <div className="mt-6 text-center">
      <a
        href="/"
        onClick={onClick}
        className="inline-block rounded-md border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
      >
        Check in another patient →
      </a>
    </div>
  );
}

// Friendly label for the visit_type column. Stored values are
// lowercase ("general", "follow-up", "pharmacy", "other"); we want
// title case in patient-facing UI.
function friendlyVisitTypeLabel(visitType: string | null | undefined): string | null {
  if (!visitType) return null;
  switch (visitType) {
    case "general": return "General Clinic";
    case "follow-up": return "Follow-up";
    case "pharmacy": return "Pharmacy";
    case "other": return "Other";
    default: return visitType;
  }
}

// Patient-facing emergency button. Confirm once (rules out fat-finger
// taps in a noisy waiting room), then flips priority + stamps
// help_requested_at via the server action. On success we show an
// acknowledgement and disable the button.
function RequestHelpButton({
  token,
  alreadyRequested,
}: {
  token: string;
  alreadyRequested: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [requested, setRequested] = useState(alreadyRequested);
  const [error, setError] = useState<string | null>(null);

  function onClick() {
    if (
      !window.confirm(
        "Are you feeling worse? Pressing this will alert clinic staff right away.",
      )
    ) {
      return;
    }
    setError(null);
    const fd = new FormData();
    fd.set("token", token);
    startTransition(async () => {
      try {
        await requestHelpAction(fd);
        setRequested(true);
      } catch {
        setError("Could not send. Please try again, or ask the staff in person.");
      }
    });
  }

  if (requested) {
    return (
      <section className="mt-6 rounded-xl border-2 border-red-300 bg-red-50 p-5 text-center">
        <p className="text-sm font-semibold uppercase tracking-wide text-red-700">
          Help requested
        </p>
        <p className="mt-1 text-red-900">
          Staff have been alerted. A nurse will come to you as soon as possible.
        </p>
      </section>
    );
  }

  return (
    <section className="mt-6 rounded-xl border-2 border-red-200 bg-white p-5 text-center">
      <p className="text-sm font-semibold text-slate-700">Feeling worse while you wait?</p>
      <p className="mt-1 text-sm text-slate-500">
        Press the button below and a nurse will be alerted right away.
      </p>
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="mt-4 w-full rounded-xl bg-red-600 px-6 py-4 text-lg font-bold uppercase tracking-wider text-white shadow-lg hover:bg-red-700 disabled:opacity-50"
      >
        🆘 Request help
      </button>
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
    </section>
  );
}

function TransferForm({ token, currentVisitType }: { token: string; currentVisitType: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const currentStream = streamFor(currentVisitType);
  // Offer the two departments the patient is not already in.
  const others = DEPARTMENTS.filter((d) => d.stream !== currentStream);

  function onTransfer(visitType: string, hasPrescription?: string) {
    // EE7: confirm before moving. Patients on shared kiosks tap by
    // accident; a confirm step costs nothing and avoids losing their
    // place in the original queue.
    const destLabel =
      visitType === "pharmacy"
        ? "Pharmacy"
        : visitType === "general" || visitType === "follow-up"
        ? "General Clinic"
        : "the new department";
    if (
      !window.confirm(
        `Move to ${destLabel}? You'll get a new ticket and be placed at the back of that queue.`,
      )
    ) {
      return;
    }
    setError(null);
    const fd = new FormData();
    fd.set("token", token);
    fd.set("visit_type", visitType);
    if (hasPrescription) fd.set("has_prescription", hasPrescription);
    startTransition(async () => {
      try {
        await patientTransferAction(fd);
      } catch (err) {
        if (
          err &&
          typeof err === "object" &&
          "digest" in err &&
          typeof (err as { digest?: unknown }).digest === "string" &&
          (err as { digest: string }).digest.startsWith("NEXT_REDIRECT")
        ) {
          throw err;
        }
        setError("Transfer failed. Please try again.");
      }
    });
  }

  return (
    <div className="mt-6 rounded-xl border border-slate-200 p-5">
      <p className="text-sm font-semibold text-slate-700">Need to visit another department?</p>
      <p className="mt-1 text-sm text-slate-500">
        You&apos;ll be placed at the end of the new queue.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {others.map((dept) => (
          <button
            key={dept.stream}
            type="button"
            disabled={pending}
            onClick={() => {
              if (dept.askPrescription) {
                setPicking("pharmacy");
              } else {
                onTransfer(dept.defaultVisitType);
              }
            }}
            className="rounded-lg border border-brand px-4 py-2 text-sm font-semibold text-brand hover:bg-brand-light disabled:opacity-50"
          >
            Move to {dept.label}
          </button>
        ))}
      </div>

      {picking === "pharmacy" && (
        <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3">
          <p className="text-sm font-medium text-slate-700">Do you have a prescription?</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() => onTransfer("pharmacy", "yes")}
              className="rounded-md bg-brand px-3 py-1.5 text-sm font-semibold text-white"
            >
              Paper in hand
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => onTransfer("pharmacy", "electronic")}
              className="rounded-md bg-brand px-3 py-1.5 text-sm font-semibold text-white"
            >
              Electronic on file
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => onTransfer("pharmacy", "no")}
              className="rounded-md bg-brand px-3 py-1.5 text-sm font-semibold text-white"
            >
              No prescription
            </button>
            <button
              type="button"
              onClick={() => setPicking(null)}
              className="rounded-md bg-slate-200 px-3 py-1.5 text-sm font-semibold text-slate-700"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
