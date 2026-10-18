'use client';

import { useEffect, useState } from 'react';

function extractEmails(json: unknown): string[] {
  if (Array.isArray(json)) return json.map(String);
  if (json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    for (const key of ['recipients', 'emails', 'addresses']) {
      if (Array.isArray(o[key])) return (o[key] as unknown[]).map(String);
    }
  }
  return [];
}

function parseList(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    )
  );
}

export default function NotificationsTab() {
  const [raw, setRaw] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [lastCheck, setLastCheck] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [r1, r2] = await Promise.all([
          fetch('/api/notifications/recipients', { cache: 'no-store' }),
          fetch('/api/watchlist', { cache: 'no-store' }),
        ]);
        if (r1.ok) {
          const j = await r1.json().catch(() => ({}));
          setRaw(extractEmails(j).join('\n'));
        }
        if (r2.ok) {
          const j = await r2.json().catch(() => null);
          const items = Array.isArray(j)
            ? j
            : (j as { items?: { lastCheckedAt?: string }[] })?.items ?? [];
          const times = (items as { lastCheckedAt?: string }[])
            .map((i) => i.lastCheckedAt)
            .filter((t): t is string => Boolean(t))
            .sort();
          setLastCheck(times.length > 0 ? times[times.length - 1] : 'never');
        } else {
          setLastCheck('unknown');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Load failed.');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const recipients = parseList(raw);
      const res = await fetch('/api/notifications/recipients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipients }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (json as { error?: string }).error ?? `Save failed (${res.status}).`
        );
      }
      setStatus(`Saved ${recipients.length} recipient(s).`);
      setRaw(extractEmails(json).join('\n') || recipients.join('\n'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setError(null);
    setStatus(null);
    setPreview(null);
    try {
      const recipients = parseList(raw);
      const res = await fetch('/api/notify/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          recipients.length > 0 ? { to: recipients[0] } : {}
        ),
      });
      const json = await res.json().catch(() => ({}));
      const outcome = json as {
        sent?: boolean;
        preview?: string;
        error?: string;
      };
      if (outcome.preview) setPreview(outcome.preview);
      if (!res.ok) {
        throw new Error(outcome.error ?? `Test failed (${res.status}).`);
      }
      if (outcome.sent) {
        setStatus('Test email sent. Check the inbox (and spam folder).');
      } else {
        setError(
          'Test email was NOT sent — Gmail API rejected it or is not configured. Check GMAIL_SENDER / GMAIL_REFRESH_TOKEN / GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env and restart the dev server. The digest preview below shows what would have been sent.'
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Test failed.');
    } finally {
      setTesting(false);
    }
  }

  const emails = parseList(raw);
  const mailto = `mailto:${encodeURIComponent(emails.join(','))}?subject=${encodeURIComponent('Competitor Watchlist digest')}`;

  if (loading) {
    return <p className="text-sm text-[#707070]">Loading notification settings…</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <form
        onSubmit={handleSave}
        className="rounded-xl border border-[#dfdfdf] bg-white p-6"
      >
        <h2 className="text-lg font-medium text-[#171717]">Email recipients</h2>
        <p className="mt-1 text-sm text-[#707070]">
          One email per line, or comma-separated. Daily digests go to this list.
        </p>
        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          rows={5}
          placeholder="analyst@example.com&#10;team@example.com"
          className="mt-4 w-full rounded-md border border-[#dfdfdf] bg-white px-3 py-2 font-mono text-sm text-[#171717] placeholder:text-[#b2b2b2] focus:border-[#3ecf8e] focus:outline-none"
        />
        {error && (
          <p role="alert" className="mt-3 text-sm text-[#e2005a]">
            {error}
          </p>
        )}
        {status && (
          <p role="status" className="mt-3 text-sm text-[#212121]">
            {status}
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-[#3ecf8e] px-4 py-2 text-sm font-medium text-[#171717] disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save recipients'}
          </button>
          <button
            type="button"
            onClick={handleTest}
            disabled={testing}
            className="rounded-md border border-[#c7c7c7] bg-white px-4 py-2 text-sm font-medium text-[#171717] disabled:opacity-50"
          >
            {testing ? 'Sending…' : 'Send test email'}
          </button>
        </div>
      </form>

      <div className="rounded-xl border border-[#dfdfdf] bg-white p-6">
        <h2 className="text-lg font-medium text-[#171717]">Status</h2>
        <p className="mt-1 font-mono text-xs text-[#707070]">
          Last check: {lastCheck ?? 'unknown'} · {emails.length} recipient(s)
        </p>
        {preview && (
          <details className="mt-3 rounded-md border border-[#ededed] bg-[#fafafa] p-3">
            <summary className="cursor-pointer text-sm font-medium text-[#171717]">
              Digest preview (what would have been sent)
            </summary>
            <iframe
              title="Digest preview"
              srcDoc={preview}
              className="mt-2 h-64 w-full rounded-md border border-[#dfdfdf] bg-white"
            />
          </details>
        )}
        <a
          href={mailto}
          className="mt-3 inline-block text-sm font-medium text-[#171717] underline hover:text-[#24b47e]"
        >
          Open mail client fallback (mailto:)
        </a>
      </div>
    </div>
  );
}
