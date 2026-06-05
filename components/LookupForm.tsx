"use client";

import { useEffect, useState, useTransition } from "react";
import { lookupPatientAction } from "@/app/actions";

interface Props {
  /** Pre-populated value (e.g. when redirected from a duplicate-ID error). */
  initialQuery?: string;
}

export function LookupForm({ initialQuery = "" }: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Keep state in sync if the URL query param changes (e.g. browser back).
  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  function onSubmit() {
    setError(null);
    const trimmed = query.trim();
    if (!trimmed) {
      // JJ2: lookup is by ID number OR reference code only — name is
      // off the table because common surnames mean a name match could
      // route the wrong person to someone else's queue page.
      setError("Enter your ID number or reference code.");
      return;
    }
    const fd = new FormData();
    fd.set("q", trimmed);
    startTransition(async () => {
      try {
        await lookupPatientAction(fd);
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
        if (message === "LOOKUP_EMPTY") {
          setError("Enter your ID number or reference code.");
        } else if (message === "LOOKUP_NOT_FOUND") {
          setError(
            "We could not find an active queue entry matching that ID number or reference code. Check what you entered and try again, or speak to a member of staff.",
          );
        } else {
          setError("Sorry, something went wrong. Please try again.");
        }
      }
    });
  }

  return (
    <form action={onSubmit} noValidate className="space-y-5">
      <div>
        <label htmlFor="q" className="field-label">
          Your ID number or reference code
        </label>
        <input
          id="q"
          name="q"
          type="text"
          maxLength={120}
          className={`field-input ${error ? "border-red-500" : ""}`}
          placeholder="e.g. 1234567890 or X6AU"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (error) setError(null);
          }}
          aria-invalid={!!error}
          aria-describedby={error ? "q-error" : undefined}
          autoFocus
        />
        {error && (
          <p id="q-error" role="alert" className="mt-1 text-sm font-medium text-red-700">
            {error}
          </p>
        )}
      </div>

      <button type="submit" className="btn-primary w-full text-lg" disabled={pending}>
        {pending ? "Looking up…" : "Find my place"}
      </button>
    </form>
  );
}
