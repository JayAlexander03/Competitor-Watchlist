import { z } from "zod";
import { buildDigestHtml, sendDigest } from "@/lib/notify";
import { store } from "@/lib/store";
import type { Release } from "@/lib/types";

const TestBody = z.object({
  to: z.string().trim().email().max(320).optional(),
});

export async function POST(req: Request) {
  let body: unknown = {};
  try {
    const text = await req.text();
    body = text ? (JSON.parse(text) as unknown) : {};
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = TestBody.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const sample: Release = {
    id: "sample-test-release",
    source: "company",
    title: "Sample release — notification test send",
    url: "https://example.com/news/sample-release",
    date: "09-Oct-2026",
    hash: "test",
    firstSeenAt: new Date().toISOString(),
  };
  const html = buildDigestHtml([sample], { title: "Watchlist test digest" });

  try {
    const state = await store.getNotifications();
    const to = parsed.data.to ?? state.recipients[0];
    if (!to) {
      return Response.json(
        { error: "No recipient: provide {to} or save recipients first" },
        { status: 400 },
      );
    }

    const result = await sendDigest({
      to: [to],
      subject: "Watchlist test digest",
      html,
    });
    return Response.json({ sent: result.sent, preview: result.previewUrl });
  } catch (err) {
    console.error("POST /api/notify/test failed", err);
    return Response.json(
      { error: "Test send failed", preview: html },
      { status: 500 },
    );
  }
}
