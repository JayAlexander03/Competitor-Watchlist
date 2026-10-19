import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createSessionToken,
  isAuthConfigured,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from "@/lib/auth";

const LoginBody = z.object({
  password: z.string().min(1).max(1000),
});

const RATE_LIMIT_MAX_FAILURES = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

interface AttemptRecord {
  count: number;
  resetAt: number;
}

// Per-process fallback limiter. Hosting-level rate limiting is still advised.
const attempts = new Map<string, AttemptRecord>();

function clientKey(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

function currentRecord(key: string): AttemptRecord | null {
  const record = attempts.get(key);
  if (!record) return null;
  if (record.resetAt <= Date.now()) {
    attempts.delete(key);
    return null;
  }
  return record;
}

function sweepExpired(): void {
  if (attempts.size < 500) return;
  const now = Date.now();
  for (const [key, record] of attempts) {
    if (record.resetAt <= now) attempts.delete(key);
  }
}

function recordFailure(key: string): void {
  sweepExpired();
  const record = currentRecord(key);
  if (!record) {
    attempts.set(key, {
      count: 1,
      resetAt: Date.now() + RATE_LIMIT_WINDOW_MS,
    });
    return;
  }
  record.count += 1;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time comparison over fixed-length SHA-256 digests. */
function passwordsMatch(candidate: string, expected: string): boolean {
  return timingSafeEqual(sha256(candidate), sha256(expected));
}

export async function POST(req: Request) {
  if (!isAuthConfigured()) {
    return Response.json(
      { error: "Authentication is not configured" },
      { status: 503 },
    );
  }

  const key = clientKey(req);
  const record = currentRecord(key);
  if (record && record.count >= RATE_LIMIT_MAX_FAILURES) {
    const retryAfter = Math.max(
      1,
      Math.ceil((record.resetAt - Date.now()) / 1000),
    );
    return Response.json(
      { error: "Too many failed attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = LoginBody.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const expected = process.env.APP_PASSWORD?.trim() ?? "";
  if (!passwordsMatch(parsed.data.password, expected)) {
    recordFailure(key);
    return Response.json({ error: "Invalid password" }, { status: 401 });
  }

  attempts.delete(key);

  let token: string;
  try {
    token = await createSessionToken();
  } catch (err) {
    console.error("POST /api/auth/login failed to create session", err);
    return Response.json(
      { error: "Authentication is not configured" },
      { status: 503 },
    );
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return response;
}
