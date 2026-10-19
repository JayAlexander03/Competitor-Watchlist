import type { NextRequest } from "next/server";

export const SESSION_COOKIE = "watchlist_session";

/** 30 days, in seconds. */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

const encoder = new TextEncoder();

/** True when an app password has been configured. */
export function isAuthConfigured(): boolean {
  return Boolean(process.env.APP_PASSWORD?.trim());
}

/**
 * Session signing key. Prefers AUTH_SECRET so sessions can be rotated
 * independently of the login password; falls back to APP_PASSWORD.
 */
function getSecret(): string | null {
  return process.env.AUTH_SECRET?.trim() || process.env.APP_PASSWORD?.trim() || null;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function sign(payloadSegment: string, secret: string): Promise<Uint8Array> {
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payloadSegment),
  );
  return new Uint8Array(signature);
}

/** Create a signed session token: `<base64url(payload)>.<base64url(hmacSha256)>`. */
export async function createSessionToken(): Promise<string> {
  const secret = getSecret();
  if (!secret) {
    throw new Error("Authentication is not configured");
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({
    exp: now + SESSION_TTL_SECONDS,
    iat: now,
  });
  const payloadSegment = bytesToBase64Url(encoder.encode(payload));
  const signature = await sign(payloadSegment, secret);
  return `${payloadSegment}.${bytesToBase64Url(signature)}`;
}

/** Verify a session token's signature and expiry. Never throws. */
export async function verifySessionToken(
  token?: string | null,
): Promise<boolean> {
  if (typeof token !== "string" || token.length === 0 || token.length > 4096) {
    return false;
  }

  const secret = getSecret();
  if (!secret) return false;

  const parts = token.split(".");
  if (parts.length !== 2) return false;

  const [payloadSegment, signatureSegment] = parts;
  if (!payloadSegment || !signatureSegment) return false;

  try {
    const signatureBytes = base64UrlToBytes(signatureSegment);
    const signature = new Uint8Array(signatureBytes).buffer;
    const key = await importHmacKey(secret);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      encoder.encode(payloadSegment),
    );
    if (!valid) return false;

    const payload = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(payloadSegment)),
    ) as unknown;
    if (!payload || typeof payload !== "object") return false;

    const { exp, iat } = payload as { exp?: unknown; iat?: unknown };
    if (typeof exp !== "number" || !Number.isFinite(exp)) return false;
    if (typeof iat !== "number" || !Number.isFinite(iat)) return false;
    if (exp <= Math.floor(Date.now() / 1000)) return false;

    return true;
  } catch {
    return false;
  }
}

/** Read the session cookie from a request and verify it. */
export async function isAuthenticated(request: NextRequest): Promise<boolean> {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  return verifySessionToken(token);
}
