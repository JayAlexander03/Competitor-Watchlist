import { z } from "zod";
import { checkProjectReleases } from "@/lib/checker";

const SearchBody = z.object({
  company: z.string().trim().min(1).max(200),
  project: z.string().trim().min(1).max(200),
  pressUrl: z
    .union([z.string().trim().url().max(2000), z.literal(""), z.null()])
    .optional(),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = SearchBody.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { company, project, pressUrl } = parsed.data;
  try {
    const releases = await checkProjectReleases(
      { company, project, pressUrl: pressUrl ? pressUrl : undefined },
      { limit: 10 },
    );
    return Response.json({ releases: releases.slice(0, 3) });
  } catch (err) {
    console.error("POST /api/search failed", err);
    return Response.json({ error: "Search failed" }, { status: 500 });
  }
}
