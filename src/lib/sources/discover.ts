// Route Handler module: live fetch only, never `use cache`.
import { z } from "zod";
import { generateObjectWithFallback } from "../models";
import { fetchTextWithTimeout } from "./company";

export type UrlConfidence = "high" | "medium" | "low" | "none";
export type UrlSource = "user" | "discovered-feed" | "discovered-sitemap" | "discovered-html" | "discovered-llm" | "none";

export interface DiscoveredUrl {
  pressUrl: string | null;
  origin: string | null;
  confidence: UrlConfidence;
  source: UrlSource;
}

const FETCH_TIMEOUT_MS = 7_000;
const TIER_TIMEOUT_MS = 7_000;
const OVERALL_DEADLINE_MS = 22_000;

/** Generic company suffixes / commodity words stripped before slugifying. */
const STRIP_TOKENS = new Set(["inc", "ltd", "corp", "corporation", "limited", "resources", "mining", "exploration", "explorations", "metals", "gold", "silver", "copper"]);

const URL_KEYWORDS = /news|press|release|investor|media|announcement/i;

const CHALLENGE_RX = /captcha|challenge|anomaly|sign in|attention required/i;

const BING_DENY = ["bing", "cc.bingj", "microsoft", "duckduckgo", "google", "news.google", "yahoo", "msn", "marketwatch", "seekingalpha", "fool", "morningstar", "benzinga", "barchart", "tipranks", "marketbeat", "stockhouse", "stocktwits", "globenewswire", "newswire.ca", "newsfilecorp", "accessnewswire", "stockwatch", "sedarplus", "facebook", "x.com", "twitter", "linkedin", "youtube"];

const LlmSchema = z.object({
  homepage: z.string().nullable(),
  pressUrl: z.string().nullable(),
});

/** In-memory cache: company-lowercase -> { value, ts }. Bounded at 200 entries. */
const cache = new Map<string, { value: DiscoveredUrl; ts: number }>();
const CACHE_MAX = 200;
const NEG_TTL_MS = 10 * 60 * 1000;

