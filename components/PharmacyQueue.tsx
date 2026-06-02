"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { getBrowserSupabase } from "@/lib/supabase";
import type { QueueEntry, StaffRole } from "@/lib/types";
import { DEPARTMENTS } from "@/lib/types";
import { PoweredBy } from "@/components/PoweredBy";
import {
  callPatientAction,
  markSeenAction,
  savePharmacyNoteAction,
  setPreparingAction,
  setUrgentAction,
  staffLogoutAction,
  staffTransferAction,
} from "@/app/actions";

interface Props {
  initialEntries: QueueEntry[];
  email: string;
  role: StaffRole;
}

type Tab = "waiting" | "called" | "preparing" | "served";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function waitMinutes(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
}

function idTypeLabel(type: string): string {
  return type === "passport" ? "Passport" : "National ID";
}

function prescriptionLabel(value: string | null): string {
  if (value === "yes") return "Paper in hand";
  if (value === "electronic") return "Electronic on file";
  if (value === "no") return "No prescription";
  return "Not specified";
}

function statusBadgeClass(status: string) {
  if (status === "waiting") return "bg-slate-100 text-slate-700";
  if (status === "called") return "bg-amber-100 text-amber-800";
  if (status === "preparing") return "bg-blue-100 text-blue-800";
  return "bg-emerald-100 text-emerald-800";
}

function sortQueueOrder(a: QueueEntry, b: QueueEntry) {
  if (a.priority !== b.priority) return a.priority ? -1 : 1;
  return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
}

