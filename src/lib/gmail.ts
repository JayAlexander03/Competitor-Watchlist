/**
 * Gmail API sending with zero new dependencies (native fetch only).
 *
 * Auth uses OAuth2 refresh token flow:
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GMAIL_REFRESH_TOKEN
 * Sending identity comes from GMAIL_SENDER.
 */

export interface RawMessageOptions {
  from: string;
  to: string;
  subject: string;
  html: string;
}

export interface SendGmailOptions {
  to: string | string[];
  subject: string;
  html: string;
}

function requiredEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

/** True when all env vars needed for Gmail sending are present. */
export function isGmailConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID?.trim() &&
      process.env.GOOGLE_CLIENT_SECRET?.trim() &&
      process.env.GMAIL_REFRESH_TOKEN?.trim() &&
      process.env.GMAIL_SENDER?.trim(),
  );
}

/**
 * Exchange the refresh token for a short-lived access token.
 * @throws with a clear message if env is missing or the token endpoint errors.
 */
export async function getGmailAccessToken(): Promise<string> {
  const client_id = requiredEnv("GOOGLE_CLIENT_ID");
  const client_secret = requiredEnv("GOOGLE_CLIENT_SECRET");
  const refresh_token = requiredEnv("GMAIL_REFRESH_TOKEN");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id,
      client_secret,
      refresh_token,
    }).toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Gmail token exchange failed (${res.status}): ${text || res.statusText}`,
    );
  }

  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error("Gmail token exchange failed: no access_token in response");
  }
  return data.access_token;
}

/** Encode a Subject header value (base64 utf-8 only when non-ascii). */
function encodeSubject(subject: string): string {
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`;
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input as string)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Construct a minimal MIME message and base64url-encode the whole message
 * (no padding), as required by Gmail API users.messages.send.
 */
export function buildRawMessage({ from, to, subject, html }: RawMessageOptions): string {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(html, "utf-8").toString("base64"),
  ];
  return base64UrlEncode(lines.join("\r\n"));
}

/**
 * Send an HTML email via the Gmail API.
 * @throws if GMAIL_SENDER is missing, token exchange fails, or send fails.
 */
export async function sendGmail({
  to,
  subject,
  html,
}: SendGmailOptions): Promise<{ id: string }> {
  const from = requiredEnv("GMAIL_SENDER");
  const recipients = (Array.isArray(to) ? to : [to])
    .map((t) => t.trim())
    .filter(Boolean);
  if (recipients.length === 0) throw new Error("sendGmail: no recipients");

  const accessToken = await getGmailAccessToken();
  const raw = buildRawMessage({
    from,
    to: recipients.join(", "),
    subject,
    html,
  });

  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw }),
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Gmail send failed (${res.status}): ${text || res.statusText}`,
    );
  }

  const data = (await res.json()) as { id?: string };
  return { id: data.id ?? "" };
}
