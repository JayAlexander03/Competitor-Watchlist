import type { Release } from "../types";

// NOTE: This module runs in Route Handlers (always live fetch). It must NOT use
// `use cache` (cacheComponents is on) — every call hits the network.

const FETCH_TIMEOUT_MS = 10_000;
const MAX_SITEMAP_PAGES = 10;

export const REQUEST_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (compatible; CompetitorWatchlist/1.0; +https://github.com/)",
  Accept:
    "application/rss+xml, application/atom+xml, application/xml, text/html, */*",
};

/** Native fetch with a 10s timeout. Never throws — returns null on any failure. */
export async function fetchTextWithTimeout(
  url: string,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: REQUEST_HEADERS,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function stripToText(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

function allCaptures(text: string, re: RegExp): string[] {
  const out: string[] = [];
  const rx = new RegExp(
    re.source,
    re.flags.includes("g") ? re.flags : `${re.flags}g`,
  );
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text)) !== null) out.push(m[1]);
  return out;
}

/** Format a date (or date string) as DD-MMM-YYYY, e.g. 09-Oct-2026. */
export function toDDMMMYYYY(
  value: string | undefined | null,
  fallback: Date = new Date(),
): string {
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
  let d = fallback;
  if (value) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) d = parsed;
  }
  return `${String(d.getUTCDate()).padStart(2, "0")}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

function isFeedXml(text: string): boolean {
  const head = text.slice(0, 2000).toLowerCase();
  return (
    head.includes("<rss") || head.includes("<feed") || head.includes("<rdf")
  );
}

function resolveUrl(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function safeOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * Parse an RSS 2.0 / Atom feed via regex (<item> / <entry> blocks).
 * Shared by company.ts and news.ts. Never throws.
 */
export function parseFeedReleases(
  xml: string,
  baseUrl: string,
  source: Release["source"],
  limit: number,
  firstSeenAt: string,
): Release[] {
  try {
    const blocks = [
      ...allCaptures(xml, /<item[\s>]([\s\S]*?)<\/item>/gi),
      ...allCaptures(xml, /<entry[\s>]([\s\S]*?)<\/entry>/gi),
    ];
    const out: Release[] = [];
    for (const block of blocks) {
      if (out.length >= limit) break;
      const titleRaw =
        /<title[^>]*>([\s\S]*?)<\/title>/i.exec(block)?.[1] ?? "";
      const title = stripToText(titleRaw);
      if (!title) continue;
      const linkRaw =
        /<link[^>]*href=["']([^"']+)["']/i.exec(block)?.[1] ??
        /<link[^>]*>([\s\S]*?)<\/link>/i.exec(block)?.[1] ??
        /<guid[^>]*>([\s\S]*?)<\/guid>/i.exec(block)?.[1] ??
        "";
      const url = linkRaw
        ? resolveUrl(stripToText(linkRaw), baseUrl)
        : null;
      if (!url) continue;
      const dateRaw =
        /<(pubdate|published|updated|dc:date)[^>]*>([\s\S]*?)<\/\1>/i.exec(
          block,
        )?.[2];
      out.push({
        id: url,
        source,
        title: title.slice(0, 300),
        url,
        date: toDDMMMYYYY(dateRaw ? stripToText(dateRaw) : null),
        hash: "",
        firstSeenAt,
      });
    }
    return out;
  } catch {
    return [];
  }
}

const URL_KEYWORDS = /news|press|release|investor|media|announcement/i;

function extractArticleMeta(html: string): {
  title: string | null;
  date: string | null;
} {
  const og =
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(
      html,
    )?.[1] ??
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i.exec(
      html,
    )?.[1];
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const title = stripToText(og ?? titleTag ?? "") || null;
  const dateRaw =
    /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i.exec(
      html,
    )?.[1] ??
    /<meta[^>]+itemprop=["']datePublished["'][^>]+content=["']([^"']+)["']/i.exec(
      html,
    )?.[1] ??
    /<time[^>]+datetime=["']([^"']+)["']/i.exec(html)?.[1] ??
    /"datePublished"\s*:\s*"([^"]+)"/i.exec(html)?.[1];
  return { title, date: dateRaw ? toDDMMMYYYY(stripToText(dateRaw)) : null };
}

async function fetchViaSitemap(
  origin: string,
  limit: number,
  now: string,
): Promise<Release[]> {
  const indexXml = await fetchTextWithTimeout(`${origin}/sitemap.xml`);
  if (!indexXml) return [];
  let locs = allCaptures(indexXml, /<loc[^>]*>([\s\S]*?)<\/loc>/gi)
    .map(stripToText)
    .filter(Boolean);
  if (/<sitemapindex[\s>]/i.test(indexXml)) {
    // Sitemap index: drill into nested sitemaps that look news-related.
    const nested = [...new Set(locs)]
      .filter((u) => URL_KEYWORDS.test(u))
      .slice(0, 2);
    const settled = await Promise.allSettled(
      nested.map((u) => fetchTextWithTimeout(u)),
    );
    locs = [];
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value) {
        locs.push(
          ...allCaptures(s.value, /<loc[^>]*>([\s\S]*?)<\/loc>/gi).map(
            stripToText,
          ),
        );
      }
    }
  }
  const targets = [...new Set(locs)]
    .map((u) => stripToText(u))
    .filter((u) => /^https?:\/\//i.test(u) && URL_KEYWORDS.test(u))
    .slice(0, Math.min(Math.max(limit, 1), MAX_SITEMAP_PAGES));
  const settled = await Promise.allSettled(
    targets.map((u) => fetchTextWithTimeout(u)),
  );
  const out: Release[] = [];
  settled.forEach((s, i) => {
    if (s.status !== "fulfilled" || !s.value) return;
    const meta = extractArticleMeta(s.value);
    if (!meta.title) return;
    out.push({
      id: targets[i],
      source: "company",
      title: meta.title.slice(0, 300),
      url: targets[i],
      date: meta.date ?? toDDMMMYYYY(null),
      hash: "",
      firstSeenAt: now,
    });
  });
  return out.slice(0, limit);
}

const LIST_KEYWORDS =
  /news|press|release|announcement|drill|assay|discover|resource|feasib|prefeasib|permit|acqui|merger|financ|explor|intercept|investor|update/i;

function parseHtmlList(
  html: string,
  base: string,
  limit: number,
  now: string,
): Release[] {
  const out: Release[] = [];
  try {
    const seen = new Set<string>();
    const rx = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(html)) !== null && out.length < limit) {
      const url = resolveUrl(stripToText(m[1]), base);
      if (!url || seen.has(url)) continue;
      const title = stripToText(m[2]);
      if (title.length < 15 || title.length > 300) continue;
      if (!LIST_KEYWORDS.test(url) && !LIST_KEYWORDS.test(title)) continue;
      seen.add(url);
      out.push({
        id: url,
        source: "company",
        title,
        url,
        date: toDDMMMYYYY(null),
        hash: "",
        firstSeenAt: now,
      });
    }
  } catch {
    return out;
  }
  return out;
}

/**
 * Fetch press/news releases from a company's own site.
 * Strategy: pressUrl as RSS/Atom → sitemap.xml discovery → HTML list fallback.
 * Native fetch only, 10s timeouts, Promise.allSettled. Never throws.
 */
export async function fetchCompanyReleases(
  company: string,
  pressUrl?: string,
  limit = 10,
): Promise<Release[]> {
  try {
    void company;
    if (!pressUrl?.trim()) return [];
    const target = pressUrl.trim();
    const safeLimit = Math.min(Math.max(limit, 1), 25);
    const now = new Date().toISOString();

    // 1. Try pressUrl directly as an RSS/Atom feed.
    const direct = await fetchTextWithTimeout(target);
    if (direct && isFeedXml(direct)) {
      return parseFeedReleases(direct, target, "company", safeLimit, now);
    }

    // 2. Sitemap.xml discovery from the press URL's origin.
    const origin = safeOrigin(target);
    if (origin) {
      const viaSitemap = await fetchViaSitemap(origin, safeLimit, now);
      if (viaSitemap.length > 0) return viaSitemap;
    }

    // 3. HTML list fallback (the press page itself, else the site homepage).
    const html =
      direct && direct.toLowerCase().includes("<a")
        ? direct
        : origin
          ? await fetchTextWithTimeout(origin)
          : null;
    if (html) return parseHtmlList(html, origin ?? target, safeLimit, now);
    return [];
  } catch {
    return [];
  }
}
