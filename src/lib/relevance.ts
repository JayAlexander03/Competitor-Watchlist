import { createHash } from "node:crypto";
import { z } from "zod";
import { generateObjectWithFallback } from "./models";
import type { Release } from "./types";
import {
  extractArticleHead,
  fetchTextWithTimeout,
  peekArticleHtml,
} from "./sources/company";

// NOTE: This module runs in Route Handlers (always live AI call). It must NOT
// use `use cache` (cacheComponents is on). Verdicts are cached only in an
// in-process Map keyed by sha256(url|title).

const BATCH_SIZE = 20;

const VerdictSchema = z.object({
  relevant: z.boolean(),
  reason: z.string(),
  projectMentioned: z.string().nullable(),
});

const BatchSchema = z.object({
  results: z.array(VerdictSchema),
});

/** In-memory AI verdict cache: sha256(url|title) -> relevant. */
const verdictCache = new Map<string, boolean>();

/** In-memory Stage-2 body verdict cache: sha256(url|title|sha256(head)) -> relevant. */
const bodyVerdictCache = new Map<string, boolean>();

function cacheKey(url: string, title: string): string {
  return createHash("sha256").update(`${url}|${title}`).digest("hex");
}

function bodyCacheKey(url: string, title: string, head: string): string {
  const headHash = createHash("sha256").update(head).digest("hex");
  return createHash("sha256").update(`${url}|${title}|${headHash}`).digest("hex");
}

const COMPANY_TOKEN_STOPWORDS = new Set([
  "corp",
  "inc",
  "ltd",
  "limited",
  "resources",
  "mining",
  "exploration",
  "metals",
  "gold",
  "silver",
  "copper",
]);

/** Significant company tokens: lower split on [^a-z0-9]+, len>=3, minus stopwords. */
function companyTokens(company: string): string[] {
  return (company ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !COMPANY_TOKEN_STOPWORDS.has(t));
}

const STUB_RE = /subscribe|sign in to continue|log in to|paywall/i;

/**
 * Cheap keyword prefilter: does the title/snippet mention the project?
 * Case-insensitive substring match on the full project phrase, else on any
 * significant (>=3 char) token of the project name.
 */
export function prefilterByProject(
  title: string,
  snippet: string,
  project: string,
): boolean {
  const proj = (project ?? "").trim().toLowerCase();
  if (!proj) return true;
  const hay = `${title ?? ""} ${snippet ?? ""}`.toLowerCase();
  if (hay.includes(proj)) return true;
  const terms = proj.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  return terms.some((t) => hay.includes(t));
}

export interface FilterRelevantOpts {
  model?: string;
  batchSize?: number;
}

/**
 * Keyword prefilter → batched OpenRouter relevance check (one generateObject
 * call per batch, array schema, verdicts cached by URL hash).
 * If OPENROUTER_API_KEY is missing or the AI call fails, falls back to
 * prefilter-only results. Never throws.
 */
