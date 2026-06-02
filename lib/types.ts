// Status lifecycle:
//  General Clinic: waiting -> called -> at_records -> with_nurse -> with_doctor -> seen
//  Pharmacy:       waiting -> called -> preparing -> seen
// Sub-stages are stream-specific; the same QueueStatus union covers both.
export type QueueStatus =
  | "waiting"
  | "called"
  | "at_records"
  | "with_nurse"
  | "with_doctor"
  | "preparing"
  | "seen";

export type VisitType = "general" | "follow-up" | "pharmacy" | "other";

export type IdType = "national_id" | "passport";

// Two patient-facing departments. Records is no longer a separate stream
// -- instead it is a sub-stage of the General Clinic flow (called -> at
// records -> with nurse -> with doctor -> seen).
export type Stream = "clinical" | "pharmacy";

export type HasPrescription = "yes" | "no" | "electronic";

export type StaffRole = "clinician" | "pharmacist" | "admin";

export type Nationality = "national" | "non_national";

export interface QueueEntry {
  id: string;
  token: string;
  name: string;
  id_type: IdType | string;
  id_number: string;
  visit_type: VisitType | string;
  position: number;
  ticket_number: number | null;
  status: QueueStatus;
  priority: boolean;
  priority_reason: string | null;
  transferred_from: string | null;
  pharmacy_notes: string | null;
  has_prescription: HasPrescription | null;
  nationality: Nationality | null;
  country_of_origin: string | null;
  created_at: string;
  called_at: string | null;
  seen_at: string | null;
  // Stamped when a patient presses Request Help on their phone. The
  // clinic dashboard uses this to surface a 🆘 banner on the row.
  help_requested_at?: string | null;
}

export interface StaffUser {
  id: string;
  email: string;
  role: StaffRole;
}

export interface QueueAuditRow {
  id: number;
  entry_id: string | null;
  actor_id: string | null;
  actor_label: string | null;
  action:
    | "sign_in"
    | "call"
    | "preparing"
    | "seen"
    | "transfer"
    | "priority_insert"
    | "pharmacy_note"
    | "reset_day";
  detail: Record<string, unknown> | null;
  created_at: string;
}

export const VISIT_TYPES: { value: VisitType; label: string; description: string }[] = [
  { value: "general", label: "General", description: "For consultations, referrals, or new concerns not covered by the options below." },
  { value: "follow-up", label: "Follow-up", description: "A return visit to check on a previous condition or treatment." },
  { value: "pharmacy", label: "Pharmacy", description: "To collect or enquire about a prescription or medication." },
  { value: "other", label: "Other", description: "For any visit not covered by the options above." },
];

export const VISIT_TYPE_VALUES = VISIT_TYPES.map((v) => v.value);

export const STREAM_LABELS: Record<Stream, string> = {
  clinical: "General Clinic",
  pharmacy: "Pharmacy",
};

export function streamFor(visitType: string): Stream {
  return visitType === "pharmacy" ? "pharmacy" : "clinical";
}

// Transfer destinations between the two departments. Pharmacy needs an
// additional prescription question.
export interface Department {
  stream: Stream;
  label: string;
  defaultVisitType: VisitType;
  askPrescription?: boolean;
}

export const DEPARTMENTS: Department[] = [
  { stream: "clinical", label: "General Clinic", defaultVisitType: "general" },
  { stream: "pharmacy", label: "Pharmacy", defaultVisitType: "pharmacy", askPrescription: true },
];

export const PRESCRIPTION_OPTIONS: { value: HasPrescription; label: string; description: string }[] = [
  { value: "yes", label: "Yes, paper prescription in hand", description: "I have the paper from my doctor today." },
  { value: "electronic", label: "Electronic prescription on file", description: "My doctor sent it to the pharmacy already." },
  { value: "no", label: "No prescription yet", description: "I'm here to ask about a medication or pick something up without a prescription." },
];

// Country options for the Non-National sign-in branch. CARICOM members
// first (geographically closest), then major non-CARICOM visitor sources
// to Barbados, then a fallback. "Other" lets a patient proceed without
// matching the list -- captured as free-text downstream.
export const COUNTRY_OPTIONS: { value: string; label: string }[] = [
  // CARICOM (excluding Barbados, which is the National branch)
  { value: "AG", label: "Antigua and Barbuda" },
  { value: "BS", label: "Bahamas" },
  { value: "BZ", label: "Belize" },
  { value: "DM", label: "Dominica" },
  { value: "GD", label: "Grenada" },
  { value: "GY", label: "Guyana" },
  { value: "HT", label: "Haiti" },
  { value: "JM", label: "Jamaica" },
  { value: "MS", label: "Montserrat" },
  { value: "KN", label: "Saint Kitts and Nevis" },
  { value: "LC", label: "Saint Lucia" },
  { value: "VC", label: "Saint Vincent and the Grenadines" },
  { value: "SR", label: "Suriname" },
  { value: "TT", label: "Trinidad and Tobago" },
  // Top non-CARICOM visitor sources
  { value: "GB", label: "United Kingdom" },
  { value: "US", label: "United States" },
  { value: "CA", label: "Canada" },
  { value: "DE", label: "Germany" },
  { value: "BR", label: "Brazil" },
  { value: "CN", label: "China" },
  { value: "IN", label: "India" },
  // Fallback
  { value: "OTHER", label: "Other" },
];

export const COUNTRY_VALUES = COUNTRY_OPTIONS.map((c) => c.value);
