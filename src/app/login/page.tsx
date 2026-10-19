import type { Metadata } from "next";
import { Suspense } from "react";
import LoginForm from "@/components/LoginForm";

export const metadata: Metadata = {
  title: "Sign in · Competitor Watchlist",
  description: "Sign in to the competitor watchlist.",
};

function LoginFormSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden="true">
      <div className="h-4 w-20 rounded bg-[#efefef]" />
      <div className="h-9 w-full rounded-md border border-[#ededed] bg-[#fafafa]" />
      <div className="h-9 w-full rounded-md bg-[#efefef]" />
    </div>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-full flex-1 items-center justify-center bg-white px-6 py-16 font-sans text-[#171717]">
      <div className="w-full max-w-sm">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-[#707070]">
          Competitor Watchlist
        </p>
        <h1 className="mt-2 text-3xl font-medium tracking-tight">Sign in</h1>
        <p className="mt-2 text-sm text-[#707070]">
          Enter the shared access password to continue.
        </p>

        <div className="mt-8 rounded-xl border border-[#dfdfdf] bg-white p-6">
          <Suspense fallback={<LoginFormSkeleton />}>
            <LoginForm />
          </Suspense>
        </div>

        <p className="mt-6 text-center text-xs text-[#9a9a9a]">
          Sessions last 30 days. Contact the administrator if you do not have the
          password.
        </p>
      </div>
    </main>
  );
}
