"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { signInAction } from "@/app/actions";
import { COUNTRY_OPTIONS, PRESCRIPTION_OPTIONS } from "@/lib/types";

// Top-level visit choices presented on the check-in form. "general_clinic"
// is a UI grouping -- it collapses the underlying "general" and
// "follow-up" visit_type values into a sub-choice (new consultation vs
// follow-up) so patients aren't asked to know the difference between
// "general" and "follow-up" up front.
const TOP_LEVEL_VISITS = [
  {
    value: "general_clinic",
    label: "General Clinic",
    description: "Consultations, referrals, or new health concerns.",
  },
  {
    value: "pharmacy",
    label: "Pharmacy",
    description: "To collect or enquire about a prescription or medication.",
  },
  {
    value: "other",
    label: "Other",
    description: "For any visit not covered by the options above.",
  },
] as const;

const CONSULTATION_TYPES = [
  {
    value: "general",
    label: "New consultation",
    description: "A first visit for a new health concern or referral.",
  },
  {
    value: "follow-up",
    label: "Follow-up",
    description: "A return visit to check on a previous condition or treatment.",
  },
] as const;

interface Props {
  kiosk?: boolean;
}

type FieldKey =
  | "name"
  | "nationality"
  | "country_of_origin"
  | "id_number"
  | "visit_type"
  | "consultation_type"
  | "has_prescription";

interface DuplicateError {
  kind: "duplicate";
  idNumber: string;
}

const FIELD_META: Record<FieldKey, { anchor: string; label: string }> = {
  name: { anchor: "name", label: "Your name" },
  nationality: { anchor: "nationality_national", label: "Nationality" },
  country_of_origin: { anchor: "country_of_origin", label: "Country of origin" },
  id_number: { anchor: "id_number", label: "Identification number" },
  visit_type: { anchor: "visit_type_general_clinic", label: "Type of visit" },
  consultation_type: { anchor: "consultation_type_general", label: "Consultation type" },
  has_prescription: { anchor: "has_prescription_yes", label: "Prescription" },
};

function validate({
  name,
  nationality,
  country,
  idNumber,
  topLevelVisit,
  consultationType,
  hasPrescription,
}: {
  name: string;
  nationality: string;
  country: string;
  idNumber: string;
  topLevelVisit: string;
  consultationType: string;
  hasPrescription: string;
}): Partial<Record<FieldKey, string>> {
  const errors: Partial<Record<FieldKey, string>> = {};
  if (name.trim().length < 2) {
    errors.name = "Enter a name that is at least 2 characters.";
  }
  if (nationality !== "national" && nationality !== "non_national") {
    errors.nationality = "Tell us whether you are a national or non-national.";
  }
  if (nationality === "non_national" && !country) {
    errors.country_of_origin = "Choose your country of origin.";
  }
  if (!idNumber.trim()) {
    errors.id_number = "Enter your ID number.";
  }
  if (!topLevelVisit) {
    errors.visit_type = "Choose a type of visit.";
  }
  if (topLevelVisit === "general_clinic" && !consultationType) {
    errors.consultation_type = "Choose new consultation or follow-up.";
  }
  // Pharmacy is the only top-level whose downstream visit_type is
  // "pharmacy"; "other" and "general_clinic" sub-choices don't need a
  // prescription question.
  if (topLevelVisit === "pharmacy" && !hasPrescription) {
    errors.has_prescription = "Tell us about your prescription.";
  }
  return errors;
}

