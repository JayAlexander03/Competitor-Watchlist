import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isAuthenticated, isAuthConfigured } from "@/lib/auth";

const STATIC_FILE_RE = /\.[^/]+$/;

function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname === "/api/cron/check" ||
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/_next/") ||
    STATIC_FILE_RE.test(pathname)
  );
}

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/** Optimistic gate only — handlers re-verify with requireApiAuth(). */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  if (!isAuthConfigured()) {
    if (process.env.NODE_ENV === "production") {
      if (isApiPath(pathname)) {
        return NextResponse.json(
          { error: "Authentication is not configured" },
          { status: 503 },
        );
      }
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = "/login";
      loginUrl.search = "";
      loginUrl.searchParams.set("error", "config");
      return NextResponse.redirect(loginUrl);
    }
    return NextResponse.next();
  }

  if (await isAuthenticated(request)) {
    return NextResponse.next();
  }

  if (isApiPath(pathname)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  loginUrl.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    /*
     * Match everything except Next.js internals, the favicon, and static
     * files (anything with a file extension).
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)",
  ],
};
