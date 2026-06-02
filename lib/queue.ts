import { getServerSupabase, getAnonServerSupabase } from "./supabase-server";
import { generateToken } from "./token";
import { streamFor } from "./types";
import type { HasPrescription, Nationality, QueueEntry, Stream } from "./types";

const AVG_MINUTES_PER_PATIENT = 8;
const MAX_TOKEN_ATTEMPTS = 8;

function startOfTodayIso(): string {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.toISOString();
}

async function nextTicketNumber(stream: Stream): Promise<number> {
  const supabase = getServerSupabase();
  const since = startOfTodayIso();
  const isPharmacy = stream === "pharmacy";

  let query = supabase
    .from("queue_entries")
    .select("ticket_number")
    .gte("created_at", since)
    .order("ticket_number", { ascending: false })
    .limit(1);

  query = isPharmacy
    ? query.eq("visit_type", "pharmacy")
    : query.neq("visit_type", "pharmacy");

  const { data } = await query.maybeSingle();
  const last = (data?.ticket_number as number | null) ?? 0;
  return last + 1;
}

async function writeAudit(row: {
  entry_id: string | null;
  actor_id?: string | null;
  actor_label?: string | null;
  action:
    | "sign_in"
    | "call"
    | "at_records"
    | "with_nurse"
    | "with_doctor"
    | "preparing"
    | "seen"
    | "transfer"
    | "priority_insert"
    | "pharmacy_note"
    | "reset_day";
  detail?: Record<string, unknown> | null;
}): Promise<void> {
  const supabase = getServerSupabase();
  await supabase.from("queue_audit").insert({
    entry_id: row.entry_id,
    actor_id: row.actor_id ?? null,
    actor_label: row.actor_label ?? null,
    action: row.action,
    detail: row.detail ?? null,
  });
}

export async function listTodayEntries(): Promise<QueueEntry[]> {
  const supabase = getAnonServerSupabase();
  const { data, error } = await supabase
    .from("queue_entries")
    .select("*")
    .gte("created_at", startOfTodayIso())
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as QueueEntry[];
}

export async function findEntryByIdNumber(idNumber: string): Promise<QueueEntry | null> {
  const supabase = getAnonServerSupabase();
  const { data } = await supabase
    .from("queue_entries")
    .select("*")
    .eq("id_number", idNumber)
    .gte("created_at", startOfTodayIso())
    .neq("status", "seen")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as QueueEntry | null) ?? null;
}

// Patient-side lookup. Matches today's active entries on full name
// (case-insensitive), ID number (exact), or reference token
// (case-insensitive). First match wins, freshest entry first.
export async function findEntryByQuery(query: string): Promise<QueueEntry | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const supabase = getAnonServerSupabase();
  const { data, error } = await supabase
    .from("queue_entries")
    .select("*")
    .gte("created_at", startOfTodayIso())
    .neq("status", "seen")
    .order("created_at", { ascending: false });
  if (error) throw error;

  const lower = trimmed.toLowerCase();
  const rows = (data ?? []) as QueueEntry[];
  return (
    rows.find(
      (r) =>
        r.name.toLowerCase() === lower ||
        r.id_number === trimmed ||
        r.token.toLowerCase() === lower,
    ) ?? null
  );
}

export async function getEntryByToken(token: string): Promise<QueueEntry | null> {
  const supabase = getAnonServerSupabase();
  const { data, error } = await supabase
    .from("queue_entries")
    .select("*")
    .eq("token", token)
    .maybeSingle();
  if (error) throw error;
  return (data as QueueEntry | null) ?? null;
}

export interface CreateEntryInput {
  name: string;
  idType: string;
  idNumber: string;
  visitType: string;
  hasPrescription?: HasPrescription | null;
  nationality?: Nationality | null;
  countryOfOrigin?: string | null;
}