export async function filterRelevant(
  items: Release[],
  company: string,
  project: string,
  opts?: FilterRelevantOpts,
): Promise<Release[]> {
  try {
    if (items.length === 0) return [];
    const prefiltered = items.filter((r) =>
      prefilterByProject(r.title, r.url, project),
    );
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey || prefiltered.length === 0) return prefiltered;

    const batchSize = Math.min(Math.max(opts?.batchSize ?? BATCH_SIZE, 1), 50);
    const modelOverride = opts?.model ? { model: opts.model } : undefined;
    const kept: Release[] = [];

    for (let i = 0; i < prefiltered.length; i += batchSize) {
      const batch = prefiltered.slice(i, i + batchSize);
      const uncached = batch.filter(
        (r) => !verdictCache.has(cacheKey(r.url, r.title)),
      );
      if (uncached.length > 0) {
        try {
          const numbered = uncached
            .map((r, idx) => `${idx + 1}. "${r.title}" (${r.url})`)
            .join("\n");
          const { object } = await generateObjectWithFallback(
            BatchSchema,
            `You are filtering mining-news headlines for an investor watchlist.\n` +
              `Company: ${company}\n` +
              `Project (mine/deposit/property): ${project}\n\n` +
              `For each headline below, decide whether it is relevant to the ${project} project ` +
              `(drilling, assays, resources, studies, permits, acquisitions, financing tied to ` +
              `the project, or company news materially affecting it). ` +
              `Return a "results" array with exactly ${uncached.length} entries in the same order, ` +
              `each {relevant, reason, projectMentioned}.\n\nHeadlines:\n${numbered}`,
            modelOverride,
          );
          if (object?.results?.length === uncached.length) {
            object.results.forEach((v, idx) => {
              verdictCache.set(
                cacheKey(uncached[idx].url, uncached[idx].title),
                v.relevant === true,
              );
            });
          }
        } catch {
          // AI failure for this batch → keep prefilter verdicts (all pass).
          for (const r of uncached) {
            verdictCache.set(cacheKey(r.url, r.title), true);
          }
        }
      }
      for (const r of batch) {
        if (verdictCache.get(cacheKey(r.url, r.title)) !== false) kept.push(r);
      }
    }

    // Stage 2: body rescue for company-source title-misses. Never throws —
    // on AI failure the keyword+company-token matched rescues are kept
    // (mirrors Stage-1 fallback which keeps prefilter verdicts).
    try {
      const preSet = new Set(prefiltered);
      const candidates = items
        .filter((r) => !preSet.has(r) && r.source === "company")
        .filter((r) => {
          const u = (r.url ?? "").toLowerCase();
          if (u.includes("news.google.com")) return false;
          if (u.includes("sedarplus")) return false;
          return true;
        })
        .slice(0, 5);
      if (candidates.length > 0) {
        const settled = await Promise.allSettled(
          candidates.map(async (r) => {
            const html =
              (await peekArticleHtml(r.url)) ??
              (await fetchTextWithTimeout(r.url, 5000));
            if (!html) return null;
            const head = extractArticleHead(html, 2000) ?? "";
            return { release: r, head: head.trim() };
          }),
        );
        const tokens = companyTokens(company);
        const matched: Array<{ release: Release; head: string }> = [];
        settled.forEach((s) => {
          try {
            if (s.status !== "fulfilled" || !s.value) return;
            const { release, head } = s.value;
            if (head.length < 300) return;
            if (STUB_RE.test(head)) return;
            if (!prefilterByProject(head, "", project)) return;
            if (tokens.length === 0) return;
            const low = head.toLowerCase();
            if (!tokens.some((t) => low.includes(t))) return;
            matched.push({ release, head });
          } catch {
            return;
          }
        });
        const uncached = matched.filter(
          (m) => !bodyVerdictCache.has(bodyCacheKey(m.release.url, m.release.title, m.head)),
        );
        if (uncached.length > 0) {
          try {
            const numbered = uncached
              .map(
                (m) =>
                  `"${m.release.title}" (${m.release.url}) | Body: ${m.head.slice(0, 400)}`,
              )
              .join("\n");
            const { object } = await generateObjectWithFallback(
              BatchSchema,
              `You are filtering mining-news articles for an investor watchlist.\n` +
                `Company: ${company}\n` +
                `Project (mine/deposit/property): ${project}\n\n` +
                `Each line below is an article headline plus its article lede (body). ` +
                `The body is the article lede — ignore sidebar, related-stories, and ` +
                `passing mentions. Decide whether the article is relevant to the ${project} ` +
                `project (drilling, assays, resources, studies, permits, acquisitions, ` +
                `financing tied to the project, or company news materially affecting it). ` +
                `projectMentioned must be the watched project or a target within it. ` +
                `Return a "results" array with exactly ${uncached.length} entries in the same order, ` +
                `each {relevant, reason, projectMentioned}.\n\nArticles:\n${numbered}`,
              modelOverride,
            );
            if (object?.results?.length === uncached.length) {
              object.results.forEach((v, idx) => {
                bodyVerdictCache.set(
                  bodyCacheKey(
                    uncached[idx].release.url,
                    uncached[idx].release.title,
                    uncached[idx].head,
                  ),
                  v.relevant === true,
                );
              });
            }
          } catch {
            // AI failure → keep keyword+company-token rescues (see below).
          }
        }
        for (const m of matched) {
          // Keep unless explicitly judged irrelevant (mirrors Stage-1
          // `!== false` semantics): AI failure / length-mismatch leaves
          // keyword+company-token rescues kept instead of dropped.
          if (
            bodyVerdictCache.get(
              bodyCacheKey(m.release.url, m.release.title, m.head),
            ) !== false
          ) {
            kept.push(m.release);
          }
        }
      }
    } catch {
      // Stage-2 failure → keep Stage-1 verdicts only.
    }
    return kept;
  } catch {
    try {
      return items.filter((r) => prefilterByProject(r.title, r.url, project));
    } catch {
      return items;
    }
  }
}
