import { connection } from "next/server";
import { z } from "zod";
import { requireApiAuth } from "@/lib/api-auth";
import { store } from "@/lib/store";

const WatchItemBody = z.object({
  company: z.string().trim().min(1).max(200),
  project: z.string().trim().min(1).max(200),
  pressUrl: z
    .union([z.string().trim().url().max(2000), z.literal(""), z.null()])
    .optional(),
});

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

const UpdatePressUrlBody = z.object({
  id: z.string().min(1),
  pressUrl: z
    .union([z.string().trim().url().max(2000), z.literal(""), z.null()])
    .optional()
    .nullable(),
});

export async function GET() {
  const unauthorized = await requireApiAuth();
  if (unauthorized) return unauthorized;
  await connection();
  try {
    const items = await store.listWatchItems();
    return Response.json({ items });
  } catch (err) {
    console.error("GET /api/watchlist failed", err);
    return Response.json(
      { error: "Failed to list watchlist" },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  const unauthorized = await requireApiAuth();
  if (unauthorized) return unauthorized;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = WatchItemBody.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { company, project, pressUrl } = parsed.data;
  try {
    const items = await store.listWatchItems();
    const duplicate = items.find(
      (i) =>
        normalize(i.company) === normalize(company) &&
        normalize(i.project) === normalize(project),
    );
    if (duplicate) {
      return Response.json(
        { error: "Project already in watchlist", item: duplicate },
        { status: 409 },
      );
    }
    const item = await store.addWatchItem(
      company,
      project,
      pressUrl ? pressUrl : null,
    );
    return Response.json({ item }, { status: 201 });
  } catch (err) {
    console.error("POST /api/watchlist failed", err);
    return Response.json(
      { error: "Failed to add watch item" },
      { status: 500 },
    );
  }
}

export async function DELETE(req: Request) {
  const unauthorized = await requireApiAuth();
  if (unauthorized) return unauthorized;
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) {
    return Response.json({ error: "Missing ?id=" }, { status: 400 });
  }
  try {
    const removed = await store.removeWatchItem(id);
    if (!removed) {
      return Response.json(
        { error: "Watch item not found" },
        { status: 404 },
      );
    }
    return Response.json({ ok: true, id });
  } catch (err) {
    console.error("DELETE /api/watchlist failed", err);
    return Response.json(
      { error: "Failed to remove watch item" },
      { status: 500 },
    );
  }
}

export async function PATCH(req: Request) {
  const unauthorized = await requireApiAuth();
  if (unauthorized) return unauthorized;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = UpdatePressUrlBody.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { id, pressUrl } = parsed.data;
  if (pressUrl === undefined) {
    return Response.json(
      { error: "Invalid request", issues: "pressUrl is required" },
      { status: 400 },
    );
  }

  const normalized = pressUrl ? pressUrl : null;
  try {
    const item = await store.updatePressUrl(id, normalized);
    if (!item) {
      return Response.json(
        { error: "Watch item not found" },
        { status: 404 },
      );
    }
    return Response.json({ item });
  } catch (err) {
    console.error("PATCH /api/watchlist failed", err);
    return Response.json(
      { error: "Failed to update watch item" },
      { status: 500 },
    );
  }
}
