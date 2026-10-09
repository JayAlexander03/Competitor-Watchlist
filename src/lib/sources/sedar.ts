import type { Release } from "../types";

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

function todayDDMMMYYYY(now: Date = new Date()): string {
  return `${String(now.getUTCDate()).padStart(2, "0")}-${MONTHS[now.getUTCMonth()]}-${now.getUTCFullYear()}`;
}

/**
 * Build a SEDAR+ link-out placeholder for a company.
 * Pure function — no fetch. SEDAR+ has no public API and prohibits scraping,
 * so the watchlist links out instead of ingesting filings.
 */
export function buildSedarLinks(company: string): Release[] {
  const name = (company ?? "").trim();
  if (!name) return [];
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "company";
  const now = new Date();
  // NOTE: sedarplus.ca exposes no stable per-company profile URL, so we link
  // to its issuer-search with the company name pre-filled. If SEDAR+ changes
  // its search routes, update this pattern (schema keeps source:'sedar' for a
  // future inbox-parse/CSV import path).
  const url = `https://www.sedarplus.ca/search?query=${encodeURIComponent(name)}`;
  return [
    {
      id: `sedar-${slug}`,
      source: "sedar",
      title: `SEDAR+ filings for ${name}`,
      url,
      date: todayDDMMMYYYY(now),
      hash: "",
      firstSeenAt: now.toISOString(),
    },
  ];
}
