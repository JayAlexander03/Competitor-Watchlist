import { connection } from "next/server";
import { z } from "zod";
import { requireApiAuth } from "@/lib/api-auth";
import { store } from "@/lib/store";

const RecipientsBody = z.object({
  recipients: z.array(z.string().trim().email().max(320)).max(20),
});

export async function GET() {
  const unauthorized = await requireApiAuth();
  if (unauthorized) return unauthorized;
  await connection();
  try {
    const state = await store.getNotifications();
    return Response.json({
      recipients: state.recipients,
      lastCheckAt: state.lastCheckAt,
      lastResult: state.lastResult,
      testSender: { enabled: Boolean(process.env.RESEND_TO?.trim()) },
    });
  } catch (err) {
    console.error("GET /api/notifications/recipients failed", err);
    return Response.json(
      { error: "Failed to load recipients" },
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

  const parsed = RecipientsBody.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const unique = [...new Set(parsed.data.recipients)];
    const state = await store.setRecipients(unique);
    return Response.json({ recipients: state.recipients });
  } catch (err) {
    console.error("POST /api/notifications/recipients failed", err);
    return Response.json(
      { error: "Failed to save recipients" },
      { status: 500 },
    );
  }
}