export async function createEntry({
  name,
  idType,
  idNumber,
  visitType,
  hasPrescription,
  nationality,
  countryOfOrigin,
}: CreateEntryInput): Promise<QueueEntry> {
  const supabase = getServerSupabase();

  const { count, error: countError } = await supabase
    .from("queue_entries")
    .select("id", { count: "exact", head: true })
    .eq("status", "waiting")
    .gte("created_at", startOfTodayIso());
  if (countError) throw countError;

  const position = (count ?? 0) + 1;
  const stream = streamFor(visitType);
  const ticketNumber = await nextTicketNumber(stream);

  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_TOKEN_ATTEMPTS; attempt++) {
    const token = generateToken(4);
    const { data, error } = await supabase
      .from("queue_entries")
      .insert({
        token,
        name: name.trim(),
        id_type: idType,
        id_number: idNumber.trim(),
        visit_type: visitType,
        position,
        ticket_number: ticketNumber,
        status: "waiting",
        has_prescription: visitType === "pharmacy" ? hasPrescription ?? null : null,
        nationality: nationality ?? null,
        // Country of origin is only meaningful for non-nationals; the DB
        // check constraint enforces the pairing.
        country_of_origin:
          nationality === "non_national" ? countryOfOrigin ?? null : null,
      })
      .select("*")
      .single();
    if (!error && data) {
      await writeAudit({
        entry_id: (data as QueueEntry).id,
        action: "sign_in",
        detail: { stream, ticket_number: ticketNumber, visit_type: visitType },
      });
      return data as QueueEntry;
    }
    lastError = error;
    if (error && (error as { code?: string }).code !== "23505") {
      throw error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to allocate a unique queue token");
}

export interface PriorityInsertInput extends CreateEntryInput {
  reason: string;
  actorId: string | null;
  actorLabel: string | null;
}

export async function priorityInsert(input: PriorityInsertInput): Promise<QueueEntry> {
  const supabase = getServerSupabase();
  const stream = streamFor(input.visitType);
  const ticketNumber = await nextTicketNumber(stream);

  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_TOKEN_ATTEMPTS; attempt++) {
    const token = generateToken(4);
    const { data, error } = await supabase
      .from("queue_entries")
      .insert({
        token,
        name: input.name.trim(),
        id_type: input.idType,
        id_number: input.idNumber.trim() || "PRIORITY",
        visit_type: input.visitType,
        position: 0,
        ticket_number: ticketNumber,
        status: "waiting",
        priority: true,
        priority_reason: input.reason.trim() || null,
      })
      .select("*")
      .single();
    if (!error && data) {
      await writeAudit({
        entry_id: (data as QueueEntry).id,
        actor_id: input.actorId,
        actor_label: input.actorLabel,
        action: "priority_insert",
        detail: { stream, ticket_number: ticketNumber, reason: input.reason },
      });
      return data as QueueEntry;
    }
    lastError = error;
    if (error && (error as { code?: string }).code !== "23505") {
      throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Priority insert failed");
}

export async function callEntry(id: string, actor?: { id: string | null; label: string | null }): Promise<void> {
  const supabase = getServerSupabase();

  const { data: entry, error: fetchError } = await supabase
    .from("queue_entries")
    .select("visit_type")
    .eq("id", id)
    .single();
  if (fetchError) throw fetchError;

  // Only one "called" at a time per visit type -- demote previous.
  await supabase
    .from("queue_entries")
    .update({ status: "seen", seen_at: new Date().toISOString() })
    .in("status", ["called", "preparing"])
    .eq("visit_type", entry.visit_type)
    .neq("id", id);

  const { error } = await supabase
    .from("queue_entries")
    .update({ status: "called", called_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;

  await writeAudit({
    entry_id: id,
    actor_id: actor?.id ?? null,
    actor_label: actor?.label ?? null,
    action: "call",
  });
}

export async function setPreparing(id: string, actor?: { id: string | null; label: string | null }): Promise<void> {
  const supabase = getServerSupabase();
  // Bump called_at so the display banner surfaces the most-recently-
  // transitioned patient (banner sorts by called_at desc).
  const { error } = await supabase
    .from("queue_entries")
    .update({ status: "preparing", called_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
  await writeAudit({
    entry_id: id,
    actor_id: actor?.id ?? null,
    actor_label: actor?.label ?? null,
    action: "preparing",
  });
}

// General Clinic sub-stages. Each advances the patient one step through
// the records -> nurse -> doctor flow.
async function setClinicStage(
  id: string,
  status: "at_records" | "with_nurse" | "with_doctor",
  actor?: { id: string | null; label: string | null },
): Promise<void> {
  const supabase = getServerSupabase();
  // Bump called_at only on transitions that represent a NEW call to a
  // station (with_nurse, with_doctor). at_records is an acknowledgment
  // that the patient has arrived -- not a new call -- so it doesn't
  // need to surface on the display banner.
  const isNewCall = status === "with_nurse" || status === "with_doctor";
  const patch: { status: typeof status; called_at?: string } = { status };
  if (isNewCall) patch.called_at = new Date().toISOString();
  const { error } = await supabase
    .from("queue_entries")
    .update(patch)
    .eq("id", id);
  if (error) throw error;
  await writeAudit({
    entry_id: id,
    actor_id: actor?.id ?? null,
    actor_label: actor?.label ?? null,
    action: status,
  });
}

export const setAtRecords = (id: string, actor?: { id: string | null; label: string | null }) =>
  setClinicStage(id, "at_records", actor);
export const setWithNurse = (id: string, actor?: { id: string | null; label: string | null }) =>
  setClinicStage(id, "with_nurse", actor);
export const setWithDoctor = (id: string, actor?: { id: string | null; label: string | null }) =>
  setClinicStage(id, "with_doctor", actor);

// Escalate an existing waiting patient: flip priority AND jump them
// straight to "with nurse" so a clinician sees them now. One-click,
// no reason prompt -- the audit row captures who pressed it.
//
// For pharmacy patients the nurse lives in the clinical stream, so we
// transfer the entry over (new ticket number, transferred_from set)
// and then mark with_nurse in the same update.
export async function setUrgent(
  id: string,
  actor?: { id: string | null; label: string | null },
): Promise<void> {
  const supabase = getServerSupabase();
  const { data: existing } = await supabase
    .from("queue_entries")
    .select("visit_type, transferred_from, priority_reason")
    .eq("id", id)
    .maybeSingle();
  if (!existing) throw new Error("Entry not found");

  const now = new Date().toISOString();
  const wasPharmacy = (existing.visit_type as string) === "pharmacy";
  const reason = (existing.priority_reason as string | null) ?? "Marked urgent — sent to nurse";

  if (wasPharmacy) {
    // Move into the clinical stream so the clinic dashboard picks them
    // up and the public display routes the call to the General Clinic
    // column.
    const newTicket = await nextTicketNumber("clinical");
    const { error } = await supabase
      .from("queue_entries")
      .update({
        visit_type: "general",
        ticket_number: newTicket,
        transferred_from: (existing.transferred_from as string | null) ?? "pharmacy",
        status: "with_nurse",
        called_at: now,
        priority: true,
        priority_reason: reason,
      })
      .eq("id", id);
    if (error) throw error;
  } else {
    const { error } = await supabase
      .from("queue_entries")
      .update({
        status: "with_nurse",
        called_at: now,
        priority: true,
        priority_reason: reason,
      })
      .eq("id", id);
    if (error) throw error;
  }

  await writeAudit({
    entry_id: id,
    actor_id: actor?.id ?? null,
    actor_label: actor?.label ?? null,
    action: "priority_insert",
    detail: { escalated: true, via: "clinician_urgent", fromPharmacy: wasPharmacy },
  });
}

// Patient-initiated help request. The patient is in possession of
// their queue token, which is enough authentication. We flip priority
// and stamp help_requested_at + reason, but do NOT auto-advance them
// to with_nurse -- staff still triage. The clinic dashboard surfaces
// the request with a visible red banner on the row.
export async function requestHelp(token: string): Promise<void> {
  const supabase = getServerSupabase();
  const { data: entry } = await supabase
    .from("queue_entries")
    .select("id")
    .eq("token", token)
    .maybeSingle();
  if (!entry) throw new Error("Entry not found");

  const id = entry.id as string;
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("queue_entries")
    .update({
      priority: true,
      priority_reason: "Patient requested help — condition worsening",
      help_requested_at: now,
    })
    .eq("id", id);
  if (error) throw error;

  await writeAudit({
    entry_id: id,
    actor_id: null,
    actor_label: `patient:${token}`,
    action: "priority_insert",
    detail: { escalated: true, via: "patient_help" },
  });
}

export async function markSeen(id: string, actor?: { id: string | null; label: string | null }): Promise<void> {
  const supabase = getServerSupabase();
  const { error } = await supabase
    .from("queue_entries")
    .update({ status: "seen", seen_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
  await writeAudit({
    entry_id: id,
    actor_id: actor?.id ?? null,
    actor_label: actor?.label ?? null,
    action: "seen",
  });
}

export async function setPharmacyNote(
  id: string,
  note: string,
  actor?: { id: string | null; label: string | null },
): Promise<void> {
  const supabase = getServerSupabase();
  const { error } = await supabase
    .from("queue_entries")
    .update({ pharmacy_notes: note.trim() || null })
    .eq("id", id);
  if (error) throw error;
  await writeAudit({
    entry_id: id,
    actor_id: actor?.id ?? null,
    actor_label: actor?.label ?? null,
    action: "pharmacy_note",
    detail: { note: note.trim() || null },
  });
}

export interface TransferEntryInput {
  id: string;
  newVisitType: string;
  hasPrescription?: HasPrescription | null;
  actorId: string | null;
  actorLabel: string | null;
}

export async function transferEntry(input: TransferEntryInput): Promise<QueueEntry> {
  const supabase = getServerSupabase();
  const { data: existing, error: fetchError } = await supabase
    .from("queue_entries")
    .select("*")
    .eq("id", input.id)
    .single();
  if (fetchError || !existing) throw fetchError ?? new Error("Entry not found");
  const e = existing as QueueEntry;

  const newStream = streamFor(input.newVisitType);
  const ticketNumber = await nextTicketNumber(newStream);
  const nowIso = new Date().toISOString();

  const updates: Record<string, unknown> = {
    visit_type: input.newVisitType,
    transferred_from: e.transferred_from ?? e.visit_type,
    ticket_number: ticketNumber,
    created_at: nowIso,  // bump to end of destination queue
    status: "waiting",
    called_at: null,
    seen_at: null,
  };
  if (input.newVisitType === "pharmacy") {
    updates.has_prescription = input.hasPrescription ?? e.has_prescription ?? null;
  }

  const { data, error } = await supabase
    .from("queue_entries")
    .update(updates)
    .eq("id", input.id)
    .select("*")
    .single();
  if (error) throw error;

  await writeAudit({
    entry_id: input.id,
    actor_id: input.actorId,
    actor_label: input.actorLabel,
    action: "transfer",
    detail: {
      from_visit_type: e.visit_type,
      to_visit_type: input.newVisitType,
      original_created_at: e.created_at,
      new_ticket_number: ticketNumber,
    },
  });

  return data as QueueEntry;
}

export async function resetToday(actor?: { id: string | null; label: string | null }): Promise<void> {
  const supabase = getServerSupabase();
  const { error } = await supabase
    .from("queue_entries")
    .delete()
    .gte("created_at", startOfTodayIso());
  if (error) throw error;
  await writeAudit({
    entry_id: null,
    actor_id: actor?.id ?? null,
    actor_label: actor?.label ?? null,
    action: "reset_day",
  });
}

export async function listTodayAudit(limit = 50): Promise<unknown[]> {
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from("queue_audit")
    .select("*")
    .gte("created_at", startOfTodayIso())
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

export interface QueueViewModel {
  entry: QueueEntry;
  ahead: number;
  estimatedWaitMinutes: number;
}

export async function getQueueViewForToken(token: string): Promise<QueueViewModel | null> {
  const entry = await getEntryByToken(token);
  if (!entry) return null;
  return buildView(entry, await listTodayEntries());
}

export function buildView(entry: QueueEntry, today: QueueEntry[]): QueueViewModel {
  const myStream = streamFor(entry.visit_type);
  const ahead =
    entry.status === "waiting"
      ? today.filter((e) => {
          if (e.status !== "waiting") return false;
          if (streamFor(e.visit_type) !== myStream) return false;
          // Priority always ahead of non-priority.
          if (e.priority && !entry.priority) return true;
          if (!e.priority && entry.priority) return false;
          return new Date(e.created_at).getTime() < new Date(entry.created_at).getTime();
        }).length
      : 0;
  return {
    entry,
    ahead,
    estimatedWaitMinutes: ahead * AVG_MINUTES_PER_PATIENT,
  };
}

export { initials, maskedDisplayName } from "./queue-client";
