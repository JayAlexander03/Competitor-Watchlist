import { createHash } from "node:crypto";
import { generateObject } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import type { Release } from "./types";

// NOTE: This module runs in Route Handlers (always live AI call). It must NOT
// use `use cache` (cacheComponents is on). Verdicts are cached only in an
// in-process Map keyed by sha256(url|title).

const MODEL_ID = "meta-llama/llama-3.3-70b-instruct:free";
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

function cacheKey(url: string, title: string): string {
  return createHash("sha256").update(`${url}|${title}`).digest("hex");
}

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
    const modelId = opts?.model ?? MODEL_ID;
    const openrouter = createOpenRouter({ apiKey });
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
          const { object } = await generateObject({
            model: openrouter(modelId),
            schema: BatchSchema,
            prompt:
              `You are filtering mining-news headlines for an investor watchlist.\n` +
              `Company: ${company}\n` +
              `Project (mine/deposit/property): ${project}\n\n` +
              `For each headline below, decide whether it is relevant to the ${project} project ` +
              `(drilling, assays, resources, studies, permits, acquisitions, financing tied to ` +
              `the project, or company news materially affecting it). ` +
              `Return a "results" array with exactly ${uncached.length} entries in the same order, ` +
              `each {relevant, reason, projectMentioned}.\n\nHeadlines:\n${numbered}`,
          });
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
    return kept;
  } catch {
    try {
      return items.filter((r) => prefilterByProject(r.title, r.url, project));
    } catch {
      return items;
    }
  }
}
