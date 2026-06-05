import Link from "next/link";
import { SignInForm } from "@/components/SignInForm";
import { PoweredBy } from "@/components/PoweredBy";

interface Props {
  searchParams?: { kiosk?: string };
}

export default function HomePage({ searchParams }: Props) {
  const kiosk = searchParams?.kiosk === "true";

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col px-6 py-10">
      <header className="mb-8">
        <p className="text-sm font-semibold uppercase tracking-wide text-brand">
          St Thomas Outpatient Clinic
        </p>
        <h1 className="mt-2 text-3xl font-bold leading-tight">Check in for your visit</h1>
        <p className="mt-3 text-slate-600">
          Enter your name and the type of your visit to join the queue. You can find
          your place again at any time using your ID number or reference code.
        </p>
        {/* KK1: surface "already checked in?" near the top so a
            returning patient doesn't fill the whole form before
            seeing the recovery option. Mirrors the inline link at
            the bottom; /lookup has its own "Not checked in yet?
            Check in here" link if they tap by mistake. */}
        <p className="mt-4 rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-700">
          Already checked in today?{" "}
          <Link href="/lookup" className="font-semibold text-brand hover:underline">
            Find my place in queue →
          </Link>
        </p>
      </header>

      <SignInForm kiosk={kiosk} />

      <footer className="mt-12 text-center text-xs text-slate-500">
        Your name is only shown to clinic staff. The waiting-room display shows your
        initials only.
      </footer>

      <PoweredBy className="mt-8" />
    </main>
  );
}