function slugTokens(company: string): string[] {
  return (company ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((t) => !STRIP_TOKENS.has(t));
}

function fullTokens(company: string): string[] {
  return (company ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Homepage guesses: full-slug + stripped-slug .com/.ca plus hyphen variants.
 * .com variants first, 6 max. Never guesses .net/.org blind.
 */
export function guessCandidates(company: string): string[] {
  try {
    const full = fullTokens(company);
    if (full.length === 0) return [];
    const stripped = slugTokens(company);
    const fullSlug = full.join("");
    const fullHyphen = full.join("-");
    const stripSlug = stripped.join("");
    const stripHyphen = stripped.join("-");
    const coms: string[] = [];
    const cas: string[] = [];
    const pushDistinct = (arr: string[], u: string) => {
      if (u && !arr.includes(u)) arr.push(u);
    };
    if (fullSlug) pushDistinct(coms, `https://${fullSlug}.com`);
    if (stripSlug && stripSlug !== fullSlug) pushDistinct(coms, `https://${stripSlug}.com`);
    if (full.length > 1 && fullHyphen !== fullSlug) pushDistinct(coms, `https://${fullHyphen}.com`);
    if (stripped.length > 1 && stripHyphen && stripHyphen !== stripSlug && stripHyphen !== fullSlug && stripHyphen !== fullHyphen)
      pushDistinct(coms, `https://${stripHyphen}.com`);
    if (fullSlug) pushDistinct(cas, `https://${fullSlug}.ca`);
    if (stripSlug && stripSlug !== fullSlug) pushDistinct(cas, `https://${stripSlug}.ca`);
    if (full.length > 1 && fullHyphen !== fullSlug) pushDistinct(cas, `https://${fullHyphen}.ca`);
    if (stripped.length > 1 && stripHyphen && stripHyphen !== stripSlug && stripHyphen !== fullSlug && stripHyphen !== fullHyphen)
      pushDistinct(cas, `https://${stripHyphen}.ca`);
    return [...new Set([...coms, ...cas])].slice(0, 6);
  } catch {
    return [];
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenMatchesTitle(title: string, token: string): boolean {
  try {
    if (!token) return false;
    return new RegExp(`(^|[^a-z0-9])${escapeRegExp(token)}([^a-z0-9]|$)`).test(title);
  } catch {
    return false;
  }
}

function titleMatchesCompany(html: string, company: string, originOrUrl?: string | null): boolean {
  try {
    const raw = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
    const title = raw.replace(/\s+/g, " ").trim().toLowerCase();
    if (!title) return false;
    const all = (company ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3);
    const significant = all.filter((t) => !STRIP_TOKENS.has(t));
    const tokens = significant.length > 0 ? significant : all;
    if (tokens.length === 0) return false;
    const matched = tokens.filter((t) => tokenMatchesTitle(title, t));
    if (matched.length === 0) return false;
    // Single significant token: require extra evidence (full-slug substring or domain-contains-token).
    if (significant.length === 1) {
      const token = significant[0];
      if (!tokenMatchesTitle(title, token)) return false;
      const fullSlug = fullTokens(company).join("");
      const compact = title.replace(/[^a-z0-9]+/g, "");
      if (fullSlug && compact.includes(fullSlug)) return true;
      if (originOrUrl) {
        try {
          const host = new URL(originOrUrl).hostname.toLowerCase();
          const hostCompact = host.replace(/[^a-z0-9]+/g, "");
          const tokenCompact = token.replace(/[^a-z0-9]+/g, "");
          if (host.includes(token) || (tokenCompact && hostCompact.includes(tokenCompact))) return true;
        } catch {
          // fall through to false
        }
      }
      return false;
    }
    return true;
  } catch {
    return false;
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

/** Score news-like URLs: prefer news/press/release, then announcement/media; demote investor sections. */
function scoreNewsUrl(url: string): number {
  let score = 0;
  if (/news|press|release/i.test(url)) score += 2;
  if (/announcement|media/i.test(url)) score += 1;
  if (/investor/i.test(url)) score -= 2;
  return score;
}

/** <a href> scan of a homepage, keeping news-like links resolved to absolute. */
function extractNewsLinks(html: string, origin: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const rx = /<a\s[^>]*href=["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(html)) !== null && out.length < 50) {
    const url = resolveUrl(m[1].trim(), origin);
    if (!url || seen.has(url)) continue;
    if (!URL_KEYWORDS.test(url)) continue;
    seen.add(url);
    out.push(url);
  }
  out.sort((a, b) => scoreNewsUrl(b) - scoreNewsUrl(a));
  return out.slice(0, 5);
}

/** <link rel="alternate"> RSS/Atom hrefs on a homepage. Both attribute orders. */
function extractHomepageFeedLinks(html: string, base: string): string[] {
  try {
    const out: string[] = [];
    const seen = new Set<string>();
    const tagRx = /<link[^>]*rel=["']alternate["'][^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = tagRx.exec(html)) !== null) {
      const tag = m[0] ?? "";
      if (!/type=["'][^"']*(?:rss|atom\+xml)[^"']*["']/i.test(tag)) continue;
      const href = /href=["']([^"']+)["']/i.exec(tag)?.[1]?.trim() ?? "";
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

/** Press URL from verified homepage: feed link first, else newsroom link. */
async function resolvePressFromHomepage(
  html: string,
  origin: string,
  viaLlm = false,
): Promise<DiscoveredUrl | null> {
  // Homepage <link rel="alternate"> RSS first — verify before accepting.
  try {
    const feedLinks = extractHomepageFeedLinks(html, origin);
    for (const feedUrl of feedLinks) {
      try {
        const feedText = await fetchTextWithTimeout(feedUrl, FETCH_TIMEOUT_MS);
        if (feedText && isFeedXml(feedText)) {
          return {
            pressUrl: feedUrl,
            origin,
            confidence: viaLlm ? "medium" : "high",
            source: viaLlm ? "discovered-llm" : "discovered-feed",
          };
        }
      } catch {
        continue;
      }
    }
  } catch {
    // fall through to <a>-link logic
  }
  const links = extractNewsLinks(html, origin);
  if (links.length === 0) return null;
  const settled = await Promise.allSettled(
    links.map((u) => fetchTextWithTimeout(u, FETCH_TIMEOUT_MS)),
  );
  for (let i = 0; i < links.length; i++) {
    const s = settled[i];
    if (s.status === "fulfilled" && s.value && isFeedXml(s.value)) {
      return {
        pressUrl: links[i],
        origin,
        confidence: viaLlm ? "medium" : "high",
        source: viaLlm ? "discovered-llm" : "discovered-feed",
      };
    }
  }
  return {
    pressUrl: links[0],
    origin,
    confidence: viaLlm ? "low" : "medium",
    source: viaLlm ? "discovered-llm" : "discovered-html",
  };
}

function allLocs(xml: string): string[] {
  const out: string[] = [];
  const rx = /<loc[^>]*>([\s\S]*?)<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(xml)) !== null) {
    const loc = m[1]
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .trim();
    if (loc) out.push(loc);
  }
  return out;
}

/** Sitemap fallback: first news-like <loc> in origin/sitemap.xml. */
async function sitemapFallback(origin: string): Promise<DiscoveredUrl | null> {
  try {
    const indexXml = await fetchTextWithTimeout(
      `${origin}/sitemap.xml`,
      FETCH_TIMEOUT_MS,
    );
    if (!indexXml) return null;
    let pool = allLocs(indexXml);
    if (/<sitemapindex[\s>]/i.test(indexXml)) {
      const nested = [...new Set(pool)]
        .filter((u) => URL_KEYWORDS.test(u))
        .slice(0, 2);
      const settled = await Promise.allSettled(
        nested.map((u) => fetchTextWithTimeout(u, FETCH_TIMEOUT_MS)),
      );
      pool = [];
      for (const s of settled) {
        if (s.status === "fulfilled" && s.value) pool.push(...allLocs(s.value));
      }
    }
    const hit = [...new Set(pool)].find(
      (u) => /^https?:\/\//i.test(u) && URL_KEYWORDS.test(u),
    );
    if (!hit) return null;
    return {
      pressUrl: hit,
      origin,
      confidence: "medium",
      source: "discovered-sitemap",
    };
  } catch {
    return null;
  }
}

/** Tier1: DuckDuckGo lite search → verified homepage (title gate). Never throws. */
async function ddgLiteSearch(company: string): Promise<{ html: string; origin: string } | null> {
  try {
    const q = (company ?? "").trim();
    if (!q) return null;
    const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`;
    const html = await fetchTextWithTimeout(url, TIER_TIMEOUT_MS);
    if (!html) return null;
    if (CHALLENGE_RX.test(html.slice(0, 20000))) return null;
    const origins: string[] = [];
    const seen = new Set<string>();
    const rx = /\/l\/\?uddg=([^"'\s<>]+)/gi;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(html)) !== null && origins.length < 5) {
      try {
        let dec = (m[1] ?? "").split("&")[0];
        if (!dec) continue;
        for (let i = 0; i < 3; i++) {
          try {
            const next = decodeURIComponent(dec);
            if (next === dec) break;
            dec = next;
          } catch {
            break;
          }
        }
        if (!/^https?:\/\//i.test(dec)) continue;
        const origin = safeOrigin(dec);
        if (!origin || seen.has(origin)) continue;
        let host = "";
        try {
          host = new URL(origin).hostname.toLowerCase();
        } catch {
          continue;
        }
        if (host.includes("duckduckgo")) continue;
        seen.add(origin);
        origins.push(origin);
      } catch {
        continue;
      }
    }
    if (origins.length === 0) return null;
    const top = origins.slice(0, 3);
    const settled = await Promise.allSettled(
      top.map((o) => fetchTextWithTimeout(o, TIER_TIMEOUT_MS)),
    );
    for (let i = 0; i < top.length; i++) {
      try {
        const s = settled[i];
        const page = s.status === "fulfilled" ? s.value : null;
        if (!page) continue;
        if (!titleMatchesCompany(page, company, top[i])) continue;
        return { html: page, origin: top[i] };
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Tier1b: DDG lite surfaced news-like deep URL fallback (for challenge-blocked homepages).
 *  ddgLiteSearch discards result paths and requires a homepage fetch + title
 *  gate. Cloudflare-challenged sites (e.g. canamerametals.com → HTTP 403
 *  "Just a moment" on every path) can never pass that gate, even when DDG
 *  directly surfaced a news-like deep URL (https://canamerametals.com/news/).
 *  This fallback accepts such a URL with LOW confidence when its host matches
 *  a significant company token (rejects thecse/facebook/youtube etc.). Never throws. */
async function ddgNewsUrlFallback(company: string): Promise<DiscoveredUrl | null> {
  try {
    const q = (company ?? "").trim();
    if (!q) return null;
    const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`;
    const html = await fetchTextWithTimeout(url, TIER_TIMEOUT_MS);
    if (!html) return null;
    if (CHALLENGE_RX.test(html.slice(0, 20000))) return null;
    const decoded: string[] = [];
    const rx = /\/l\/\?uddg=([^"'\s<>]+)/gi;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(html)) !== null && decoded.length < 15) {
      try {
        let dec = (m[1] ?? "").split("&")[0];
        if (!dec) continue;
        for (let i = 0; i < 3; i++) {
          try {
            const next = decodeURIComponent(dec);
            if (next === dec) break;
            dec = next;
          } catch {
            break;
          }
        }
        if (!/^https?:\/\//i.test(dec)) continue;
        decoded.push(dec);
      } catch {
        continue;
      }
    }
    if (decoded.length === 0) return null;
    const all = q.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
    const sig = all.filter((t) => !STRIP_TOKENS.has(t));
    const toks = sig.length > 0 ? sig : all;
    if (toks.length === 0) return null;
    for (const u of decoded) {
      try {
        if (!URL_KEYWORDS.test(u)) continue;
        const origin = safeOrigin(u);
        if (!origin) continue;
        const host = new URL(origin).hostname.toLowerCase();
        if (BING_DENY.some((e) => host.includes(e))) continue;
        if (host.includes("duckduckgo")) continue;
        if (!toks.some((t) => host.includes(t))) continue;
        return { pressUrl: u, origin, confidence: "low", source: "discovered-html" };
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Tier2: Bing News RSS domain vote → fetch-verified top candidate. Never throws. */
async function bingDomainVote(company: string): Promise<{ html: string; origin: string } | null> {
  try {
    const q = (company ?? "").trim();
    if (!q) return null;
    const bingUrl =
      `https://www.bing.com/news/search?q=${encodeURIComponent(q)}` +
      `&format=rss`;
    const xml = await fetchTextWithTimeout(bingUrl, TIER_TIMEOUT_MS);
    if (!xml) return null;
    // Local RSS item-link regex (do not import non-exported parsers).
    const links: string[] = [];
    try {
      const itemRx = /<item[\s>]([\s\S]*?)<\/item>/gi;
      let m: RegExpExecArray | null;
      while ((m = itemRx.exec(xml)) !== null && links.length < 50) {
        const block = m[1] ?? "";
        const raw =
          /<link[^>]*href=["']([^"']+)["']/i.exec(block)?.[1] ??
          /<link[^>]*>([\s\S]*?)<\/link>/i.exec(block)?.[1] ??
          /<guid[^>]*>([\s\S]*?)<\/guid>/i.exec(block)?.[1] ??
          "";
        const cleaned = raw
          .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
          .replace(/&amp;/gi, "&")
          .trim();
        if (cleaned) links.push(cleaned);
      }
    } catch {
      return null;
    }
    if (links.length === 0) return null;
    const tally = new Map<string, number>();
    for (const link of links) {
      try {
        let target = link;
        try {
          const u = new URL(target);
          const host = u.hostname.toLowerCase();
          if (host.includes("bing.com") || host.includes("cc.bingj") || host.includes("bingj.")) {
            const viaParam = u.searchParams.get("url") ?? u.searchParams.get("u");
            if (viaParam && /^https?:\/\//i.test(viaParam.trim())) target = viaParam.trim();
          }
        } catch {
          continue;
        }
        const origin = safeOrigin(target);
        if (!origin) continue;
        let host = "";
        try {
          host = new URL(origin).hostname.toLowerCase();
        } catch {
          continue;
        }
        if (BING_DENY.some((e) => host.includes(e))) continue;
        tally.set(origin, (tally.get(origin) ?? 0) + 1);
      } catch {
        continue;
      }
    }
    if (tally.size === 0) return null;
    const ranked = [...tally.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([origin]) => origin)
      .slice(0, 3);
    const settled = await Promise.allSettled(
      ranked.map((o) => fetchTextWithTimeout(o, TIER_TIMEOUT_MS)),
    );
    for (let i = 0; i < ranked.length; i++) {
      try {
        const s = settled[i];
        const page = s.status === "fulfilled" ? s.value : null;
        if (!page) continue;
        if (!titleMatchesCompany(page, company, ranked[i])) continue;
        return { html: page, origin: ranked[i] };
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** LLM fallback: ask for homepage/pressUrl, fetch-verify before accepting. */
async function llmFallback(company: string): Promise<DiscoveredUrl | null> {
  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return null;
    const { object } = await generateObjectWithFallback(
      LlmSchema,
      `You help an investor watchlist find official company web pages.\n` +
        `Company (mining/exploration): ${company}\n\n` +
        `Return the official company homepage URL and the press releases / ` +
        `news releases page URL (null when unknown). Use fully qualified https URLs.`,
    );
    const homepage = object?.homepage?.trim() || null;
    if (!homepage || !/^https?:\/\//i.test(homepage)) return null;
    const html = await fetchTextWithTimeout(homepage, FETCH_TIMEOUT_MS);
    if (!html || !titleMatchesCompany(html, company, homepage)) return null;
    const origin = safeOrigin(homepage);
    if (!origin) return null;
    const llmPress = object?.pressUrl?.trim() || null;
    if (llmPress && /^https?:\/\//i.test(llmPress)) {
      const pressHtml = await fetchTextWithTimeout(llmPress, FETCH_TIMEOUT_MS);
      if (pressHtml) {
        return {
          pressUrl: llmPress,
          origin,
          confidence: isFeedXml(pressHtml) ? "medium" : "low",
          source: "discovered-llm",
        };
      }
    }
    return resolvePressFromHomepage(html, origin, true);
  } catch {
    return null;
  }
}

function none(): DiscoveredUrl {
  return { pressUrl: null, origin: null, confidence: "none", source: "none" };
}

/** Press + sitemap resolution for an already-verified homepage. Never throws. */
async function pressForVerifiedHomepage(
  html: string,
  origin: string,
): Promise<DiscoveredUrl | null> {
  try {
    const press = await resolvePressFromHomepage(html, origin);
    if (press) return press;
    return await sitemapFallback(origin);
  } catch {
    return null;
  }
}

/**
 * Discover a company's press/news URL. Slug guesses (title gate) →
 * DDG lite → Bing domain vote → LLM fallback (last).
 * Native fetch only, 5-7s per-tier caps, ~22s overall deadline,
 * Promise.allSettled fan-out. Never throws.
 */
export async function discoverCompanyPressUrl(
  company: string,
): Promise<DiscoveredUrl> {
  try {
    const key = (company ?? "").toLowerCase();
    if (!key.trim()) return none();
    const cached = cache.get(key);
    if (cached) {
      if (cached.value.confidence === "none") {
        if (Date.now() - cached.ts < NEG_TTL_MS) return cached.value;
        cache.delete(key);
      } else {
        return cached.value;
      }
    }
    const put = (d: DiscoveredUrl): DiscoveredUrl => {
      try {
        if (!cache.has(key) && cache.size >= CACHE_MAX) {
          const oldest = cache.keys().next().value as string | undefined;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(key, { value: d, ts: Date.now() });
      } catch {
        // ignore cache errors
      }
      return d;
    };

    const start = Date.now();
    const overBudget = (): boolean => Date.now() - start > OVERALL_DEADLINE_MS;

    // Tier 0: deterministic slug candidates with <title> gate.
    if (!overBudget()) {
      try {
        let verifiedHtml: string | null = null;
        let verifiedOrigin: string | null = null;
        const candidates = guessCandidates(company);
        if (candidates.length > 0) {
          const settled = await Promise.allSettled(
            candidates.map((u) => fetchTextWithTimeout(u, FETCH_TIMEOUT_MS)),
          );
          for (let i = 0; i < candidates.length; i++) {
            try {
              const s = settled[i];
              const html = s.status === "fulfilled" ? s.value : null;
              if (!html || !titleMatchesCompany(html, company, candidates[i])) continue;
              const origin = safeOrigin(candidates[i]);
              if (!origin) continue;
              verifiedHtml = html;
              verifiedOrigin = origin;
              break;
            } catch {
              continue;
            }
          }
        }
        if (verifiedHtml && verifiedOrigin) {
          const hit = await pressForVerifiedHomepage(verifiedHtml, verifiedOrigin);
          if (hit) return put(hit);
        }
      } catch {
        // fall through to next tier
      }
    }

    // Tier 1: DDG lite search.
    if (!overBudget()) {
      try {
        const hit = await ddgLiteSearch(company);
        if (hit) {
          const press = await pressForVerifiedHomepage(hit.html, hit.origin);
          if (press) return put(press);
        }
        // Tier 1b: DDG surfaced a news-like deep URL but the homepage is
        // fetch-blocked (e.g. Cloudflare challenge) — accept with low confidence.
        if (!overBudget()) {
          try {
            const viaNews = await ddgNewsUrlFallback(company);
            if (viaNews) return put(viaNews);
          } catch {
            // fall through
          }
        }
      } catch {
        // fall through
      }
    }

    // Tier 2: Bing News RSS domain vote.
    if (!overBudget()) {
      try {
        const hit = await bingDomainVote(company);
        if (hit) {
          const press = await pressForVerifiedHomepage(hit.html, hit.origin);
          if (press) return put(press);
        }
      } catch {
        // fall through
      }
    }

    // Tier 3: LLM fallback (kept last).
    if (!overBudget()) {
      try {
        const viaLlm = await llmFallback(company);
        if (viaLlm) return put(viaLlm);
      } catch {
        // fall through
      }
    }
    return put(none());
  } catch {
    return none();
  }
}
