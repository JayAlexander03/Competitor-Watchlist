const FALLBACK_REDIRECT_URI =
  "http://localhost:3000/api/auth/gmail/callback";

export async function GET(): Promise<Response> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return Response.json(
      { error: "Missing GOOGLE_CLIENT_ID in .env" },
      { status: 500 },
    );
  }
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI || FALLBACK_REDIRECT_URI;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/gmail.send",
    access_type: "offline",
    prompt: "consent",
  });
  return Response.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
  );
}
