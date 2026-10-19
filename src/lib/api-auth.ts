import { cookies } from "next/headers";
import {
  isAuthConfigured,
  SESSION_COOKIE,
  verifySessionToken,
} from "@/lib/auth";

/**
 * Defense-in-depth auth check for Route Handlers. Proxy is only an
 * optimistic gate; every protected handler re-validates the session.
 *
 * Returns a Response to send when the request is not authorized,
 * or null when the caller may proceed.
 */
export async function requireApiAuth(): Promise<Response | null> {
  if (!isAuthConfigured()) {
    if (process.env.NODE_ENV === "production") {
      return Response.json(
        { error: "Authentication is not configured" },
        { status: 503 },
      );
    }
    return null;
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!(await verifySessionToken(token))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}
