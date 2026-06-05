import Link from "next/link";
import { LookupForm } from "@/components/LookupForm";
import { PoweredBy } from "@/components/PoweredBy";

interface Props {
  searchParams?: { q?: string };
}

export default function LookupPage({ searchParams }: Props) {
  const initialQuery = (searchParams?.q ?? "").toString();
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col px-6 py-10">
      <header className="mb-8">
        <p className="text-sm font-semibold uppercase tracking-wide text-brand">
          St Thomas Outpatient Clinic
        </p>
        <h1 className="mt-2 text-3xl font-bold leading-tight">Find my place in queue</h1>
        <p className="mt-3 text-slate-600">
          Enter your ID number or reference code and we&apos;ll show you your
          place in the queue.
        </p>
      </header>

      <LookupForm initialQuery={initialQuery} />

      <p className="mt-6 text-center text-sm text-slate-500">
        Not checked in yet?{" "}
        <Link href="/" className="font-semibold text-brand hover:underline">
          Check in here
        </Link>
      </p>

      <PoweredBy className="mt-12" />
    </main>
  );
}
