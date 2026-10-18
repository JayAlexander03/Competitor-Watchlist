const FALLBACK_REDIRECT_URI =
  "http://localhost:3000/api/auth/gmail/callback";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlPage(title: string, body: string): Response {
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" />` +
      `<title>${escapeHtml(title)}</title></head>` +
      `<body style="font-family:Arial,sans-serif;max-width:640px;margin:48px auto;padding:0 16px;">` +
      body +
      `</body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

interface TokenSuccess {
  refresh_token?: string;
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const denied = url.searchParams.get("error");
  if (denied) {
    return new Response(`Authorization failed: ${denied}`, {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  const code = url.searchParams.get("code");
  if (!code) {
    return new Response("Missing authorization code", {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI || FALLBACK_REDIRECT_URI;

  let providerText = "";
  let providerOk = false;
  let data: TokenSuccess = {};
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID ?? "",
        client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    providerOk = res.ok;
    if (res.ok) {
      data = (await res.json()) as TokenSuccess;
    } else {
      providerText = await res.text();
    }
  } catch (err) {
    // Never include secrets or the auth code in error output.
    return new Response(
      `Token exchange failed: ${err instanceof Error ? err.message : "request failed"}`,
      {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      },
    );
  }

  if (!providerOk) {
    return new Response(`Token exchange failed: ${providerText}`, {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (!data.refresh_token) {
    return htmlPage(
      "Already consented",
      `<h1>Already consented — no refresh token issued</h1>` +
        `<p>Google only issues a <code>refresh_token</code> on the first consent. ` +
        `This account has already consented, so no new token was returned.</p>` +
        `<p>To get one: revoke access at ` +
        `<a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a> ` +
        `then visit <code>/api/auth/gmail</code> again (it already uses ` +
        `<code>prompt=consent</code>).</p>`,
    );
  }

  return htmlPage(
    "Gmail connected",
    `<h1>Gmail connected</h1>` +
      `<p>Copy this refresh token and paste it into <code>.env</code> as ` +
      `<code>GMAIL_REFRESH_TOKEN</code>, then restart the dev server:</p>` +
      `<pre style="background:#f4f4f4;padding:12px;overflow-x:auto;"><code>${escapeHtml(data.refresh_token)}</code></pre>`,
  );
}
