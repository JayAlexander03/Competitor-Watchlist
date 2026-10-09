import {
  checkCronAuth,
  runRefreshCheck,
} from "../../watchlist/refresh/route";

/**
 * GET /api/cron/check — same handler as POST /api/watchlist/refresh,
 * for Windows Task Scheduler `curl` and future Vercel Cron.
 * Supports `Authorization: Bearer $CRON_SECRET` when CRON_SECRET is set.
 */
export async function GET(req: Request) {
  const unauthorized = checkCronAuth(req);
  if (unauthorized) return unauthorized;
  try {
    const summary = await runRefreshCheck();
    return Response.json(summary);
  } catch (err) {
    console.error("GET /api/cron/check failed", err);
    return Response.json(
      { error: "Scheduled check failed" },
      { status: 500 },
    );
  }
}
