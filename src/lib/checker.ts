import { createHash } from "node:crypto";
import type { Release } from "./types";
import { fetchCompanyReleases } from "./sources/company";
import { fetchNewsReleases } from "./sources/news";
import { buildSedarLinks } from "./sources/sedar";
import { filterRelevant } from "./relevance";

// NOTE: This module runs in Route Handlers (always live fetch). It must NOT
// use `use cache` (cacheComponents is on).

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Format a Date (or date string) as DD-MMM-YYYY, e.g. 09-Oct-2026. */
export function formatDateDDMMMYYYY(d: Date | string): string {
  const dt = d instanceof Date ? d : new Date(d);
  const safe = Number.isNaN(dt.getTime()) ? new Date() : dt;
  return `${String(safe.getUTCDate()).padStart(2, "0")}-${MONTHS[safe.getUTCMonth()]}-${safe.getUTCFullYear()}`;
}

/**
 * Normalize a URL for dedupe: lowercase host, drop fragment, strip
 * tracking params (utm tags, fbclid, gclid, msclkid), drop trailing slashes.
 */
export function normalizeUrl(raw: string): string {
  const trimmed = (raw ?? "").trim();
  try {
    const u = new URL(trimmed);
    u.hash = "";
    const params = new URLSearchParams(u.search);
    for (const key of Array.from(params.keys())) {
      const k = key.toLowerCase();
      if (
        k.startsWith("utm_") ||
        k === "fbclid" ||
        k === "gclid" ||
        k === "msclkid"
      ) {
        params.delete(key);
      }
    }
    const qs = params.toString();
    u.search = qs ? `?${qs}` : "";
    u.hostname = u.hostname.toLowerCase();
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return trimmed.toLowerCase();
    }
    return u.toString().replace(/\/+$/, "");
  } catch {
    return trimmed.split("#")[0].replace(/\/+$/, "").toLowerCase();
  }
}

/** Stable release id: sha256 hex of normalized-url | lowercased title | date. */
export function releaseId(url: string, title: string, date: string): string {
  return createHash("sha256")
    .update(
      `${normalizeUrl(url)}|${(title ?? "").trim().toLowerCase()}|${(date ?? "").trim()}`,
    )
    .digest("hex");
}

/** Dedupe releases by normalized URL (first occurrence wins). */
export function dedupeReleases(items: Release[]): Release[] {
  const seen = new Map<string, Release>();
  for (const r of items) {
    const key = r.url
      ? normalizeUrl(r.url)
      : `hash:${r.hash || releaseId("", r.title, r.date)}`;
    if (!seen.has(key)) seen.set(key, r);
  }
  return [...seen.values()];
}

const MONTH_IDX: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/** Sort key for a DD-MMM-YYYY date (falls back to firstSeenAt). */
function dateScore(r: Release): number {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec((r.date ?? "").trim());
  if (m) {
    const mi = MONTH_IDX[m[2].toLowerCase()];
    if (mi !== undefined) return Date.UTC(Number(m[3]), mi, Number(m[1]));
  }
  const t = Date.parse(r.firstSeenAt ?? "");
  return Number.isNaN(t) ? 0 : t;
}

export interface CheckProjectInput {
  company: string;
  project: string;
  pressUrl?: string;
}

export interface CheckProjectOptions {
  limit?: number;
}

/**
 * Full per-project pipeline: company sources + news + SEDAR link-out
 * (Promise.allSettled) → dedupe by normalized URL → canonical ids →
 * prefilter + AI relevance filter → sort newest-first → slice to limit.
 * Never throws — returns [] on total failure.
 */
export async function checkProjectReleases(
  item: CheckProjectInput,
  limitOrOpts?: number | CheckProjectOptions,
): Promise<Release[]> {
  try {
    const rawLimit =
      typeof limitOrOpts === "number"
        ? limitOrOpts
        : (limitOrOpts?.limit ?? 20);
    const safeLimit = Math.min(Math.max(rawLimit, 1), 50);
    const settled = await Promise.allSettled([
      fetchCompanyReleases(item.company, item.pressUrl, safeLimit),
      fetchNewsReleases(item.company, item.project, safeLimit),
    ]);
    const companyHits =
      settled[0].status === "fulfilled" ? settled[0].value : [];
    const newsHits = settled[1].status === "fulfilled" ? settled[1].value : [];
    let sedarHits: Release[] = [];
    try {
      sedarHits = buildSedarLinks(item.company);
    } catch {
      sedarHits = [];
    }

    const merged = dedupeReleases([...companyHits, ...newsHits, ...sedarHits]);
    for (const r of merged) {
      r.id = releaseId(r.url, r.title, r.date);
      if (!r.hash) {
        r.hash = createHash("sha256")
          .update(`${r.title}|${r.url}|${r.date}`)
          .digest("hex");
      }
      if (!r.firstSeenAt) r.firstSeenAt = new Date().toISOString();
    }

    const relevant = await filterRelevant(merged, item.company, item.project);
    return relevant
      .sort((a, b) => dateScore(b) - dateScore(a))
      .slice(0, safeLimit);
  } catch {
    return [];
  }
}
