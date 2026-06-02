"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  callEntry,
  createEntry,
  findEntryByIdNumber,
  findEntryByQuery,
  getEntryByToken,
  markSeen,
  priorityInsert,
  resetToday,
  setAtRecords,
  setPharmacyNote,
  setPreparing,
  setUrgent,
  setWithDoctor,
  setWithNurse,
  transferEntry,
} from "@/lib/queue";
import { createSSRClient, getStaffSession, requireRole } from "@/lib/auth-server";
import { COUNTRY_VALUES, VISIT_TYPE_VALUES } from "@/lib/types";
import type { HasPrescription, Nationality, StaffRole } from "@/lib/types";

const PRESCRIPTION_VALUES: HasPrescription[] = ["yes", "no", "electronic"];
const NATIONALITY_VALUES: Nationality[] = ["national", "non_national"];

function actorFromSession(session: { id: string; email: string } | null) {
  return {
    id: session?.id ?? null,
    label: session?.email ?? null,
  };
}

// --- Sign-in (public) ------------------------------------------------------

export async function signInAction(formData: FormData): Promise<void> {
  const name = String(formData.get("name") ?? "").trim();
  const rawNationality = String(formData.get("nationality") ?? "").trim();
  const rawCountry = String(formData.get("country_of_origin") ?? "").trim();
  const idType = String(formData.get("id_type") ?? "").trim();
  const idNumber = String(formData.get("id_number") ?? "").trim();
  const visitType = String(formData.get("visit_type") ?? "").trim();
  const rawPrescription = String(formData.get("has_prescription") ?? "").trim();

  // Server-side validation is the source of truth. Client mirrors these
  // checks for inline UX; if anything slips past the client, we still
  // reject here with the same error codes.
  if (name.length < 2) throw new Error("NAME_TOO_SHORT");
  if (!NATIONALITY_VALUES.includes(rawNationality as Nationality)) {
    throw new Error("NATIONALITY_REQUIRED");
  }
  const nationality = rawNationality as Nationality;

  // National branch: ID type is forced to national_id (Barbados National ID).
  // Non-National branch: country + ID type (national_id | passport) + ID number.
  let effectiveIdType: string;
  let countryOfOrigin: string | null = null;
  if (nationality === "national") {
    effectiveIdType = "national_id";
  } else {
    if (!COUNTRY_VALUES.includes(rawCountry)) {
      throw new Error("COUNTRY_REQUIRED");
    }
    countryOfOrigin = rawCountry;
    if (!["national_id", "passport"].includes(idType)) {
      throw new Error("ID_TYPE_INVALID");
    }
    effectiveIdType = idType;
  }

  if (!idNumber) throw new Error("ID_NUMBER_REQUIRED");
  if (!VISIT_TYPE_VALUES.includes(visitType as (typeof VISIT_TYPE_VALUES)[number])) {
    throw new Error("VISIT_TYPE_INVALID");
  }
  if (visitType === "pharmacy" && !PRESCRIPTION_VALUES.includes(rawPrescription as HasPrescription)) {
    throw new Error("PRESCRIPTION_REQUIRED");
  }

  // Duplicate-ID guard: if this ID number already has an active queue
  // entry today, don't create a second one. Client surfaces this as a
  // link to /lookup pre-populated with the same ID.
  const existing = await findEntryByIdNumber(idNumber);
  if (existing) {
    throw new Error(`DUPLICATE_ID:${idNumber}`);
  }

  const hasPrescription =
    visitType === "pharmacy" && PRESCRIPTION_VALUES.includes(rawPrescription as HasPrescription)
      ? (rawPrescription as HasPrescription)
      : null;

  const entry = await createEntry({
    name,
    idType: effectiveIdType,
    idNumber,
    visitType,
    hasPrescription,
    nationality,
    countryOfOrigin,
  });
  redirect(`/queue/${entry.token}`);
}

// --- Staff auth ------------------------------------------------------------

export async function staffLoginAction(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) {
    redirect("/staff?error=missing");
  }

  const supabase = createSSRClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    redirect("/staff?error=invalid");
  }

  const session = await getStaffSession();
  if (!session) {
    redirect("/staff?error=unprovisioned");
  }

  redirect(session.role === "pharmacist" ? "/pharmacy" : "/staff");
}

export async function staffLogoutAction(): Promise<void> {
  const supabase = createSSRClient();
  await supabase.auth.signOut();
  redirect("/staff");
}

// --- Staff actions ---------------------------------------------------------

async function requireStaffRole(allowed: StaffRole[]) {
  return requireRole(allowed);
}

export async function callPatientAction(formData: FormData): Promise<void> {
  const session = await requireStaffRole(["clinician", "pharmacist", "admin"]);
  const id = String(formData.get("id") ?? "");
  if (!id) throw new Error("Missing id");
  await callEntry(id, actorFromSession(session));
  revalidatePath("/staff");
  revalidatePath("/pharmacy");
}

export async function markSeenAction(formData: FormData): Promise<void> {
  const session = await requireStaffRole(["clinician", "pharmacist", "admin"]);
  const id = String(formData.get("id") ?? "");
  if (!id) throw new Error("Missing id");
  await markSeen(id, actorFromSession(session));
  revalidatePath("/staff");
  revalidatePath("/pharmacy");
}

export async function setPreparingAction(formData: FormData): Promise<void> {
  const session = await requireStaffRole(["pharmacist", "admin"]);
  const id = String(formData.get("id") ?? "");
  if (!id) throw new Error("Missing id");
  await setPreparing(id, actorFromSession(session));
  revalidatePath("/pharmacy");
}