export function SignInForm({ kiosk }: Props) {
  const [pending, startTransition] = useTransition();
  // Nationality drives which ID-type controls are visible.
  const [nationality, setNationality] = useState<"" | "national" | "non_national">("");
  const [country, setCountry] = useState<string>("");
  // For non-nationals only. Nationals are forced to national_id.
  const [idType, setIdType] = useState<"national_id" | "passport">("national_id");
  const [name, setName] = useState("");
  const [idNumber, setIdNumber] = useState("");
  // topLevelVisit is the UI grouping (general_clinic | pharmacy | other).
  // consultationType is the sub-choice when General Clinic is picked. On
  // submit we collapse these to the underlying visit_type column.
  const [topLevelVisit, setTopLevelVisit] = useState<string>("");
  const [consultationType, setConsultationType] = useState<string>("");
  const [hasPrescription, setHasPrescription] = useState<string>("");
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [duplicateError, setDuplicateError] = useState<DuplicateError | null>(null);
  const [genericError, setGenericError] = useState<string | null>(null);
  const summaryRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (kiosk) localStorage.setItem("kiosk", "true");
  }, [kiosk]);

  function clearError(field: FieldKey) {
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
    setDuplicateError(null);
    setGenericError(null);
  }

  function onSubmit() {
    const fieldErrors = validate({
      name,
      nationality,
      country,
      idNumber,
      topLevelVisit,
      consultationType,
      hasPrescription,
    });
    setErrors(fieldErrors);
    setDuplicateError(null);
    setGenericError(null);

    if (Object.keys(fieldErrors).length > 0) {
      setTimeout(() => summaryRef.current?.focus(), 0);
      return;
    }

    // Nationals are always identified by Barbados National ID; non-nationals
    // pick between National ID and Passport.
    const effectiveIdType = nationality === "national" ? "national_id" : idType;

    // Collapse the UI grouping to the underlying visit_type column.
    // General Clinic forks on the consultation type sub-choice.
    const effectiveVisitType =
      topLevelVisit === "general_clinic"
        ? consultationType  // "general" | "follow-up"
        : topLevelVisit;     // "pharmacy" | "other"

    const fd = new FormData();
    fd.set("name", name.trim());
    fd.set("nationality", nationality);
    if (nationality === "non_national") fd.set("country_of_origin", country);
    fd.set("id_type", effectiveIdType);
    fd.set("id_number", idNumber.trim());
    fd.set("visit_type", effectiveVisitType);
    if (effectiveVisitType === "pharmacy") fd.set("has_prescription", hasPrescription);

    startTransition(async () => {
      try {
        await signInAction(fd);
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
        const message = err instanceof Error ? err.message : "Something went wrong";
        if (message.startsWith("DUPLICATE_ID:")) {
          setDuplicateError({ kind: "duplicate", idNumber: message.slice("DUPLICATE_ID:".length) });
          setTimeout(() => summaryRef.current?.focus(), 0);
          return;
        }
        const codeMap: Record<string, { field: FieldKey; msg: string }> = {
          NAME_TOO_SHORT: { field: "name", msg: "Enter a name that is at least 2 characters." },
          NATIONALITY_REQUIRED: { field: "nationality", msg: "Tell us whether you are a national or non-national." },
          COUNTRY_REQUIRED: { field: "country_of_origin", msg: "Choose your country of origin." },
          ID_NUMBER_REQUIRED: { field: "id_number", msg: "Enter your ID number." },
          ID_TYPE_INVALID: { field: "id_number", msg: "Choose a valid ID type." },
          VISIT_TYPE_INVALID: { field: "visit_type", msg: "Choose a type of visit." },
          CONSULTATION_TYPE_REQUIRED: { field: "consultation_type", msg: "Choose new consultation or follow-up." },
          PRESCRIPTION_REQUIRED: { field: "has_prescription", msg: "Tell us about your prescription." },
        };
        if (message in codeMap) {
          const { field, msg } = codeMap[message];
          setErrors({ [field]: msg });
          setTimeout(() => summaryRef.current?.focus(), 0);
          return;
        }
        setGenericError("Sorry, something went wrong. Please try again.");
      }
    });
  }

  function focusField(anchor: string) {
    const el = document.getElementById(anchor);
    if (!el) return;
    el.focus({ preventScroll: false });
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  const orderedErrorKeys: FieldKey[] = [
    "name",
    "nationality",
    "country_of_origin",
    "id_number",
    "visit_type",
    "consultation_type",
    "has_prescription",
  ];
  const visibleErrors = orderedErrorKeys.filter((k) => errors[k]);
  const showSummary = visibleErrors.length > 0 || duplicateError !== null || genericError !== null;

  // Helpful copy that adapts to which branch the user is on.
  const idNumberLabel =
    nationality === "national"
      ? "Your Barbados National ID number"
      : nationality === "non_national" && idType === "passport"
      ? "Your Passport number"
      : nationality === "non_national"
      ? "Your National ID number"
      : "ID number";
  const idNumberPlaceholder =
    nationality === "non_national" && idType === "passport" ? "e.g. A1234567" : "e.g. 1234567890";

  return (
    <form
      action={onSubmit}
      noValidate
      className="space-y-6"
      aria-describedby={showSummary ? "form-error-summary" : undefined}
    >
      {showSummary && (
        <div
          id="form-error-summary"
          ref={summaryRef}
          tabIndex={-1}
          role="alert"
          className="rounded-md border-l-4 border-red-600 bg-red-50 p-4"
        >
          <h2 className="text-base font-bold text-red-800">There is a problem</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-red-700">
            {visibleErrors.map((k) => (
              <li key={k}>
                <button
                  type="button"
                  onClick={() => focusField(FIELD_META[k].anchor)}
                  className="font-medium text-red-700 underline hover:text-red-900"
                >
                  {errors[k]}
                </button>
              </li>
            ))}
            {duplicateError && (
              <li>
                This ID number is already checked in today.{" "}
                <Link
                  href={`/lookup?q=${encodeURIComponent(duplicateError.idNumber)}`}
                  className="font-semibold underline hover:text-red-900"
                >
                  Find your place in the queue
                </Link>{" "}
                below.
              </li>
            )}
            {genericError && <li>{genericError}</li>}
          </ul>
        </div>
      )}

      <div>
        <label htmlFor="name" className="field-label">
          Your name
        </label>
        <input
          id="name"
          name="name"
          type="text"
          autoComplete="name"
          maxLength={120}
          className={`field-input ${errors.name ? "border-red-500" : ""}`}
          placeholder="e.g. Karen Williams"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            clearError("name");
          }}
          aria-invalid={!!errors.name}
          aria-describedby={errors.name ? "name-error" : undefined}
        />
        {errors.name && (
          <p id="name-error" className="mt-1 text-sm font-medium text-red-700">
            {errors.name}
          </p>
        )}
      </div>

      {/* Step 1 (per May 27 stakeholder feedback): nationality. Drives the
          rest of the identification questions. */}
      <fieldset>
        <legend className="field-label">Are you a Barbadian national?</legend>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <label className="flex cursor-pointer items-center gap-3 rounded-md border border-slate-300 px-4 py-3 text-base has-[:checked]:border-brand has-[:checked]:bg-brand-light">
            <input
              id="nationality_national"
              type="radio"
              name="nationality"
              value="national"
              checked={nationality === "national"}
              onChange={() => {
                setNationality("national");
                setIdType("national_id");
                setCountry("");
                clearError("nationality");
              }}
              className="h-5 w-5 shrink-0 accent-brand"
            />
            <span className="font-medium">National</span>
          </label>
          <label className="flex cursor-pointer items-center gap-3 rounded-md border border-slate-300 px-4 py-3 text-base has-[:checked]:border-brand has-[:checked]:bg-brand-light">
            <input
              id="nationality_non_national"
              type="radio"
              name="nationality"
              value="non_national"
              checked={nationality === "non_national"}
              onChange={() => {
                setNationality("non_national");
                clearError("nationality");
              }}
              className="h-5 w-5 shrink-0 accent-brand"
            />
            <span className="font-medium">Non-National</span>
          </label>
        </div>
        {errors.nationality && (
          <p className="mt-2 text-sm font-medium text-red-700">{errors.nationality}</p>
        )}
      </fieldset>

      {/* Non-National branch only: country of origin + ID type. */}
      {nationality === "non_national" && (
        <>
          <div>
            <label htmlFor="country_of_origin" className="field-label">
              Country of origin
            </label>
            <select
              id="country_of_origin"
              name="country_of_origin"
              className={`field-input ${errors.country_of_origin ? "border-red-500" : ""}`}
              value={country}
              onChange={(e) => {
                setCountry(e.target.value);
                clearError("country_of_origin");
              }}
              aria-invalid={!!errors.country_of_origin}
            >
              <option value="">Choose a country&hellip;</option>
              {COUNTRY_OPTIONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            {errors.country_of_origin && (
              <p className="mt-1 text-sm font-medium text-red-700">{errors.country_of_origin}</p>
            )}
          </div>

          <div>
            <span className="field-label block mb-2">Identification type</span>
            <div className="flex gap-3">
              <label className="flex cursor-pointer items-center gap-2 rounded-md border px-4 py-2.5 text-sm font-medium has-[:checked]:border-brand has-[:checked]:bg-brand-light border-slate-300">
                <input
                  type="radio"
                  name="id_type"
                  value="national_id"
                  checked={idType === "national_id"}
                  onChange={() => setIdType("national_id")}
                  className="h-4 w-4 accent-brand"
                />
                National ID
              </label>
              <label className="flex cursor-pointer items-center gap-2 rounded-md border px-4 py-2.5 text-sm font-medium has-[:checked]:border-brand has-[:checked]:bg-brand-light border-slate-300">
                <input
                  type="radio"
                  name="id_type"
                  value="passport"
                  checked={idType === "passport"}
                  onChange={() => setIdType("passport")}
                  className="h-4 w-4 accent-brand"
                />
                Passport
              </label>
            </div>
          </div>
        </>
      )}

      {/* ID number -- label adapts to the chosen branch. */}
      <div>
        <label htmlFor="id_number" className="field-label">
          {idNumberLabel}
        </label>
        <input
          id="id_number"
          name="id_number"
          type="text"
          maxLength={30}
          className={`field-input ${errors.id_number || duplicateError ? "border-red-500" : ""}`}
          placeholder={idNumberPlaceholder}
          value={idNumber}
          onChange={(e) => {
            setIdNumber(e.target.value);
            clearError("id_number");
          }}
          aria-invalid={!!errors.id_number || !!duplicateError}
          aria-describedby={errors.id_number ? "id_number-error" : undefined}
        />
        {errors.id_number && (
          <p id="id_number-error" className="mt-1 text-sm font-medium text-red-700">
            {errors.id_number}
          </p>
        )}
        {duplicateError && (
          <p className="mt-1 text-sm font-medium text-red-700">
            This ID number is already checked in today.{" "}
            <Link
              href={`/lookup?q=${encodeURIComponent(duplicateError.idNumber)}`}
              className="font-semibold underline hover:text-red-900"
            >
              Find your place in the queue
            </Link>{" "}
            below.
          </p>
        )}
      </div>

      <fieldset>
        <legend className="field-label">Type of visit</legend>
        <div className="mt-3 space-y-2">
          {TOP_LEVEL_VISITS.map((v) => (
            <label
              key={v.value}
              className="flex cursor-pointer items-start gap-3 rounded-md border border-slate-300 px-4 py-3 text-base has-[:checked]:border-brand has-[:checked]:bg-brand-light"
            >
              <input
                id={`visit_type_${v.value}`}
                type="radio"
                name="visit_type"
                value={v.value}
                checked={topLevelVisit === v.value}
                onChange={() => {
                  setTopLevelVisit(v.value);
                  // Reset the sub-choice when changing top-level branches.
                  if (v.value !== "general_clinic") setConsultationType("");
                  clearError("visit_type");
                  clearError("consultation_type");
                }}
                className="mt-0.5 h-5 w-5 shrink-0 accent-brand"
              />
              <span className="flex flex-col">
                <span className="font-medium">{v.label}</span>
                <span className="text-sm text-slate-500">{v.description}</span>
              </span>
            </label>
          ))}
        </div>
        {errors.visit_type && (
          <p className="mt-2 text-sm font-medium text-red-700">{errors.visit_type}</p>
        )}
      </fieldset>

      {topLevelVisit === "general_clinic" && (
        <fieldset>
          <legend className="field-label">Is this a new consultation or a follow-up?</legend>
          <div className="mt-3 space-y-2">
            {CONSULTATION_TYPES.map((opt) => (
              <label
                key={opt.value}
                className="flex cursor-pointer items-start gap-3 rounded-md border border-slate-300 px-4 py-3 text-base has-[:checked]:border-brand has-[:checked]:bg-brand-light"
              >
                <input
                  id={`consultation_type_${opt.value}`}
                  type="radio"
                  name="consultation_type"
                  value={opt.value}
                  checked={consultationType === opt.value}
                  onChange={() => {
                    setConsultationType(opt.value);
                    clearError("consultation_type");
                  }}
                  className="mt-0.5 h-5 w-5 shrink-0 accent-brand"
                />
                <span className="flex flex-col">
                  <span className="font-medium">{opt.label}</span>
                  <span className="text-sm text-slate-500">{opt.description}</span>
                </span>
              </label>
            ))}
          </div>
          {errors.consultation_type && (
            <p className="mt-2 text-sm font-medium text-red-700">{errors.consultation_type}</p>
          )}
        </fieldset>
      )}

      {topLevelVisit === "pharmacy" && (
        <fieldset>
          <legend className="field-label">Do you have a prescription?</legend>
          <div className="mt-3 space-y-2">
            {PRESCRIPTION_OPTIONS.map((opt, i) => (
              <label
                key={opt.value}
                className="flex cursor-pointer items-start gap-3 rounded-md border border-slate-300 px-4 py-3 text-base has-[:checked]:border-brand has-[:checked]:bg-brand-light"
              >
                <input
                  id={i === 0 ? "has_prescription_yes" : `has_prescription_${opt.value}`}
                  type="radio"
                  name="has_prescription"
                  value={opt.value}
                  checked={hasPrescription === opt.value}
                  onChange={() => {
                    setHasPrescription(opt.value);
                    clearError("has_prescription");
                  }}
                  className="mt-0.5 h-5 w-5 shrink-0 accent-brand"
                />
                <span className="flex flex-col">
                  <span className="font-medium">{opt.label}</span>
                  <span className="text-sm text-slate-500">{opt.description}</span>
                </span>
              </label>
            ))}
          </div>
          {errors.has_prescription && (
            <p className="mt-2 text-sm font-medium text-red-700">{errors.has_prescription}</p>
          )}
        </fieldset>
      )}

      <button type="submit" className="btn-primary w-full text-lg" disabled={pending}>
        {pending ? "Checking in..." : "Check in"}
      </button>

      <div className="mt-4 text-center">
        <Link
          href="/lookup"
          className="block w-full text-sm font-semibold text-brand hover:underline"
        >
          Already checked in? Find my place in queue →
        </Link>
      </div>
    </form>
  );
}
