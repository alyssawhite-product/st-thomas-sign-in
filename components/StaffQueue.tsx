"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { getBrowserSupabase } from "@/lib/supabase";
import type { QueueEntry, StaffRole } from "@/lib/types";
import { DEPARTMENTS, STREAM_LABELS, VISIT_TYPES, streamFor } from "@/lib/types";
import { PoweredBy } from "@/components/PoweredBy";
import {
  callPatientAction,
  markSeenAction,
  priorityInsertAction,
  resetDayAction,
  setAtRecordsAction,
  setUrgentAction,
  setWithDoctorAction,
  setWithNurseAction,
  staffLogoutAction,
  staffTransferAction,
} from "@/app/actions";

interface Props {
  initialEntries: QueueEntry[];
  role: StaffRole;
  email: string;
}

type Tab = "waiting" | "called" | "seen";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function statusBadge(status: QueueEntry["status"]) {
  switch (status) {
    case "waiting": return "bg-slate-100 text-slate-700";
    case "called": return "bg-amber-100 text-amber-800";
    case "at_records": return "bg-amber-100 text-amber-800";
    case "with_nurse": return "bg-blue-100 text-blue-800";
    case "with_doctor": return "bg-indigo-100 text-indigo-800";
    case "preparing": return "bg-blue-100 text-blue-800";
    case "seen": return "bg-emerald-100 text-emerald-800";
  }
}

// Friendly label for the visit_type column so "other" doesn't appear
// in lowercase on a clinician's screen.
function visitTypeLabel(visitType: string): string {
  switch (visitType) {
    case "general": return "General consultation";
    case "follow-up": return "Follow-up";
    case "pharmacy": return "Pharmacy";
    case "other": return "Other";
    default: return visitType;
  }
}

// Human-readable sub-stage label for the row badge.
function statusLabel(status: QueueEntry["status"]): string {
  switch (status) {
    case "at_records": return "at records";
    case "with_nurse": return "with nurse";
    case "with_doctor": return "with doctor";
    default: return status;
  }
}

// All in-progress clinic statuses (called + the three sub-stages).
const CLINIC_IN_PROGRESS: QueueEntry["status"][] = [
  "called",
  "at_records",
  "with_nurse",
  "with_doctor",
];


function sortQueueOrder(a: QueueEntry, b: QueueEntry) {
  if (a.priority !== b.priority) return a.priority ? -1 : 1;
  return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
}

