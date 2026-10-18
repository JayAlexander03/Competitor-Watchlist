export async function GET(): Promise<Response> {
  const configured = Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GMAIL_REFRESH_TOKEN,
  );
  const senderPresent = Boolean(process.env.GMAIL_SENDER);
  return Response.json({ configured, senderPresent });
}