// General Clinic sub-stage advances. Each is callable by clinicians or
// admins from the clinic dashboard.
export async function setAtRecordsAction(formData: FormData): Promise<void> {
  const session = await requireStaffRole(["clinician", "admin"]);
  const id = String(formData.get("id") ?? "");
  if (!id) throw new Error("Missing id");
  await setAtRecords(id, actorFromSession(session));
  revalidatePath("/staff");
}

export async function setWithNurseAction(formData: FormData): Promise<void> {
  const session = await requireStaffRole(["clinician", "admin"]);
  const id = String(formData.get("id") ?? "");
  if (!id) throw new Error("Missing id");
  await setWithNurse(id, actorFromSession(session));
  revalidatePath("/staff");
}

export async function setWithDoctorAction(formData: FormData): Promise<void> {
  const session = await requireStaffRole(["clinician", "admin"]);
  const id = String(formData.get("id") ?? "");
  if (!id) throw new Error("Missing id");
  await setWithDoctor(id, actorFromSession(session));
  revalidatePath("/staff");
}

// Escalate an existing waiting patient to the front of the queue.
export async function setUrgentAction(formData: FormData): Promise<void> {
  const session = await requireStaffRole(["clinician", "pharmacist", "admin"]);
  const id = String(formData.get("id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!id) throw new Error("Missing id");
  if (!reason) throw new Error("REASON_REQUIRED");
  await setUrgent(id, reason, actorFromSession(session));
  revalidatePath("/staff");
  revalidatePath("/pharmacy");
}

export async function savePharmacyNoteAction(formData: FormData): Promise<void> {
  const session = await requireStaffRole(["pharmacist", "admin"]);
  const id = String(formData.get("id") ?? "");
  const note = String(formData.get("note") ?? "");
  if (!id) throw new Error("Missing id");
  await setPharmacyNote(id, note, actorFromSession(session));
  revalidatePath("/pharmacy");
}

export async function resetDayAction(): Promise<void> {
  const session = await requireStaffRole(["admin"]);
  await resetToday(actorFromSession(session));
  revalidatePath("/staff");
  revalidatePath("/pharmacy");
}

export async function staffTransferAction(formData: FormData): Promise<void> {
  const session = await requireStaffRole(["clinician", "pharmacist", "admin"]);
  const id = String(formData.get("id") ?? "");
  const newVisitType = String(formData.get("visit_type") ?? "");
  const rawPrescription = String(formData.get("has_prescription") ?? "");
  if (!id) throw new Error("Missing id");
  if (!VISIT_TYPE_VALUES.includes(newVisitType as (typeof VISIT_TYPE_VALUES)[number])) {
    throw new Error("Invalid visit type");
  }
  const hasPrescription =
    PRESCRIPTION_VALUES.includes(rawPrescription as HasPrescription)
      ? (rawPrescription as HasPrescription)
      : null;
  await transferEntry({
    id,
    newVisitType,
    hasPrescription,
    actorId: session.id,
    actorLabel: session.email,
  });
  revalidatePath("/staff");
  revalidatePath("/pharmacy");
}

export async function priorityInsertAction(formData: FormData): Promise<void> {
  const session = await requireStaffRole(["clinician", "pharmacist", "admin"]);
  const name = String(formData.get("name") ?? "").trim();
  const idType = String(formData.get("id_type") ?? "national_id");
  const idNumber = String(formData.get("id_number") ?? "").trim();
  const visitType = String(formData.get("visit_type") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  if (!name) throw new Error("Name is required");
  if (!reason) throw new Error("Priority reason is required");
  if (!VISIT_TYPE_VALUES.includes(visitType as (typeof VISIT_TYPE_VALUES)[number])) {
    throw new Error("Invalid visit type");
  }
  await priorityInsert({
    name,
    idType,
    idNumber,
    visitType,
    reason,
    actorId: session.id,
    actorLabel: session.email,
  });
  revalidatePath("/staff");
  revalidatePath("/pharmacy");
}

// --- Patient-facing actions ------------------------------------------------

export async function lookupPatientAction(formData: FormData): Promise<void> {
  // The form field is now "q" -- a single text field that can hold a name,
  // ID number, or reference code. We still accept legacy "id_number" for
  // backwards compatibility.
  const raw = String(formData.get("q") ?? formData.get("id_number") ?? "").trim();
  if (!raw) throw new Error("LOOKUP_EMPTY");
  const entry = await findEntryByQuery(raw);
  if (!entry) throw new Error("LOOKUP_NOT_FOUND");
  redirect(`/queue/${entry.token}`);
}

// Patient-initiated transfer. Restored from the May 27 clinic stakeholder
// meeting -- patients can move themselves between departments. Possession
// of the queue token serves as the patient's authentication.
export async function patientTransferAction(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "").trim();
  const newVisitType = String(formData.get("visit_type") ?? "").trim();
  const rawPrescription = String(formData.get("has_prescription") ?? "").trim();
  if (!token) throw new Error("Missing token");
  if (!VISIT_TYPE_VALUES.includes(newVisitType as (typeof VISIT_TYPE_VALUES)[number])) {
    throw new Error("Invalid visit type");
  }
  const entry = await getEntryByToken(token);
  if (!entry) throw new Error("Queue entry not found");

  const hasPrescription =
    PRESCRIPTION_VALUES.includes(rawPrescription as HasPrescription)
      ? (rawPrescription as HasPrescription)
      : null;

  await transferEntry({
    id: entry.id,
    newVisitType,
    hasPrescription,
    actorId: null,
    actorLabel: `patient:${token}`,
  });
  redirect(`/queue/${token}`);
}
