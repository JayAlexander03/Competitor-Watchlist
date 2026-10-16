import { checkProjectReleases, remapFreshToStored } from "@/lib/checker";
import { collapseDeterministic } from "@/lib/collapse";
import { store } from "@/lib/store";
import type { Release } from "@/lib/types";

export interface RefreshNewItem {
  itemId: string;
  company: string;
  project: string;
  release: Release;
}

export interface RefreshSummary {
  checked: number;
  newCount: number;
  newItems: RefreshNewItem[];
}

/** Optional shared-secret gate: enforced only when CRON_SECRET is set. */
export function checkCronAuth(req: Request): Response | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null;
  if (req.headers.get("authorization") === `Bearer ${secret}`) return null;
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

/**
 * Core daily-check logic shared by POST /api/watchlist/refresh and
 * GET /api/cron/check. Per watch item: run the release pipeline,
 * diff fresh releases against stored ones by id (unseen id = new),
 * persist the merged list, stamp lastCheckedAt, then record the
 * notifications lastCheck + one sentLog entry per new release.
 * No email is sent here — the notify route / UI sends the digest.
 */
export async function runRefreshCheck(): Promise<RefreshSummary> {
  const items = await store.listWatchItems();
  const notifications = await store.getNotifications();
  const recipients = notifications.recipients ?? [];
  const newItems: RefreshNewItem[] = [];

  for (const item of items) {
    let fresh: Release[];
    try {
      fresh = await checkProjectReleases(
        {
          company: item.company,
          project: item.project,
          pressUrl: item.pressUrl ?? undefined,
        },
        { limit: 20 },
      );
    } catch (err) {
      console.error(
        `refresh: check failed for ${item.company} / ${item.project}`,
        err,
      );
      continue;
    }

    fresh = remapFreshToStored(fresh, item.releases);
    const seenIds = new Set(item.releases.map((r) => r.id));
    const unseen = fresh.filter((r) => !seenIds.has(r.id));
    const freshById = new Map(fresh.map((r) => [r.id, r] as const));
    let merged = [
      ...unseen,
      ...item.releases.map((s) => freshById.get(s.id) ?? s),
    ];
    merged = collapseDeterministic(merged);
    await store.saveReleases(item.id, merged);
    await store.touchChecked(item.id);

    for (const release of unseen) {
      newItems.push({
        itemId: item.id,
        company: item.company,
        project: item.project,
        release,
      });
    }
  }

  const checkedAt = new Date().toISOString();
  await store.setLastCheck(checkedAt, {
    checked: items.length,
    newCount: newItems.length,
  });

  for (const n of newItems) {
    await store.appendSentLog({
      releaseId: n.release.id,
      to: recipients,
      sentAt: checkedAt,
    });
  }

  return { checked: items.length, newCount: newItems.length, newItems };
}

export async function POST(req: Request) {
  const unauthorized = checkCronAuth(req);
  if (unauthorized) return unauthorized;
  try {
    const summary = await runRefreshCheck();
    return Response.json(summary);
  } catch (err) {
    console.error("POST /api/watchlist/refresh failed", err);
    return Response.json({ error: "Refresh failed" }, { status: 500 });
  }
}
