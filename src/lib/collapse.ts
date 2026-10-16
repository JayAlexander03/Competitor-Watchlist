import { createHash } from "node:crypto";
import { z } from "zod";
import { generateObjectWithFallback } from "./models";
import type { Release } from "./types";

export const NEAR_DUPE_JACCARD = 0.6;
export const GRAY_MIN = 0.45;
export const NEAR_DUPE_DATE_WINDOW_DAYS = 7;
export const NEAR_DUPE_MIN_TOKENS = 4;
export const NEAR_DUPE_HIGH_SIM_NO_DATE = 0.8;

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

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "for",
  "to",
  "in",
  "on",
  "at",
  "from",
  "with",
  "announces",
  "announce",
  "reports",
  "shares",
  "stock",
  "company",
  "corp",
  "inc",
  "ltd",
  "limited",
  "resources",
  "mining",
]);

/** In-memory judge cache: sha256(sorted normTitle|date pair) -> sameStory. */
const grayCache = new Map<string, boolean>();

function parseDDMMMYYYY(s: string): number | null {
  try {
    const trimmed = (s ?? "").trim();
    if (!trimmed) return null;
    const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(trimmed);
    if (!m) return null;
    const mi = MONTH_IDX[m[2].toLowerCase()];
    if (mi === undefined) return null;
    const day = Number(m[1]);
    const year = Number(m[3]);
    if (!Number.isInteger(day) || !Number.isInteger(year)) return null;
    if (day < 1 || day > 31) return null;
    return Date.UTC(year, mi, day);
  } catch {
    return null;
  }
}

function daysApart(aDate: string, bDate: string): number | null {
  try {
    const a = parseDDMMMYYYY(aDate ?? "");
    const b = parseDDMMMYYYY(bDate ?? "");
    if (a === null || b === null) return null;
    return Math.abs(a - b) / 86400000;
  } catch {
    return null;
  }
}

function stripOutletSuffix(title: string): string {
  try {
    const t = (title ?? "").trim();
    if (!t) return "";
    const seps = [" - ", " / ", " | ", "::", "–", "—"];
    let lastIdx = -1;
    let lastLen = 0;
    for (const sep of seps) {
      const idx = t.lastIndexOf(sep);
      if (idx >= 0 && idx > lastIdx) {
        lastIdx = idx;
        lastLen = sep.length;
      }
    }
    if (lastIdx < 0) return t;
    const left = t.slice(0, lastIdx).trim();
    // Only strip when something meaningful remains; a trailing separator
    // (e.g. "News —") should not erase the whole title.
    if (!left) return t;
    // Avoid stripping a leading dash artifact.
    void lastLen;
    return left;
  } catch {
    return (title ?? "").trim();
  }
}

function titleTokenSet(title: string): Set<string> {
  try {
    const stripped = stripOutletSuffix(title ?? "");
    const parts = stripped.toLowerCase().split(/[^a-z0-9]+/);
    const out = new Set<string>();
    for (const p of parts) {
      if (!p) continue;
      if (STOPWORDS.has(p)) continue;
      out.add(p);
    }
    return out;
  } catch {
    return new Set<string>();
  }
}

function jaccard(a: Set<string>, b: Set<string>): number {
  try {
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    for (const t of small) {
      if (large.has(t)) inter++;
    }
    const union = a.size + b.size - inter;
    if (union <= 0) return 0;
    return inter / union;
  } catch {
    return 0;
  }
}

function numericSignature(title: string): string[] {
  try {
    const stripped = stripOutletSuffix(title ?? "").toLowerCase();
    const m = stripped.match(/\d+(\.\d+)?/g);
    if (!m) return [];
    return [...m].sort();
  } catch {
    return [];
  }
}

