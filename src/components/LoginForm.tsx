"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";

/** Only allow same-origin, absolute-path redirects. */
function safeNextPath(value: string | null): string {
  if (!value) return "/";
  // Reject protocol-relative and backslash-normalized variants.
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return "/";
  }
  return value;
}

export default function LoginForm() {
  const searchParams = useSearchParams();
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const configError = searchParams.get("error") === "config";
  const nextPath = safeNextPath(searchParams.get("next"));

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!password) {
      setError("Enter the access password.");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (json as { error?: string }).error ??
            `Sign in failed (${res.status}).`
        );
      }
      window.location.assign(nextPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed.");
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      {configError && (
        <div
          role="alert"
          className="rounded-lg border border-[#dfdfdf] bg-[#fafafa] p-4"
        >
          <p className="text-sm font-medium text-[#171717]">
            Authentication is not configured
          </p>
          <p className="mt-1 text-sm text-[#707070]">
            Set <code className="font-mono text-[13px]">APP_PASSWORD</code> in the
            environment to enable sign-in.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <label
          htmlFor="password"
          className="text-sm font-medium text-[#171717]"
        >
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={loading}
          placeholder="Enter access password"
          className="rounded-md border border-[#dfdfdf] bg-white px-3 py-2 text-sm text-[#171717] placeholder:text-[#b2b2b2] focus:border-[#3ecf8e] focus:outline-none disabled:opacity-50"
        />
      </div>

      {error && (
        <p role="alert" className="text-sm text-[#e2005a]">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={loading}
        className="rounded-md bg-[#3ecf8e] px-4 py-2 text-sm font-medium text-[#171717] hover:bg-[#24b47e] disabled:opacity-50"
      >
        {loading ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
