import { generateObject } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { z } from "zod";

// Centralized OpenRouter model config. Dots is primary; gemma is the
// deterministic standby. Callers already fail soft to deterministic
// behavior when both fail (helper throws after the fallback attempt).
export const PRIMARY_MODEL = "dots-studio/dots-3-note-preview:free";
export const FALLBACK_MODEL = "google/gemma-4-31b-it:free";

/** Generous ceiling so exact-length array schemas never truncate. */
export const SHARED_MAX_OUTPUT_TOKENS = 2000;

/** Reasoning-minimal opts shared by primary + fallback calls. */
export const SHARED_PROVIDER_OPTIONS = {
  openrouter: { reasoning: { effort: "minimal", exclude: true } },
} as const;

/** Short backoff between the primary attempt and the single fallback try. */
export const FALLBACK_BACKOFF_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface GenerateObjectFallbackOpts {
  /** Override the primary model (default PRIMARY_MODEL). */
  model?: string;
  /** Override the fallback model (default FALLBACK_MODEL). */
  fallbackModel?: string;
  /** Override the shared max-output-tokens ceiling. */
  maxOutputTokens?: number;
}

/**
 * generateObject with centralized model config: tries the primary model
 * with reasoning-minimal opts, then the fallback model once after a short
 * backoff, then throws. Generic over zod schemas. Never adds deps.
 */
export async function generateObjectWithFallback<T>(
  schema: z.ZodType<T>,
  prompt: string,
  opts?: GenerateObjectFallbackOpts,
): Promise<{ object: T }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY missing");
  const openrouter = createOpenRouter({ apiKey });
  const primary = opts?.model ?? PRIMARY_MODEL;
  const fallback = opts?.fallbackModel ?? FALLBACK_MODEL;
  const maxOutputTokens = opts?.maxOutputTokens ?? SHARED_MAX_OUTPUT_TOKENS;
  const providerOptions = {
    openrouter: { reasoning: { effort: "minimal" as const, exclude: true } },
  };
  const callOptions = { schema, prompt, maxOutputTokens, providerOptions } as const;
  try {
    const result = await generateObject({
      ...callOptions,
      model: openrouter(primary, {
        reasoning: { effort: "minimal", exclude: true },
      }),
    });
    return { object: result.object as T };
  } catch (primaryErr) {
    if (fallback === primary) throw primaryErr;
    await sleep(FALLBACK_BACKOFF_MS);
    const result = await generateObject({
      ...callOptions,
      model: openrouter(fallback, {
        reasoning: { effort: "minimal", exclude: true },
      }),
    });
    return { object: result.object as T };
  }
}
