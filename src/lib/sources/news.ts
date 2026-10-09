import type { Release } from "../types";
import { fetchTextWithTimeout, parseFeedReleases } from "./company";

// NOTE: This module runs in Route Handlers (always live fetch). It must NOT use
// `use cache` (cacheComponents is on) — every call hits the network.

/**
 * Fetch news headlines for a company+project pair.
 * Primary: Google News RSS. Fallback: Bing News RSS.
 * RSS links are returned as-is (the route layer may resolve redirects
 * lazily for the top-3 only). Never throws — returns [] on any failure.
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

    // Primary: Google News RSS.
    const query = `"${co}" "${pr}"`;
    const googleUrl =
      `https://news.google.com/rss/search?q=${encodeURIComponent(query)}` +
      `&hl=en-US&gl=CA&ceid=CA:en`;
    const googleXml = await fetchTextWithTimeout(googleUrl);
    if (googleXml) {
      const items = parseFeedReleases(
        googleXml,
        googleUrl,
        "news",
        safeLimit,
        now,
      );
      if (items.length > 0) return items;
    }

    // Fallback: Bing News RSS.
    const bingUrl =
      `https://www.bing.com/news/search?q=${encodeURIComponent(`${co} ${pr}`)}` +
      `&format=rss`;
    const bingXml = await fetchTextWithTimeout(bingUrl);
    if (bingXml) {
      return parseFeedReleases(bingXml, bingUrl, "news", safeLimit, now);
    }
    return [];
  } catch {
    return [];
  }
}