function numericOkPair(aTitle: string, bTitle: string): boolean {
  try {
    const aNums = numericSignature(aTitle ?? "");
    const bNums = numericSignature(bTitle ?? "");
    if (aNums.length === 0 || bNums.length === 0) return true;
    const bSet = new Set(bNums);
    for (const n of aNums) {
      if (bSet.has(n)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function normTitle(title: string): string {
  try {
    return stripOutletSuffix(title ?? "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return (title ?? "").toLowerCase().trim();
  }
}

function grayCacheKey(a: Release, b: Release): string {
  const parts = [
    `${normTitle(a.title)}|${(a.date ?? "").trim()}`,
    `${normTitle(b.title)}|${(b.date ?? "").trim()}`,
  ].sort();
  return createHash("sha256").update(parts.join("||")).digest("hex");
}

function sourceRank(source: Release["source"]): number {
  try {
    if (source === "company") return 0;
    if (source === "news") return 1;
    if (source === "sedar") return 2;
    return 3;
  } catch {
    return 3;
  }
}

function dateValue(r: Release): number {
  try {
    const v = parseDDMMMYYYY(r.date ?? "");
    return v === null ? Number.POSITIVE_INFINITY : v;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function pickSurvivor(cluster: Release[]): Release {
  const sorted = [...cluster].sort((x, y) => {
    const sx = sourceRank(x.source);
    const sy = sourceRank(y.source);
    if (sx !== sy) return sx - sy;
    const dx = dateValue(x);
    const dy = dateValue(y);
    if (dx !== dy) return dx - dy;
    return (x.title ?? "").length - (y.title ?? "").length;
  });
  return sorted[0];
}

export function scorePair(
  a: Release,
  b: Release,
): { score: number; dateOk: boolean; numericOk: boolean; tokens: number } {
  try {
    const setA = titleTokenSet(a?.title ?? "");
    const setB = titleTokenSet(b?.title ?? "");
    const score = jaccard(setA, setB);
    const tokens = Math.min(setA.size, setB.size);
    const numericOk = numericOkPair(a?.title ?? "", b?.title ?? "");
    const apart = daysApart(a?.date ?? "", b?.date ?? "");
    const dateOk =
      apart === null
        ? score >= NEAR_DUPE_HIGH_SIM_NO_DATE
        : apart <= NEAR_DUPE_DATE_WINDOW_DAYS;
    return { score, dateOk, numericOk, tokens };
  } catch {
    return { score: 0, dateOk: false, numericOk: false, tokens: 0 };
  }
}

function shouldMergeDeterministic(a: Release, b: Release): boolean {
  try {
    const s = scorePair(a, b);
    return (
      s.tokens >= NEAR_DUPE_MIN_TOKENS &&
      s.score >= NEAR_DUPE_JACCARD &&
      s.dateOk &&
      s.numericOk
    );
  } catch {
    return false;
  }
}

function partitionDeterministic(items: Release[]): Release[][] {
  const clusters: Release[][] = [];
  for (const item of items) {
    let placed = false;
    for (const cluster of clusters) {
      let hit = false;
      for (const member of cluster) {
        if (shouldMergeDeterministic(member, item)) {
          hit = true;
          break;
        }
      }
      if (hit) {
        cluster.push(item);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([item]);
  }
  return clusters;
}

export function collapseDeterministic(items: Release[]): Release[] {
  try {
    if (!Array.isArray(items) || items.length === 0) return [];
    const clusters = partitionDeterministic(items);
    return clusters.map((c) => pickSurvivor(c));
  } catch {
    try {
      return Array.isArray(items) ? [...items] : [];
    } catch {
      return [];
    }
  }
}

const GraySchema = z.object({
  results: z.array(z.object({ sameStory: z.boolean() })),
});

async function judgeGrayPairs(
  pairs: Array<{ a: Release; b: Release }>,
): Promise<boolean[]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || pairs.length === 0) throw new Error("judge unavailable");
  const numbered = pairs
    .map(
      (p, idx) =>
        `${idx + 1}. A: "${p.a.title}" (${(p.a.date ?? "").trim() || "unknown date"}) VS B: "${p.b.title}" (${(p.b.date ?? "").trim() || "unknown date"})`,
    )
    .join("\n");
  const { object } = await generateObjectWithFallback(
    GraySchema,
    `You are deduplicating mining-news headlines for an investor watchlist.\n` +
      `For each numbered A-vs-B pair below, decide whether both headlines describe the SAME underlying story/event ` +
      `(same drill program, assay release, resource update, permit, financing, or acquisition — allowing for different outlets and paraphrase). ` +
      `Different numbers/grades/deals on nearby dates are NOT the same story.\n` +
      `Return a "results" array with exactly ${pairs.length} entries in the same order, each {sameStory}.\n\nPairs:\n${numbered}`,
  );
  if (!object?.results || object.results.length !== pairs.length) {
    throw new Error("judge length mismatch");
  }
  return object.results.map((r) => r.sameStory === true);
}

export async function collapseReleases(items: Release[]): Promise<Release[]> {
  try {
    if (!Array.isArray(items) || items.length === 0) return [];
    const clusters = partitionDeterministic(items);
    const survivors = clusters.map((c) => pickSurvivor(c));
    if (survivors.length < 2) return survivors;

    // Gray candidates among survivors: borderline similarity with both
    // dates known and vetoes passing.
    const grayPairs: Array<{ i: number; j: number }> = [];
    for (let i = 0; i < survivors.length; i++) {
      for (let j = i + 1; j < survivors.length; j++) {
        try {
          const s = scorePair(survivors[i], survivors[j]);
          if (s.score < GRAY_MIN || s.score >= NEAR_DUPE_JACCARD) continue;
          if (s.tokens < NEAR_DUPE_MIN_TOKENS) continue;
          if (!s.numericOk) continue;
          const da = parseDDMMMYYYY(survivors[i].date ?? "");
          const db = parseDDMMMYYYY(survivors[j].date ?? "");
          if (da === null || db === null) continue;
          if (Math.abs(da - db) / 86400000 > NEAR_DUPE_DATE_WINDOW_DAYS)
            continue;
          grayPairs.push({ i, j });
        } catch {
          continue;
        }
      }
    }
    if (grayPairs.length === 0) return survivors;

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return survivors;

    // Consult cache; only uncached pairs go to the judge in one batch.
    const verdicts = new Map<string, boolean>();
    const uncached: Array<{ a: Release; b: Release; key: string }> = [];
    const seenKeys = new Set<string>();
    for (const g of grayPairs) {
      try {
        const key = grayCacheKey(survivors[g.i], survivors[g.j]);
        const cached = grayCache.get(key);
        if (cached !== undefined) {
          verdicts.set(key, cached);
        } else if (!seenKeys.has(key)) {
          seenKeys.add(key);
          uncached.push({
            a: survivors[g.i],
            b: survivors[g.j],
            key,
          });
        }
      } catch {
        continue;
      }
    }
    if (uncached.length > 0) {
      try {
        const results = await judgeGrayPairs(uncached);
        for (let k = 0; k < uncached.length; k++) {
          const v = results[k] === true;
          grayCache.set(uncached[k].key, v);
          verdicts.set(uncached[k].key, v);
        }
      } catch {
        // Judge failure → deterministic result; never cache failures.
        return survivors;
      }
    }

    // Merge iff judge says same story (conjunctive with vetoes, already filtered).
    const parent = survivors.map((_, idx) => idx);
    const find = (x: number): number => {
      let r = x;
      while (parent[r] !== r) r = parent[r];
      parent[x] = r;
      return r;
    };
    const union = (x: number, y: number) => {
      const rx = find(x);
      const ry = find(y);
      if (rx !== ry) parent[ry] = rx;
    };
    for (const g of grayPairs) {
      try {
        const key = grayCacheKey(survivors[g.i], survivors[g.j]);
        if (verdicts.get(key) === true) union(g.i, g.j);
      } catch {
        continue;
      }
    }
    const groups = new Map<number, number[]>();
    for (let idx = 0; idx < survivors.length; idx++) {
      const r = find(idx);
      const arr = groups.get(r);
      if (arr) arr.push(idx);
      else groups.set(r, [idx]);
    }
    if (groups.size === survivors.length) return survivors;

    // Survivor for each merged group chosen from all underlying members.
    const survivorToCluster = new Map<Release, Release[]>();
    clusters.forEach((c) => {
      survivorToCluster.set(pickSurvivor(c), c);
    });
    const ordered = [...groups.values()].sort(
      (x, y) => Math.min(...x) - Math.min(...y),
    );
    return ordered.map((idxs) => {
      const members: Release[] = [];
      for (const si of idxs) {
        const c = survivorToCluster.get(survivors[si]);
        if (c) members.push(...c);
        else members.push(survivors[si]);
      }
      return pickSurvivor(members);
    });
  } catch {
    try {
      return collapseDeterministic(items);
    } catch {
      try {
        return Array.isArray(items) ? [...items] : [];
      } catch {
        return [];
      }
    }
  }
}
