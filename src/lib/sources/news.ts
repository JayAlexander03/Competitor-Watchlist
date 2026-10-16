import type { Release } from "../types";
import { fetchTextWithTimeout, parseFeedReleases } from "./company";

// NOTE: This module runs in Route Handlers (always live fetch). It must NOT use
// `use cache` (cacheComponents is on) — every call hits the network.

const MIN_TIER_ITEMS = 3;
const TRACKING_PARAMS = /^(utm_.*|fbclid|gclid|msclkid)$/i;

function buildGoogleUrl(query: string): string {
  return (
    `https://news.google.com/rss/search?q=${encodeURIComponent(query)}` +
    `&hl=en-US&gl=CA&ceid=CA:en`
  );
}

function normalizeTitle(title: string): string {
  return (title ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    // Lowercase host (URL normalizes this); strip tracking params only —
    // keep all other query params so article IDs still distinguish items.
    const params = new URLSearchParams();
    const keys = [...u.searchParams.keys()].sort();
    for (const k of keys) {
      if (TRACKING_PARAMS.test(k)) continue;
      for (const v of u.searchParams.getAll(k)) params.append(k, v);
    }
    const qs = params.toString();
    let path = u.pathname;
    if (path.length > 1) path = path.replace(/\/+$/, "");
    return `${u.protocol}//${u.host.toLowerCase()}${path}${qs ? `?${qs}` : ""}`;
  } catch {
    return (raw ?? "").trim();
  }
}

const CORPORATE_STOP = new Set([
  "corp",
  "corporation",
  "inc",
  "incorporated",
  "ltd",
  "limited",
  "plc",
  "llc",
  "lp",
  "llp",
  "co",
  "company",
  "enterprises",
  "enterprise",
  "holdings",
  "group",
  "ventures",
  "venture",
  "partners",
  "partnership",
  "international",
  "intl",
]);

function significantTokens(text: string): string[] {
  return (text ?? "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .filter((t) => !CORPORATE_STOP.has(t.toLowerCase()));
}

function coreTokenQuery(company: string, project: string): string {
  const coTokens = significantTokens(company);
  const out = coTokens.slice(0, 3);
  if (out.length < 2) {
    for (const t of significantTokens(project)) {
      if (out.length >= 3) break;
      out.push(t);
    }
  }
  return out.join(" ");
}

function dedupeReleases(items: Release[]): Release[] {
  const seenTitles = new Set<string>();
  const seenKeys = new Set<string>();
  const out: Release[] = [];
  for (const item of items) {
    const nt = normalizeTitle(item.title);
    const nu = normalizeUrl(item.url);
    // Collapse cross-outlet dupes (news.google.com redirect IDs differ per
    // outlet): same normalized title keeps the first, regardless of URL.
    if (nt && seenTitles.has(nt)) continue;
    // Otherwise dedupe on URL+title so distinct stories are preserved and
    // article-ID query params still distinguish items.
    const key = `${nu}|${nt}`;
    if (seenKeys.has(key)) continue;
    if (nt) seenTitles.add(nt);
    seenKeys.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Fetch news headlines for a company+project pair.
 * Tiered Google News RSS (max 3 sequential queries, early-exit at >=3 merged
 * unique items), then Bing News RSS fallback. Never throws — [] on failure.
 */
export async function fetchNewsReleases(
  company: string,
  project: string,
  limit = 10,
): Promise<Release[]> {
  try {
    const safeLimit = Math.min(Math.max(limit, 1), 25);
    const now = new Date().toISOString();
    const co = (company ?? "").trim();
    const pr = (project ?? "").trim();
    if (!co && !pr) return [];

    // Tiered Google queries (sequential, early-exit once we have enough).
    const queries: string[] = [`"${co}" "${pr}"`];
    if (pr) queries.push(`"${co}" ${pr}`);
    else queries.push(`"${co}"`);
    const core = coreTokenQuery(co, pr);
    if (core) queries.push(core);

    const merged: Release[] = [];
    const googleQueries = queries.slice(0, 3);
    for (const q of googleQueries) {
      if (dedupeReleases(merged).length >= MIN_TIER_ITEMS) break;
      const url = buildGoogleUrl(q);
      const xml = await fetchTextWithTimeout(url);
      if (!xml) continue;
      merged.push(...parseFeedReleases(xml, url, "news", safeLimit, now));
    }

    let unique = dedupeReleases(merged);
    if (unique.length >= MIN_TIER_ITEMS) return unique.slice(0, safeLimit);

    // Fallback: Bing News RSS (unquoted).
    try {
      const bingUrl =
        `https://www.bing.com/news/search?q=${encodeURIComponent(`${co} ${pr}`.trim())}` +
        `&format=rss`;
      const bingXml = await fetchTextWithTimeout(bingUrl);
      if (bingXml) {
        merged.push(
          ...parseFeedReleases(bingXml, bingUrl, "news", safeLimit, now),
        );
        unique = dedupeReleases(merged);
      }
    } catch {
      // Ignore Bing failures — still return Google hits below.
    }

    return unique.slice(0, safeLimit);
  } catch {
    return [];
  }
}