export function PharmacyQueue({ initialEntries, email, role }: Props) {
  const [entries, setEntries] = useState<QueueEntry[]>(initialEntries);
  const [pending, startTransition] = useTransition();
  const [openMoveFor, setOpenMoveFor] = useState<string | null>(null);

  function handleMove(id: string, visitType: string) {
    const fd = new FormData();
    fd.set("id", id);
    fd.set("visit_type", visitType);
    startTransition(() => staffTransferAction(fd));
    setOpenMoveFor(null);
  }

  function handleMarkUrgent(id: string) {
    if (!window.confirm("Mark urgent? Patient will be moved to the Clinic Nurse immediately.")) return;
    const fd = new FormData();
    fd.set("id", id);
    startTransition(() => setUrgentAction(fd));
  }
  const [, setNow] = useState(Date.now());
  const [activeTab, setActiveTab] = useState<Tab>("waiting");

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    const supabase = getBrowserSupabase();

    async function refresh() {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const { data } = await supabase
        .from("queue_entries")
        .select("*")
        .eq("visit_type", "pharmacy")
        .gte("created_at", today.toISOString())
        .order("priority", { ascending: false })
        .order("created_at", { ascending: true });
      setEntries((data ?? []) as QueueEntry[]);
    }

    void refresh();

    const channel = supabase
      .channel("queue:pharmacy")
      .on("postgres_changes", { event: "*", schema: "public", table: "queue_entries" }, () => {
        void refresh();
      })
      .subscribe();

    return () => { void supabase.removeChannel(channel); };
  }, []);

  function submitAction(action: (fd: FormData) => Promise<void>, id: string) {
    const fd = new FormData();
    fd.set("id", id);
    startTransition(() => action(fd));
  }

  // Stats: Waiting / Called / Served. Called count includes preparing too,
  // so the headline number matches what staff are working on right now.
  const stats = useMemo(() => ({
    waiting: entries.filter((e) => e.status === "waiting").length,
    called: entries.filter((e) => e.status === "called" || e.status === "preparing").length,
    served: entries.filter((e) => e.status === "seen").length,
  }), [entries]);

  // Tab partitions
  const byTab: Record<Tab, QueueEntry[]> = useMemo(() => ({
    waiting: entries.filter((e) => e.status === "waiting").sort(sortQueueOrder),
    called: entries.filter((e) => e.status === "called").sort(sortQueueOrder),
    preparing: entries.filter((e) => e.status === "preparing").sort(sortQueueOrder),
    served: entries.filter((e) => e.status === "seen")
      .sort((a, b) => new Date(b.seen_at ?? 0).getTime() - new Date(a.seen_at ?? 0).getTime()),
  }), [entries]);

  return (
    <main className="mx-auto max-w-4xl px-6 py-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-brand">
            St Thomas OPC
          </p>
          <h1 className="mt-1 text-3xl font-bold">Pharmacy Queue</h1>
          <p className="mt-1 text-sm text-slate-500">
            Signed in as {email} ({role})
          </p>
        </div>
        <form action={staffLogoutAction}>
          <button type="submit" className="btn-secondary">Sign out</button>
        </form>
      </header>

      <div className="grid grid-cols-3 gap-4 text-center mb-6">
        <Stat label="Waiting" value={stats.waiting} />
        <Stat label="Called" value={stats.called} />
        <Stat label="Served" value={stats.served} />
      </div>

      <div className="border-b border-slate-200">
        <nav className="-mb-px flex flex-wrap gap-6">
          {(["waiting", "called", "preparing", "served"] as Tab[]).map((t) => {
            const labelMap: Record<Tab, string> = {
              waiting: `Waiting (${byTab.waiting.length})`,
              called: `Called (${byTab.called.length})`,
              preparing: `Being Prepared (${byTab.preparing.length})`,
              served: `Served (${byTab.served.length})`,
            };
            const active = activeTab === t;
            return (
              <button
                key={t}
                type="button"
                onClick={() => setActiveTab(t)}
                className={`-mb-px border-b-2 px-1 pb-3 text-sm font-semibold ${
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
            No patients in the {activeTab === "preparing" ? "being prepared" : activeTab} list.
          </p>
        ) : activeTab === "served" ? (
          <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 text-sm text-slate-600">
            {byTab.served.map((e) => (
              <li key={e.id} className="flex items-center justify-between p-3">
                <div>
                  <span className="font-mono text-slate-400">#{e.ticket_number ?? "—"}</span>{" "}
                  <span className="font-medium">{e.name}</span>
                  <span className="ml-2 text-slate-400">
                    {idTypeLabel((e as { id_type?: string }).id_type ?? "")}: {(e as { id_number?: string }).id_number}
                  </span>
                </div>
                <span className="text-slate-400">
                  {e.seen_at ? formatTime(e.seen_at) : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <ul className="space-y-3">
            {byTab[activeTab].map((e) => {
              const isWaiting = e.status === "waiting";
              const isCalled = e.status === "called";
              const isPreparing = e.status === "preparing";
              return (
                <li
                  key={e.id}
                  className={`rounded-lg border p-4 ${
                    e.priority ? "border-red-300 bg-red-50/40" : "border-slate-200 bg-white"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-2xl font-bold text-brand">#{e.ticket_number ?? "—"}</span>
                    <span className="text-lg font-semibold">{e.name}</span>
                    {/* Urgent right next to the name. Pharmacy "urgent"
                        means the patient needs clinical attention — one
                        click flips priority, transfers them to the
                        General Clinic stream and calls them straight
                        to the Nurse. */}
                    {e.status === "waiting" && !e.priority && (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => handleMarkUrgent(e.id)}
                        className="rounded-md bg-red-600 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wider text-white shadow hover:bg-red-700 disabled:opacity-50"
                        title="Mark urgent — escalates this patient to the Clinic Nurse"
                      >
                        Urgent
                      </button>
                    )}
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold uppercase ${statusBadgeClass(e.status)}`}>
                      {e.status}
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
                    {idTypeLabel((e as { id_type?: string }).id_type ?? "")}:{" "}
                    <span className="font-medium text-slate-700">
                      {(e as { id_number?: string }).id_number}
                    </span>
                    {" "}· Ref:{" "}
                    <span className="font-mono tracking-widest">{e.token}</span>
                    {" "}· Arrived {formatTime(e.created_at)}
                    {" "}· {waitMinutes(e.created_at)} min waiting
                  </p>
                  <p className="mt-1 text-sm">
                    <span className="text-slate-500">Prescription: </span>
                    <span className="font-medium">{prescriptionLabel(e.has_prescription)}</span>
                  </p>

                  {/* Notes editor only shown once interaction has begun. */}
                  {!isWaiting && (
                    <NoteEditor entryId={e.id} initialValue={e.pharmacy_notes ?? ""} />
                  )}

                  <div className="mt-3 flex flex-wrap gap-2">
                    {/* Single-button-at-a-time progression: Call → Mark preparing → Mark served. */}
                    {isWaiting && (
                      <button
                        onClick={() => submitAction(callPatientAction, e.id)}
                        disabled={pending}
                        className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
                      >
                        Call
                      </button>
                    )}
                    {isCalled && (
                      <button
                        onClick={() => submitAction(setPreparingAction, e.id)}
                        disabled={pending}
                        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        Mark preparing
                      </button>
                    )}
                    {isPreparing && (
                      <button
                        onClick={() => submitAction(markSeenAction, e.id)}
                        disabled={pending}
                        className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                      >
                        Mark served
                      </button>
                    )}
                    {/* Re-enabled per May 27 stakeholder feedback: pharmacy
                        is one of three departments; staff can route to
                        Records or General Clinic if needed. */}
                    {!isWaiting && (
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
                            {DEPARTMENTS.filter((d) => d.stream !== "pharmacy").map((d) => (
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

      <PoweredBy className="mt-12" />
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-slate-50 p-4">
      <div className="text-3xl font-bold">{value}</div>
      <div className="text-sm text-slate-600">{label}</div>
    </div>
  );
}

function NoteEditor({ entryId, initialValue }: { entryId: string; initialValue: string }) {
  const [value, setValue] = useState(initialValue);
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  function save() {
    const fd = new FormData();
    fd.set("id", entryId);
    fd.set("note", value);
    startTransition(async () => {
      await savePharmacyNoteAction(fd);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    });
  }

  return (
    <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3">
      <label className="block text-xs font-semibold uppercase tracking-wider text-slate-500">
        Fulfilment notes
      </label>
      <textarea
        value={value}
        onChange={(ev) => setValue(ev.target.value)}
        rows={2}
        placeholder="e.g. Pulled — awaiting verification"
        className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={pending || value === initialValue}
          className="rounded-md bg-slate-700 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save note"}
        </button>
        {saved && <span className="text-xs text-emerald-700">Saved.</span>}
      </div>
    </div>
  );
}