export function StaffQueue({ initialEntries, role, email }: Props) {
  const [entries, setEntries] = useState<QueueEntry[]>(initialEntries);
  const [pending, startTransition] = useTransition();
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [showPriorityForm, setShowPriorityForm] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("waiting");
  const [openMoveFor, setOpenMoveFor] = useState<string | null>(null);

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
      setEntries((data ?? []) as QueueEntry[]);
    }

    const channel = supabase
      .channel("queue:staff")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "queue_entries" },
        () => { void refresh(); },
      )
      .subscribe();

    return () => { void supabase.removeChannel(channel); };
  }, []);

  // Clinic dashboard handles General Clinic patients only. Pharmacy
  // entries are managed exclusively on /pharmacy.
  const clinicalEntries = useMemo(
    () => entries.filter((e) => streamFor(e.visit_type) === "clinical"),
    [entries],
  );

  // Patients who have pressed Request Help. requestHelp() fast-tracks
  // them straight to with_nurse so a nurse is dispatched. Banner
  // appears the moment the request lands and clears once the nurse
  // moves them on (Send to doctor / Mark seen).
  const helpRequesters = useMemo(
    () =>
      clinicalEntries.filter(
        (e) =>
          (e as { help_requested_at?: string | null }).help_requested_at &&
          e.status === "with_nurse",
      ),
    [clinicalEntries],
  );

  // Visual banner only -- no audio. (Audio alerts proved unreliable in
  // the demo; staff feedback can re-add it if needed.)

  // EE12: tab labels carry the per-bucket counts; we don't need a
  // duplicate stat grid. Kept only the "Avg wait" + "Seen" headline
  // metrics which aren't shown in the tabs.
  const isInProgress = (e: QueueEntry) => CLINIC_IN_PROGRESS.includes(e.status);

  // EE-wait: average time between arrival (created_at) and first call
  // (called_at), in whole minutes. Only counted for entries that have
  // actually been called -- gives staff a feel for how the room is
  // moving today. Visible to staff only; not exposed on /display.
  const avgWaitMinutes = useMemo(() => {
    const calledOrSeen = clinicalEntries.filter(
      (e) => e.called_at && e.created_at,
    );
    if (calledOrSeen.length === 0) return null;
    const totalMs = calledOrSeen.reduce((acc, e) => {
      const wait = new Date(e.called_at as string).getTime() - new Date(e.created_at).getTime();
      return acc + Math.max(0, wait);
    }, 0);
    return Math.round(totalMs / calledOrSeen.length / 60_000);
  }, [clinicalEntries]);

  // Tab partitions
  const byTab: Record<Tab, QueueEntry[]> = useMemo(() => ({
    waiting: clinicalEntries.filter((e) => e.status === "waiting").sort(sortQueueOrder),
    called: clinicalEntries.filter(isInProgress).sort(sortQueueOrder),
    seen: clinicalEntries.filter((e) => e.status === "seen")
      .sort((a, b) => new Date(b.seen_at ?? 0).getTime() - new Date(a.seen_at ?? 0).getTime()),
  }), [clinicalEntries]);

  function submitAction(action: (fd: FormData) => Promise<void>, id: string) {
    const fd = new FormData();
    fd.set("id", id);
    startTransition(() => action(fd));
  }

  function handleMove(id: string, visitType: string) {
    const fd = new FormData();
    fd.set("id", id);
    fd.set("visit_type", visitType);
    startTransition(() => staffTransferAction(fd));
    setOpenMoveFor(null);
  }

  // One-click escalation: flips priority and jumps the patient
  // straight to "with nurse" so a clinician sees them now.
  function handleMarkUrgent(id: string) {
    if (!window.confirm("Mark this patient urgent and call them to the Nurse now?")) return;
    const fd = new FormData();
    fd.set("id", id);
    startTransition(() => setUrgentAction(fd));
  }

  function handleReset() {
    startTransition(() => resetDayAction());
    setConfirmingReset(false);
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <header className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-brand">
            Clinic dashboard
          </p>
          <h1 className="mt-1 text-3xl font-bold">Today&apos;s queue</h1>
          <p className="mt-1 text-sm text-slate-500">
            Signed in as {email} ({role})
          </p>
        </div>
        <form action={staffLogoutAction}>
          <button type="submit" className="btn-secondary">Sign out</button>
        </form>
      </header>

      {/* Help-request alert banner. Visible whenever there are
          un-acted-upon Request Help presses from patient phones.
          Solid red (no flash, no audio) -- clears automatically once
          a clinician calls or marks the patient urgent. */}
      {helpRequesters.length > 0 && (
        <div
          role="alert"
          className="mt-6 rounded-xl border-2 border-red-500 bg-red-600 p-5 text-white shadow-lg"
        >
          <div className="flex items-center gap-3">
            <span className="text-3xl" aria-hidden>🆘</span>
            <div className="flex-1">
              <p className="text-sm font-bold uppercase tracking-wider">
                Help requested
              </p>
              <p className="mt-1 text-lg font-semibold">
                {helpRequesters.length === 1
                  ? `${helpRequesters[0].name} pressed Request Help — go to them now.`
                  : `${helpRequesters.length} patients pressed Request Help — go to them now: ${helpRequesters.map((e) => e.name).join(", ")}.`}
              </p>
              <p className="mt-1 text-sm text-red-100">
                Check on the patient, then Send to doctor or Finish at clinic to clear this alert.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* EE12 + EE-wait: tabs already carry Waiting/Called/Seen
          counts. Headline strip surfaces the one number the tabs
          don't: how long patients are actually waiting today. */}
      <div className="mt-6 rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">
        <span className="font-semibold text-slate-800">Average wait today:</span>{" "}
        {avgWaitMinutes === null
          ? "—  (no patients called yet)"
          : <>{avgWaitMinutes} minute{avgWaitMinutes === 1 ? "" : "s"} from check-in to first call</>}
      </div>

      <div className="mt-6 flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-secondary"
          onClick={() => setShowPriorityForm((v) => !v)}
        >
          {showPriorityForm ? "Cancel priority insert" : "+ Priority insert"}
        </button>
      </div>

      {showPriorityForm && (
        <PriorityInsertForm onDone={() => setShowPriorityForm(false)} />
      )}

      <div className="mt-8 border-b border-slate-200">
        <nav className="-mb-px flex gap-6">
          {(["waiting", "called", "seen"] as Tab[]).map((t) => {
            const labelMap: Record<Tab, string> = {
              waiting: `Waiting (${byTab.waiting.length})`,
              called: `Called (${byTab.called.length})`,
              seen: `Seen (${byTab.seen.length})`,
            };
            const active = activeTab === t;
            return (
              <button
                key={t}
                type="button"
                onClick={() => setActiveTab(t)}
                className={`-mb-px border-b-2 px-1 pb-3 text-sm font-semibold capitalize ${
                  active
                    ? "border-brand text-brand"
                    : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700"
                }`}
              >
                {labelMap[t]}
              </button>
            );
          })}
        </nav>
      </div>

      <section className="mt-4">
        {byTab[activeTab].length === 0 ? (
          <p className="rounded-lg bg-slate-50 p-6 text-center text-slate-500">
            No patients {activeTab === "seen" ? "seen yet today" : `in the ${activeTab} list`}.
          </p>
        ) : activeTab === "seen" ? (
          <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 text-sm text-slate-600">
            {byTab.seen.map((e) => (
              <li key={e.id} className="flex items-center justify-between p-3">
                <span>
                  <span className="font-mono text-slate-400">#{e.ticket_number ?? "—"}</span>{" "}
                  {e.name}
                </span>
                <span className="text-slate-400">
                  {e.seen_at ? formatTime(e.seen_at) : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200">
            {byTab[activeTab].map((e) => {
              const stream = streamFor(e.visit_type);
              const wasCalled = CLINIC_IN_PROGRESS.includes(e.status) || e.status === "preparing";
              return (
                <li
                  key={e.id}
                  className={`grid grid-cols-1 gap-3 p-4 sm:grid-cols-[3.5rem_1fr_auto] sm:items-center ${
                    e.priority ? "border-l-4 border-red-500 bg-red-50/40" : ""
                  }`}
                >
                  <div className="flex flex-col items-start">
                    <span className="text-2xl font-bold text-brand">
                      {e.ticket_number ?? "—"}
                    </span>
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                      {STREAM_LABELS[stream]}
                    </span>
                  </div>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-lg font-semibold">{e.name}</span>
                      {/* EE4: distinct button styling — outlined + chevron
                          so it doesn't visually fight the WAITING /
                          PRIORITY badges next to it. Still adjacent to
                          the name for quick access. */}
                      {e.status === "waiting" && !e.priority && (
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => handleMarkUrgent(e.id)}
                          className="rounded-md border border-red-600 px-2.5 py-1 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
                          title="Mark urgent — automatically calls this patient to the Nurse"
                        >
                          ⚠ Mark urgent
                        </button>
                      )}
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold uppercase ${statusBadge(e.status)}`}
                      >
                        {statusLabel(e.status)}
                      </span>
                      {e.priority && (
                        <span className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-bold uppercase text-white">
                          Priority
                        </span>
                      )}
                      {(e as { help_requested_at?: string | null }).help_requested_at && (
                        <span
                          className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-bold uppercase text-white"
                          title="Patient pressed Request help on their phone"
                        >
                          🆘 Help requested
                        </span>
                      )}
                      {e.transferred_from && (
                        <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-700">
                          ← {e.transferred_from}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-sm text-slate-500">
                      {visitTypeLabel(e.visit_type)} ·{" "}
                      {(e as { id_type?: string }).id_type === "passport" ? "Passport" : "National ID"}:{" "}
                      {(e as { id_number?: string }).id_number} · Ref:{" "}
                      <span className="font-mono tracking-widest">{e.token}</span>
                    </p>
                    {e.priority && e.priority_reason && (
                      <p className="mt-1 text-xs text-red-700">
                        Priority reason: {e.priority_reason}
                      </p>
                    )}
                    {/* EE5: surface the "Other" reason inline so the
                        clinician knows what the patient came in for. */}
                    {e.visit_type === "other" && (e as { other_reason?: string | null }).other_reason && (
                      <p className="mt-1 text-xs text-slate-700">
                        <span className="font-semibold">Reason: </span>
                        {(e as { other_reason?: string | null }).other_reason}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2 sm:justify-end">
                    {/* Single-action progression through the General Clinic
                        sub-stages: Call -> Mark at records -> Send to nurse
                        -> Send to doctor -> Mark seen. */}
                    {e.status === "waiting" && (
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={pending}
                        onClick={() => submitAction(callPatientAction, e.id)}
                      >
                        Call
                      </button>
                    )}
                    {e.status === "called" && (
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={pending}
                        onClick={() => submitAction(setAtRecordsAction, e.id)}
                        title="Records desk acknowledges the patient has arrived"
                      >
                        Patient at records
                      </button>
                    )}
                    {e.status === "at_records" && (
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={pending}
                        onClick={() => submitAction(setWithNurseAction, e.id)}
                        title="Records desk hands the patient over to the nurse station"
                      >
                        Send to nurse
                      </button>
                    )}
                    {/* FF1: after nurse, the clinician decides whether
                        the patient still needs to see the doctor or
                        whether the visit is complete. Two buttons so
                        the choice is explicit. LL1: labels say
                        "Finish at clinic" so the new "done with this
                        department" semantic is obvious. */}
                    {e.status === "with_nurse" && (
                      <>
                        <button
                          type="button"
                          className="btn-primary"
                          disabled={pending}
                          onClick={() => submitAction(setWithDoctorAction, e.id)}
                          title="Patient still needs to see the doctor"
                        >
                          Send to doctor
                        </button>
                        <button
                          type="button"
                          className="rounded-lg border border-emerald-600 px-3 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                          disabled={pending}
                          onClick={() => submitAction(markSeenAction, e.id)}
                          title="Close the General Clinic visit without sending to a doctor"
                        >
                          Finish at clinic (no doctor)
                        </button>
                      </>
                    )}
                    {e.status === "with_doctor" && (
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={pending}
                        onClick={() => submitAction(markSeenAction, e.id)}
                        title="Close the General Clinic visit"
                      >
                        Finish at clinic
                      </button>
                    )}
                    {/* Patient can be transferred to pharmacy at any
                        in-progress stage. */}
                    {wasCalled && (
                      <div className="relative">
                        <button
                          type="button"
                          className="btn-secondary"
                          disabled={pending}
                          onClick={() =>
                            setOpenMoveFor((curr) => (curr === e.id ? null : e.id))
                          }
                        >
                          Move to…
                        </button>
                        {openMoveFor === e.id && (
                          <div className="absolute right-0 z-10 mt-1 w-44 rounded-md border border-slate-200 bg-white shadow-lg">
                            {DEPARTMENTS.filter((d) => d.stream !== stream).map((d) => (
                              <button
                                key={d.stream}
                                type="button"
                                className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-100"
                                onClick={() => handleMove(e.id, d.defaultVisitType)}
                              >
                                {d.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {role === "admin" && (
        <section className="mt-10 rounded-lg border border-red-200 bg-red-50 p-6">
          <h2 className="text-lg font-semibold text-red-800">Reset today&apos;s queue</h2>
          <p className="mt-2 text-sm text-red-900">
            Deletes every entry created today. Admin-only.
          </p>
          {confirmingReset ? (
            <div className="mt-4 flex flex-wrap gap-3">
              <button
                type="button"
                className="btn-danger"
                disabled={pending}
                onClick={handleReset}
              >
                Yes, delete all of today&apos;s entries
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setConfirmingReset(false)}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn-danger mt-4"
              onClick={() => setConfirmingReset(true)}
            >
              Reset day
            </button>
          )}
        </section>
      )}

      <PoweredBy className="mt-12" />
    </main>
  );
}

function PriorityInsertForm({ onDone }: { onDone: () => void }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onSubmit(fd: FormData) {
    setError(null);
    startTransition(async () => {
      try {
        await priorityInsertAction(fd);
        onDone();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Priority insert failed");
      }
    });
  }

  return (
    <form
      action={onSubmit}
      className="mt-4 rounded-lg border border-red-200 bg-red-50/60 p-4"
    >
      <p className="text-sm font-semibold text-red-800">
        Priority insert (police / prison officer / emergency)
      </p>
      <p className="mt-1 text-xs text-red-700">
        Placed at the front of the chosen queue. Not shown on the public display.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <input
          name="name"
          required
          placeholder="Patient name"
          className="field-input"
        />
        <input
          name="id_number"
          placeholder="ID (optional)"
          className="field-input"
        />
        <select name="visit_type" required defaultValue="general" className="field-input">
          {VISIT_TYPES.filter((v) => v.value !== "pharmacy").map((v) => (
            <option key={v.value} value={v.value}>{v.label}</option>
          ))}
        </select>
        <input
          name="reason"
          required
          placeholder="Reason (e.g. police escort)"
          className="field-input"
        />
        <input type="hidden" name="id_type" value="national_id" />
      </div>
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
      <div className="mt-3 flex gap-2">
        <button type="submit" disabled={pending} className="btn-danger">
          {pending ? "Inserting…" : "Insert at front of queue"}
        </button>
        <button type="button" onClick={onDone} className="btn-secondary">Cancel</button>
      </div>
    </form>
  );
}
