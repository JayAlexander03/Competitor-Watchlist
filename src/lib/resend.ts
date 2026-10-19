/**
 * Resend API sending with zero new dependencies (native fetch only).
 *
 * Auth uses RESEND_API_KEY. The sender identity comes from RESEND_FROM and
 * defaults to onboarding@resend.dev.
 *
 * Test-sender limitation: with `onboarding@resend.dev`, Resend only delivers
 * to the account owner (the email address the Resend account was created
 * with). Any other recipient is rejected or silently restricted by Resend.
 * This is why notify.ts resolves recipients through RESEND_TO, which lets the
 * account owner receive test digests regardless of the addresses saved in the
 * watchlist.
 */

export interface SendResendOptions {
  to: string | string[];
  subject: string;
  html: string;
  replyTo?: string;
}

/** True when RESEND_API_KEY is present. */
export function isResendConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim());
}

/**
 * Send an HTML email via the Resend API.
 * @throws if RESEND_API_KEY is missing, there are no recipients, or the send fails.
 */
export async function sendResend({
  to,
  subject,
  html,
  replyTo,
}: SendResendOptions): Promise<{ id: string }> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("sendResend: RESEND_API_KEY is not configured");
  }

  const from = process.env.RESEND_FROM?.trim() || "onboarding@resend.dev";
  const recipients = (Array.isArray(to) ? to : [to])
    .map((t) => t.trim())
    .filter(Boolean);
  if (recipients.length === 0) throw new Error("sendResend: no recipients");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: recipients,
      subject,
      html,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = "";
    try {
      const data = JSON.parse(text) as { message?: string };
      message = data.message?.trim() ?? "";
    } catch {
      // Non-JSON error body; fall back to the raw text below.
    }
    throw new Error(
      `Resend send failed (${res.status}): ${
        message || text.trim() || res.statusText
      }`,
    );
  }

  const data = (await res.json()) as { id?: string };
  return { id: data.id ?? "" };
}
