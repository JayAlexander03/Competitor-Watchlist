import type { Release } from "./types";

export interface DigestGroup {
  company: string;
  project: string;
  releases: Release[];
}

export interface DigestOptions {
  /** Heading override (used by the flat Release[] form). */
  title?: string;
}

export interface SendResult {
  sent: boolean;
  preview?: string;
  /** Alias of preview (HTML source) for callers that render it directly. */
  previewUrl?: string;
}

function escapeHtml(s: string): string {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Build an HTML digest email. Accepts either grouped input
 * ({company, project, releases}[]) — one section per group — or a flat
 * Release[] with an optional heading override (e.g. test sends).
 */
export function buildDigestHtml(newItems: DigestGroup[]): string;
export function buildDigestHtml(
  releases: Release[],
  opts?: DigestOptions,
): string;
export function buildDigestHtml(
  input: DigestGroup[] | Release[],
  opts?: DigestOptions,
): string {
  const heading = opts?.title ?? "Competitor Watchlist — Daily Digest";
  const groups: DigestGroup[] =
    Array.isArray(input) &&
    input.length > 0 &&
    "releases" in (input[0] as DigestGroup)
      ? (input as DigestGroup[])
      : [{ company: "", project: "", releases: (input ?? []) as Release[] }];
  const newItems = groups;
  const showGroupHeadings = newItems.some((g) => g.company || g.project);
  const body =
    newItems.length === 0 ||
    newItems.every((g) => g.releases.length === 0)
      ? `<p style="color:#555;">No new releases since the last check.</p>`
      : newItems
          .map((g) => {
            const items = g.releases
              .map(
                (r) =>
                  `<li style="margin:6px 0;">` +
                  `<span style="color:#666;font-size:12px;">${escapeHtml(r.date)} · ${escapeHtml(r.source)}</span><br/>` +
                  `<a href="${escapeHtml(r.url)}" style="color:#0b6e4f;">${escapeHtml(r.title)}</a>` +
                  `</li>`,
              )
              .join("");
            const subhead =
              showGroupHeadings && (g.company || g.project)
                ? `<h2 style="font-size:16px;margin:20px 0 6px;">${escapeHtml(g.company)} — ${escapeHtml(g.project)}</h2>`
                : "";
            return subhead + `<ul style="padding-left:20px;margin:0;">${items}</ul>`;
          })
          .join("");
  return (
    `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;color:#171717;">` +
    `<h1 style="font-size:20px;">${escapeHtml(heading)}</h1>` +
    body +
    `<hr style="margin-top:24px;border:none;border-top:1px solid #ddd;"/>` +
    `<p style="color:#888;font-size:12px;">SEDAR+ entries link out to SEDAR+ search (no public API). Unsubscribe via the Notifications tab.</p>` +
    `</body></html>`
  );
}

export interface SendDigestOptions {
  to: string[];
  subject: string;
  html: string;
}

/**
 * Send the digest via SMTP (nodemailer). Defaults suit Outlook.com
 * (smtp-mail.outlook.com:587 + app password).
 * If credentials/recipients are missing — or sending fails — returns
 * {sent:false, preview:html, previewUrl:html} without throwing.
 */
export async function sendDigest(
  to: string[],
  subject: string,
  html: string,
): Promise<SendResult>;
export async function sendDigest(opts: SendDigestOptions): Promise<SendResult>;
export async function sendDigest(
  toOrOpts: string[] | SendDigestOptions,
  subject?: string,
  html?: string,
): Promise<SendResult> {
  const to = Array.isArray(toOrOpts) ? toOrOpts : toOrOpts.to;
  const subj = Array.isArray(toOrOpts) ? (subject ?? "") : toOrOpts.subject;
  const body = Array.isArray(toOrOpts) ? (html ?? "") : toOrOpts.html;
  const fail = (): SendResult => ({ sent: false, preview: body, previewUrl: body });
  try {
    const recipients = (to ?? []).map((t) => t.trim()).filter(Boolean);
    const host = process.env.SMTP_HOST ?? "smtp-mail.outlook.com";
    const port = Number(process.env.SMTP_PORT ?? "587");
    const user =
      process.env.SMTP_USER ?? process.env.NOTIFY_USER ?? "";
    const pass =
      process.env.SMTP_PASS ?? process.env.NOTIFY_PASS ?? "";
    const from =
      process.env.NOTIFY_FROM ?? process.env.SMTP_FROM ?? user;
    if (!user || !pass || !from || recipients.length === 0) {
      return fail();
    }
    const mod = await import("nodemailer");
    const transporter = mod.default.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    });
    await transporter.sendMail({
      from,
      to: recipients.join(", "),
      subject: subj,
      html: body,
    });
    return { sent: true };
  } catch {
    return fail();
  }
}
