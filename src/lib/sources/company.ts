import type { Release } from "../types";

// NOTE: This module runs in Route Handlers (always live fetch). It must NOT use
// `use cache` (cacheComponents is on) — every call hits the network.

const FETCH_TIMEOUT_MS = 10_000;
const ENRICH_TIMEOUT_MS = 5_000;
const MAX_SITEMAP_PAGES = 5;

export const REQUEST_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Accept:
    "application/rss+xml, application/atom+xml, application/xml, text/html, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

/**
 * Detect Cloudflare "Just a moment" challenge pages. Requires BOTH:
 * a <title>Just a moment</title> marker and a short body (< 8000 chars)
 * to avoid false positives on real pages referencing challenges.cloudflare.com.
 * Pure, never throws.
 */
export function isChallengePage(text: string): boolean {
  try {
    if (!text) return false;
    if (text.length >= 8000) return false;
    return /<title[^>]*>\s*Just a moment/i.test(text);
  } catch {
    return false;
  }
}

/** Native fetch with a 10s timeout. Never throws — returns null on any failure. */
export async function fetchTextWithTimeout(
  url: string,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<string | null> {
  const doFetch = async (): Promise<string | null> => {
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
  };
  try {
    const first = await doFetch();
    if (first === null || !isChallengePage(first)) return first;
    try {
      await new Promise((r) => setTimeout(r, 800));
    } catch {
      // ignore sleep errors
    }
    const second = await doFetch();
    if (second !== null && isChallengePage(second)) return null;
    return second;
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

// Shared in-process article HTML cache (peekable by parallel workers).
const ARTICLE_HTML_TTL_MS = 30 * 60 * 1000;
const ARTICLE_HTML_MAX = 200;
const articleHtmlCache = new Map<string, { html: string; fetchedAt: number }>();

function normalizeArticleKey(url: string): string {
  try {
    return (url ?? "").trim().toLowerCase().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function storeArticleHtml(url: string, html: string): void {
  try {
    if (!url || !html) return;
    const key = normalizeArticleKey(url);
    if (!key) return;
    if (!articleHtmlCache.has(key) && articleHtmlCache.size >= ARTICLE_HTML_MAX) {
      const oldest = articleHtmlCache.keys().next();
      if (!oldest.done && oldest.value) articleHtmlCache.delete(oldest.value);
    }
    articleHtmlCache.set(key, { html, fetchedAt: Date.now() });
  } catch {
    return;
  }
}

/** Return cached article HTML for url, or null on miss/expiry. Never throws. */
export function peekArticleHtml(url: string): string | null {
  try {
    const key = normalizeArticleKey(url);
    if (!key) return null;
    const entry = articleHtmlCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt > ARTICLE_HTML_TTL_MS) {
      try {
        articleHtmlCache.delete(key);
      } catch {
        // ignore
      }
      return null;
    }
    return entry.html;
  } catch {
    return null;
  }
}

/**
 * Extract a plain-text head snippet from article HTML.
 * Prefers <article> inner HTML, else <main>, else full HTML.
 * Pure, never throws.
 */
export function extractArticleHead(html: string, maxChars = 2000): string {
  try {
    if (!html) return "";
    const limit = typeof maxChars === "number" && maxChars >= 0 ? maxChars : 2000;
    let cleaned = html;
    cleaned = cleaned.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ");
    cleaned = cleaned.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ");
    cleaned = cleaned.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, " ");
    cleaned = cleaned.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, " ");
    cleaned = cleaned.replace(/<figcaption[^>]*>[\s\S]*?<\/figcaption>/gi, " ");
    const articleInner = /<article[^>]*>([\s\S]*?)<\/article>/i.exec(cleaned)?.[1];
    const mainInner = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(cleaned)?.[1];
    const selected = articleInner ?? mainInner ?? cleaned;
    return stripToText(selected).slice(0, limit);
  } catch {
    return "";
  }
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

/**
 * Loose date parse → DD-MMM-YYYY, or null on failure. Never throws.
 * Requires day+month+year (rejects bare years like "2026" or "Oct 2026")
 * and validates via Date.parse.
 */
export function parseDateLoose(s: string | null | undefined): string | null {
  try {
    if (!s) return null;
    const t = s.trim();
    if (!t) return null;
    if (!/(19|20)\d{2}/.test(t)) return null;
    const MONTH_PAT =
      "(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)";
    const hasNumericFull =
      /\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}/.test(t) ||
      /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(t);
    const hasFullMonthDate = new RegExp(
      `${MONTH_PAT}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_PAT},?\\s+\\d{4}`,
      "i",
    ).test(t);
    if (!hasNumericFull && !hasFullMonthDate) return null;
    const parsed = Date.parse(t);
    if (Number.isNaN(parsed)) return null;
    try {
      return toDDMMMYYYY(t);
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

/** Strip leading "Oct 5, 2026 — " style prefixes from list titles. Never throws. */
function stripLeadingDatePrefix(title: string): string {
  try {
    return title
      .replace(
        /^(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\s*[—–\-|:·]?\s*)+/i,
        "",
      )
      .trim();
  } catch {
    return title;
  }
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

function isHomepagePath(url: string): boolean {
  try {
    const u = new URL(url);
    return u.pathname === "/" || u.pathname === "";
  } catch {
    return false;
  }
}

function isFeedUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const clean = u.pathname.toLowerCase().replace(/\/+$/, "");
    return (
      clean.endsWith("/rss") ||
      clean.endsWith("/feed") ||
      clean.endsWith(".xml") ||
      clean === "/rss" ||
      clean === "/feed"
    );
  } catch {
    return false;
  }
}

/**
 * Extract RSS/Atom feed URLs from <link rel="alternate"> tags.
 * Handles both attribute orders (rel before/after type+href). Pure, never throws.
 */
function extractFeedLinks(html: string, base: string): string[] {
  try {
    const out: string[] = [];
    const seen = new Set<string>();
    const tagRx = /<link[^>]*rel=["']alternate["'][^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = tagRx.exec(html)) !== null) {
      const tag = m[0] ?? "";
      if (!/type=["'][^"']*(?:rss|atom\+xml)[^"']*["']/i.test(tag))
        continue;
      const href =
        /href=["']([^"']+)["']/i.exec(tag)?.[1]?.trim() ?? "";
      if (!href) continue;
      const resolved = resolveUrl(href, base);
      if (!resolved || seen.has(resolved)) continue;
      seen.add(resolved);
      out.push(resolved);
    }
    return out;
  } catch {
    return [];
  }
}

const BINARY_RE =
  /(?:\.(?:pdf|pptx?|xlsx?|csv|zip|docx?|mp3|mp4|wav|jpe?g|png|gif|svg|webp|ico|css|js)(?:$|[?#])|[?&](?:format=pdf|download=1)|\/download\/|\/file\/|wp-content\/uploads\/.*\.pdf)/i;

const SECTION_RE =
  /(?:\/page\/\d+|[?&](?:page|paged)=|\/category\/|\/tag\/|\/author\/)/i;

function urlPathAndSearch(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
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
      const dateText = dateRaw ? stripToText(dateRaw) : "";
      const feedDate = dateText ? (parseDateLoose(dateText) ?? "") : "";
      out.push({
        id: url,
        source,
        title: title.slice(0, 300),
        url,
        date: feedDate,
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

function extractArticleMeta(
  html: string,
  pageUrl?: string,
): {
  title: string | null;
  date: string | null;
} {
  try {
    const og =
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(
        html,
      )?.[1] ??
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i.exec(
        html,
      )?.[1];
    const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
    const title = stripToText(og ?? titleTag ?? "") || null;
    const tryRaw = (raw: string | null | undefined): string | null => {
      try {
        if (!raw) return null;
        return parseDateLoose(stripToText(raw));
      } catch {
        return null;
      }
    };
    // Existing 4 (kept first, in order).
    const candidates: Array<string | null | undefined> = [
      /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i.exec(
        html,
      )?.[1],
      /<meta[^>]+itemprop=["']datePublished["'][^>]+content=["']([^"']+)["']/i.exec(
        html,
      )?.[1],
      /<time[^>]+datetime=["']([^"']+)["']/i.exec(html)?.[1],
      /"datePublished"\s*:\s*"([^"]+)"/i.exec(html)?.[1],
      // (a) meta property og:published_time | article:published(_time) — both orders.
      /<meta[^>]+property=["'](?:og:published_time|article:published_time|article:published)["'][^>]+content=["']([^"']+)["']/i.exec(
        html,
      )?.[1],
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["'](?:og:published_time|article:published_time|article:published)["']/i.exec(
        html,
      )?.[1],
      // (b) meta name date variants — both orders.
      /<meta[^>]+name=["'](?:date|publish-date|pubdate|publish_date|DC\.date|sailthru\.date)["'][^>]+content=["']([^"']+)["']/i.exec(
        html,
      )?.[1],
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["'](?:date|publish-date|pubdate|publish_date|DC\.date|sailthru\.date)["']/i.exec(
        html,
      )?.[1],
      // (b) meta itemprop datePublished (reverse order) + dateCreated (both orders).
      /<meta[^>]+content=["']([^"']+)["'][^>]+itemprop=["']datePublished["']/i.exec(
        html,
      )?.[1],
      /<meta[^>]+itemprop=["']dateCreated["'][^>]+content=["']([^"']+)["']/i.exec(
        html,
      )?.[1],
      /<meta[^>]+content=["']([^"']+)["'][^>]+itemprop=["']dateCreated["']/i.exec(
        html,
      )?.[1],
      // (c) JSON-LD dateCreated | uploadDate keys.
      /"(?:dateCreated|uploadDate)"\s*:\s*"([^"]+)"/i.exec(html)?.[1],
    ];
    for (const raw of candidates) {
      const d = tryRaw(raw ?? null);
      if (d) return { title, date: d };
    }
    // (d) Scoped visible date: parent with date-ish class containing an inner
    // date element. Strip footer/figcaption first to avoid caption hits.
    try {
      const scoped = html
        .replace(/<footer[\s>][\s\S]*?<\/footer>/gi, " ")
        .replace(/<figcaption[\s>][\s\S]*?<\/figcaption>/gi, " ");
      const MONTH_PAT =
        "(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)";
      const fullRe = new RegExp(
        `${MONTH_PAT}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+(?:19|20)\\d{2}|\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_PAT},?\\s+(?:19|20)\\d{2}|\\b((?:19|20)\\d{2})-(\\d{2})-(\\d{2})\\b`,
        "i",
      );
      const parentRe =
        /<([a-z][a-z0-9]*)[^>]*class=["'][^"']*(?:uk-article-meta|article-meta|entry-date|post-date|publish-date|news-date|meta-date)[^"']*["'][^>]*>([\s\S]{0,3000}?)<\/\1>/gi;
      let pm: RegExpExecArray | null;
      while ((pm = parentRe.exec(scoped)) !== null) {
        const inner = pm[2] ?? "";
        const innerRe =
          /<(h3|h4|span|div|p|time)[^>]*>([\s\S]*?)<\/\1>/gi;
        let im: RegExpExecArray | null;
        while ((im = innerRe.exec(inner)) !== null) {
          const text = stripToText(im[2] ?? "");
          if (!text) continue;
          const fm = fullRe.exec(text);
          if (!fm) continue;
          const found = fm[0] ?? "";
          // Validate numeric month/day ranges for yyyy-mm-dd.
          const iso = /((?:19|20)\d{2})-(\d{2})-(\d{2})/.exec(found);
          if (iso) {
            const mo = Number(iso[2]);
            const da = Number(iso[3]);
            if (mo < 1 || mo > 12 || da < 1 || da > 31) continue;
          } else {
            const dayM = /(\d{1,2})(?:st|nd|rd|th)?/.exec(found);
            if (dayM) {
              const da = Number(dayM[1]);
              if (da < 1 || da > 31) continue;
            }
          }
          const d = parseDateLoose(found);
          if (d) return { title, date: d };
        }
      }
    } catch {
      // fall through
    }
    // (e) Body dateline: first ~2000 chars of stripped text.
    try {
      const head = stripToText(html).slice(0, 2000);
      const dm =
        /(?:—|–|-|,)\s*((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4})/.exec(
          head,
        )?.[1];
      if (dm) {
        const dayN = Number(/(\d{1,2}),\s*\d{4}/.exec(dm)?.[1] ?? "0");
        if (dayN >= 1 && dayN <= 31) {
          const d = parseDateLoose(dm);
          if (d) return { title, date: d };
        }
      }
    } catch {
      // fall through
    }
    // (f) URL slug date: page URL or canonical link.
    try {
      let urlStr = pageUrl ?? "";
      if (!urlStr) {
        urlStr =
          /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i.exec(
            html,
          )?.[1] ??
          /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i.exec(
            html,
          )?.[1] ??
          "";
      }
      if (urlStr) {
        const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(urlStr);
        if (iso) {
          const mo = Number(iso[2]);
          const da = Number(iso[3]);
          if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
            const d = parseDateLoose(iso[0]);
            if (d) return { title, date: d };
          }
        } else {
          const sm =
            /\/(19\d{2}|20\d{2})(?:\/(\d{2})(?:\/(\d{2}))?)?/.exec(urlStr);
          if (sm) {
            const y = sm[1];
            const moS = sm[2];
            const daS = sm[3];
            // Require day+month+year — never bare year/month.
            if (moS && daS) {
              const mo = Number(moS);
              const da = Number(daS);
              if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
                const d = parseDateLoose(`${y}-${moS}-${daS}`);
                if (d) return { title, date: d };
              }
            }
          }
        }
      }
    } catch {
      // fall through
    }
    return { title, date: null };
  } catch {
    return { title: null, date: null };
  }
}

function extractNewsIndexLinks(html: string, origin: string): string[] {
  try {
    const out: string[] = [];
    const seen = new Set<string>();
    const norm = (s: string) => s.replace(/\/+$/, "").toLowerCase();
    const originNorm = norm(origin);
    const originHost = safeOrigin(origin);
    const scoreNewsUrl = (url: string): number => {
      let score = 0;
      if (/news|press|release/i.test(url)) score += 2;
      if (/announcement|media/i.test(url)) score += 1;
      if (/investor/i.test(url)) score -= 2;
      return score;
    };
    const rx = /<a\s[^>]*href=["']([^"']+)["'][^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(html)) !== null && out.length < 50) {
      const url = resolveUrl(stripToText(m[1]), origin);
      if (!url) continue;
      if (seen.has(url)) continue;
      if (norm(url) === originNorm) continue;
      if (originHost && safeOrigin(url) !== originHost) continue;
      if (!URL_KEYWORDS.test(url)) continue;
      if (BINARY_RE.test(urlPathAndSearch(url))) continue;
      seen.add(url);
      out.push(url);
    }
    out.sort((a, b) => scoreNewsUrl(b) - scoreNewsUrl(a));
    return out.slice(0, 5);
  } catch {
    return [];
  }
}

function parseSitemapUrlPairs(
  xml: string,
): Array<{ loc: string; lastmod: string | null }> {
  try {
    const blocks = allCaptures(xml, /<url[\s>]([\s\S]*?)<\/url>/gi);
    const out: Array<{ loc: string; lastmod: string | null }> = [];
    for (const block of blocks) {
      const locRaw =
        /<loc[^>]*>([\s\S]*?)<\/loc>/i.exec(block)?.[1] ?? "";
      const loc = stripToText(locRaw);
      if (!loc) continue;
      const lastmodRaw =
        /<lastmod[^>]*>([\s\S]*?)<\/lastmod>/i.exec(block)?.[1];
      out.push({
        loc,
        lastmod: lastmodRaw ? stripToText(lastmodRaw) : null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function isSectionLike(batch: Release[]): boolean {
  try {
    if (!batch || batch.length === 0) return true;
    const shallow = batch.filter((r) =>
      SECTION_RE.test(urlPathAndSearch(r.url)),
    ).length;
    if (shallow > batch.length / 2) return true;
    const titles = new Set(
      batch.map((r) => (r.title ?? "").trim().toLowerCase()),
    );
    if (titles.size <= 1) return true;
    if (titles.size * 2 <= batch.length) return true;
    const dates = new Set(
      batch.map((r) => r.date).filter((d) => !!d && d !== ""),
    );
    if (batch.length > 1 && dates.size >= 1 && dates.size <= 1) return true;
    return false;
  } catch {
    return true;
  }
}

/** Enrich top-5 releases with article publish dates. Returns verified count. Never throws. */
async function enrichDates(releases: Release[]): Promise<number> {
  try {
    const top = releases.slice(0, 5);
    if (top.length === 0) return 0;
    const settled = await Promise.allSettled(
      top.map((r) => fetchTextWithTimeout(r.url, ENRICH_TIMEOUT_MS)),
    );
    let verified = 0;
    settled.forEach((s, i) => {
      try {
        if (s.status !== "fulfilled" || !s.value) return;
        try {
          storeArticleHtml(releases[i].url, s.value);
        } catch {
          // ignore cache errors
        }
        const meta = extractArticleMeta(s.value, releases[i].url);
        if (meta.date) {
          releases[i].date = meta.date;
          verified += 1;
        }
      } catch {
        return;
      }
    });
    return verified;
  } catch {
    return 0;
  }
}

async function fetchViaSitemap(
  origin: string,
  limit: number,
  now: string,
): Promise<Release[]> {
  try {
    const indexXml = await fetchTextWithTimeout(
      `${origin}/sitemap.xml`,
      FETCH_TIMEOUT_MS,
    );
    if (!indexXml) return [];
    let pairs: Array<{ loc: string; lastmod: string | null }> = [];
    if (/<sitemapindex[\s>]/i.test(indexXml)) {
      // Sitemap index: drill into nested sitemaps that look news-related.
      const nested = [
        ...new Set(
          allCaptures(indexXml, /<loc[^>]*>([\s\S]*?)<\/loc>/gi)
            .map(stripToText)
            .filter(Boolean),
        ),
      ]
        .filter((u) => URL_KEYWORDS.test(u))
        .slice(0, 2);
      const settled = await Promise.allSettled(
        nested.map((u) => fetchTextWithTimeout(u, FETCH_TIMEOUT_MS)),
      );
      for (const s of settled) {
        if (s.status === "fulfilled" && s.value) {
          pairs.push(...parseSitemapUrlPairs(s.value));
        }
      }
    } else {
      pairs = parseSitemapUrlPairs(indexXml);
      if (pairs.length === 0) {
        const locs = allCaptures(indexXml, /<loc[^>]*>([\s\S]*?)<\/loc>/gi)
          .map(stripToText)
          .filter(Boolean);
        pairs = locs.map((loc) => ({ loc, lastmod: null }));
      }
    }
    const filtered = pairs.filter((p) => {
      if (!/^https?:\/\//i.test(p.loc)) return false;
      if (!URL_KEYWORDS.test(p.loc)) return false;
      const ps = urlPathAndSearch(p.loc);
      if (BINARY_RE.test(ps)) return false;
      if (SECTION_RE.test(ps)) return false;
      return true;
    });
    const seen = new Set<string>();
    const uniq: Array<{ loc: string; lastmod: string | null }> = [];
    for (const p of filtered) {
      if (seen.has(p.loc)) continue;
      seen.add(p.loc);
      uniq.push(p);
    }
    const depthOf = (u: string): number => {
      try {
        return new URL(u).pathname.split("/").filter(Boolean).length;
      } catch {
        return 0;
      }
    };
    uniq.sort((a, b) => {
      const dd = depthOf(b.loc) - depthOf(a.loc);
      if (dd !== 0) return dd;
      const ta = a.lastmod ? Date.parse(a.lastmod) : 0;
      const tb = b.lastmod ? Date.parse(b.lastmod) : 0;
      const na = Number.isNaN(ta) ? 0 : ta;
      const nb = Number.isNaN(tb) ? 0 : tb;
      return nb - na;
    });
    const targets = uniq.slice(
      0,
      Math.min(MAX_SITEMAP_PAGES, Math.max(limit, 1)),
    );
    const settled = await Promise.allSettled(
      targets.map((p) => fetchTextWithTimeout(p.loc, FETCH_TIMEOUT_MS)),
    );
    const out: Release[] = [];
    settled.forEach((s, i) => {
      if (s.status !== "fulfilled" || !s.value) return;
      try {
        try {
          storeArticleHtml(targets[i].loc, s.value);
        } catch {
          // ignore cache errors
        }
        const meta = extractArticleMeta(s.value, targets[i].loc);
        if (!meta.title) return;
        let lastmodDate: string | null = null;
        try {
          lastmodDate = targets[i].lastmod
            ? (parseDateLoose(targets[i].lastmod) ?? null)
            : null;
        } catch {
          lastmodDate = null;
        }
        const date = meta.date ?? lastmodDate ?? "";
        if (!date) return;
        out.push({
          id: targets[i].loc,
          source: "company",
          title: meta.title.slice(0, 300),
          url: targets[i].loc,
          date,
          hash: "",
          firstSeenAt: now,
        });
      } catch {
        return;
      }
    });
    return out.slice(0, limit);
  } catch {
    return [];
  }
}

const LIST_KEYWORDS =
  /news|press|release|announcement|drill|assay|discover|resource|feasib|prefeasib|permit|acqui|merger|financ|explor|intercept|investor|update/i;

/** Find a date adjacent to a list anchor (±500 chars, block-scoped). Never throws. */
function findListAdjacentDate(
  html: string,
  anchorIndex: number,
  anchorLen: number,
): string | null {
  try {
    const start = Math.max(0, anchorIndex - 500);
    const end = Math.min(html.length, anchorIndex + anchorLen + 500);
    let wStart = start;
    let wEnd = end;
    const prevClose = html.lastIndexOf("</a>", anchorIndex);
    if (prevClose >= start) wStart = prevClose + 4;
    let nextIdx = html.indexOf("<a", anchorIndex + anchorLen);
    while (nextIdx !== -1) {
      const ch = html[nextIdx + 2] ?? "";
      if (ch === " " || ch === ">" || ch === "\n" || ch === "\t" || ch === "/")
        break;
      nextIdx = html.indexOf("<a", nextIdx + 1);
    }
    if (nextIdx !== -1 && nextIdx < wEnd && nextIdx > anchorIndex)
      wEnd = nextIdx;
    const window = html.slice(wStart, wEnd);
    if (!window) return null;
    // 1. <time datetime>
    try {
      const t =
        /<time[^>]+datetime=["']([^"']+)["']/i.exec(window)?.[1] ?? null;
      if (t) {
        const d = parseDateLoose(stripToText(t));
        if (d) return d;
      }
    } catch {
      // fall through
    }
    // 2. date-class text: element whose class hints at a date.
    try {
      const MONTH_PAT =
        "(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)";
      const fullRe = new RegExp(
        `${MONTH_PAT}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+(?:19|20)\\d{2}|\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_PAT},?\\s+(?:19|20)\\d{2}|\\b(?:19|20)\\d{2}-\\d{2}-\\d{2}\\b`,
        "i",
      );
      const dcRe =
        /<([a-z][a-z0-9]*)[^>]*class=["'][^"']*(?:date|time|publish)[^"']*["'][^>]*>([\s\S]{0,500}?)<\/\1>/gi;
      let dm: RegExpExecArray | null;
      while ((dm = dcRe.exec(window)) !== null) {
        const text = stripToText(dm[2] ?? "");
        if (!text) continue;
        const fm = fullRe.exec(text);
        if (!fm) continue;
        const d = parseDateLoose(fm[0]);
        if (d) return d;
      }
    } catch {
      // fall through
    }
    // 3. bare full date in window text.
    try {
      const text = stripToText(window);
      const MONTH_PAT =
        "(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)";
      const bareRe = new RegExp(
        `${MONTH_PAT}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+(?:19|20)\\d{2}|\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_PAT},?\\s+(?:19|20)\\d{2}|\\b(?:19|20)\\d{2}-\\d{2}-\\d{2}\\b`,
        "i",
      );
      const bm = bareRe.exec(text);
      if (bm) {
        const d = parseDateLoose(bm[0]);
        if (d) return d;
      }
    } catch {
      // fall through
    }
    return null;
  } catch {
    return null;
  }
}

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
      if (BINARY_RE.test(urlPathAndSearch(url))) continue;
      const rawTitle = stripToText(m[2]);
      const title = stripLeadingDatePrefix(rawTitle);
      if (!title) continue;
      if (title.length < 15 || title.length > 300) continue;
      if (!LIST_KEYWORDS.test(url) && !LIST_KEYWORDS.test(title)) continue;
      let listDate: string | null = null;
      try {
        listDate = findListAdjacentDate(html, m.index, m[0].length);
      } catch {
        listDate = null;
      }
      seen.add(url);
      out.push({
        id: url,
        source: "company",
        title,
        url,
        date: listDate ?? "",
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
 * Strategy: pressUrl as RSS/Atom → homepage news-index → news-like HTML +
 * enrichment → sitemap.xml discovery → HTML list fallback.
 * Native fetch only, 10s direct/index/sitemap timeouts, 5s enrichment,
 * Promise.allSettled. Never throws.
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
    const direct = await fetchTextWithTimeout(target, FETCH_TIMEOUT_MS);
    if (direct && (isFeedXml(direct) || isFeedUrl(target))) {
      if (isFeedXml(direct)) {
        return parseFeedReleases(direct, target, "company", safeLimit, now);
      }
      const maybe = parseFeedReleases(
        direct,
        target,
        "company",
        safeLimit,
        now,
      );
      if (maybe.length > 0) return maybe;
    }

    const origin = safeOrigin(target);

    // 1b. Feed <link rel="alternate"> in direct HTML → fetch + verify.
    try {
      if (direct && origin) {
        const feedLinks = extractFeedLinks(direct, origin);
        for (const feedUrl of feedLinks) {
          try {
            const feedXml = await fetchTextWithTimeout(
              feedUrl,
              FETCH_TIMEOUT_MS,
            );
            if (feedXml && isFeedXml(feedXml)) {
              const parsed = parseFeedReleases(
                feedXml,
                feedUrl,
                "company",
                safeLimit,
                now,
              );
              if (parsed.length > 0) return parsed;
            }
          } catch {
            continue;
          }
        }
      }
    } catch {
      // fall through
    }

    // 2. Homepage → news-index pipeline (no extra fetch for link discovery).
    try {
      if (origin && direct && isHomepagePath(target)) {
        const links = extractNewsIndexLinks(direct, origin);
        for (const idxUrl of links) {
          try {
            const idxHtml = await fetchTextWithTimeout(
              idxUrl,
              FETCH_TIMEOUT_MS,
            );
            if (!idxHtml) continue;
            if (isFeedXml(idxHtml) || isFeedUrl(idxUrl)) {
              const feed = parseFeedReleases(
                idxHtml,
                idxUrl,
                "company",
                safeLimit,
                now,
              );
              if (feed.length > 0) return feed;
              continue;
            }
            const listed = parseHtmlList(idxHtml, origin, safeLimit, now);
            if (listed.length === 0) continue;
            const verified = await enrichDates(listed);
            const nonSection = listed.filter(
              (r) => !SECTION_RE.test(urlPathAndSearch(r.url)),
            );
            if (verified >= 1 || nonSection.length >= 3) return listed;
          } catch {
            continue;
          }
        }
      }
    } catch {
      // fall through
    }

    // 3. Target already news-like: parse direct HTML + top-5 enrichment.
    try {
      if (direct && URL_KEYWORDS.test(target)) {
        const listed = parseHtmlList(direct, origin ?? target, safeLimit, now);
        if (listed.length > 0) {
          await enrichDates(listed);
          if (!isSectionLike(listed)) return listed;
        }
      }
    } catch {
      // fall through
    }

    // 4. Sitemap fallback ONLY now (quality-gated, no early return on junk).
    try {
      if (origin) {
        const viaSitemap = await fetchViaSitemap(origin, safeLimit, now);
        if (viaSitemap.length > 0 && !isSectionLike(viaSitemap)) {
          return viaSitemap;
        }
      }
    } catch {
      // fall through
    }

    // 5. Homepage HTML list last resort.
    try {
      if (direct && direct.toLowerCase().includes("<a")) {
        const last = parseHtmlList(direct, origin ?? target, safeLimit, now);
        if (last.length > 0) return last;
      }
      if (origin && !isHomepagePath(target)) {
        const home = await fetchTextWithTimeout(origin, FETCH_TIMEOUT_MS);
        if (home) {
          const last = parseHtmlList(home, origin, safeLimit, now);
          if (last.length > 0) return last;
        }
      }
    } catch {
      // fall through
    }
    return [];
  } catch {
    return [];
  }
}
