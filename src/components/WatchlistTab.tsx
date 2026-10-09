'use client';

import { useCallback, useEffect, useState } from 'react';
import ReleaseTable, { type ReleaseItem } from './ReleaseTable';

interface WatchItem {
  id: string;
  company: string;
  project: string;
  pressUrl?: string;
  pressConfig?: { newsUrl?: string; url?: string };
  createdAt?: string;
  lastCheckedAt?: string | null;
  releases?: ReleaseItem[];
}

function extractItems(json: unknown): WatchItem[] {
  if (Array.isArray(json)) return json as WatchItem[];
  if (json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    for (const key of ['items', 'watchlist', 'data', 'releases']) {
      if (Array.isArray(o[key])) return o[key] as WatchItem[];
    }
  }
  return [];
}

function sedarUrl(company: string): string {
  return `https://www.sedarplus.ca/csa-party/records/search.html?query=${encodeURIComponent(company)}`;
}

export default function WatchlistTab() {
  const [items, setItems] = useState<WatchItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/watchlist', { cache: 'no-store' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (json as { error?: string }).error ??
            `Load failed (${res.status}).`
        );
      }
      setItems(extractItems(json));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Load failed.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial mount sync from /api/watchlist external system
    load();
  }, [load]);

  async function handleRemove(id: string) {
    setRemovingId(id);
    setError(null);
    setSummary(null);
    try {
      const res = await fetch(`/api/watchlist?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (json as { error?: string }).error ??
            `Remove failed (${res.status}).`
        );
      }
      setItems((prev) => (prev ?? []).filter((it) => it.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Remove failed.');
    } finally {
      setRemovingId(null);
    }
  }

  async function handleRefresh() {
    setRefreshing(true);
    setError(null);
    setSummary(null);
    try {
      const res = await fetch('/api/watchlist/refresh', { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (json as { error?: string }).error ??
            `Refresh failed (${res.status}).`
        );
      }
      const o = json as Record<string, unknown>;
      const msg =
        typeof o.message === 'string'
          ? o.message
          : typeof o.summary === 'string'
            ? o.summary
            : `Checked ${Array.isArray(o.results) ? (o.results as unknown[]).length : items?.length ?? 0} project(s).` +
              (typeof o.newCount === 'number' ? ` ${o.newCount} new release(s).` : '');
      setSummary(msg);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Refresh failed.');
    } finally {
      setRefreshing(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-[#707070]">Loading watchlist…</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[#707070]">
          {items?.length ?? 0} project(s) watched
        </p>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing || (items?.length ?? 0) === 0}
          className="rounded-md bg-[#3ecf8e] px-4 py-2 text-sm font-medium text-[#171717] disabled:opacity-50"
        >
          {refreshing ? 'Refreshing…' : 'Refresh All'}
        </button>
      </div>

      {error && (
        <p role="alert" className="text-sm text-[#e2005a]">
          {error}
        </p>
      )}
      {summary && (
        <p role="status" className="rounded-md border border-[#dfdfdf] bg-[#fafafa] px-3 py-2 text-sm text-[#212121]">
          {summary}
        </p>
      )}

      {(items ?? []).length === 0 ? (
        <div className="rounded-xl border border-[#dfdfdf] bg-white p-6 text-center">
          <p className="text-sm text-[#707070]">
            Watchlist is empty. Use the Search tab to verify and add a project.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {(items ?? []).map((item) => (
            <section
              key={item.id}
              className="rounded-xl border border-[#dfdfdf] bg-white p-6"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-medium text-[#171717]">
                    {item.company} — {item.project}
                  </h2>
                  <p className="mt-1 font-mono text-xs text-[#707070]">
                    Last checked:{' '}
                    {item.lastCheckedAt ?? 'never'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleRemove(item.id)}
                  disabled={removingId === item.id}
                  className="rounded-md border border-[#c7c7c7] bg-white px-3 py-1.5 text-sm font-medium text-[#171717] disabled:opacity-50"
                >
                  {removingId === item.id ? 'Removing…' : 'Remove'}
                </button>
              </div>

              <div className="mt-4">
                <ReleaseTable releases={item.releases ?? []} />
              </div>

              <div className="mt-4 rounded-md border border-[#ededed] bg-[#fafafa] p-4">
                <p className="text-sm font-medium text-[#171717]">
                  SEDAR+ filings
                </p>
                <p className="mt-1 text-sm text-[#707070]">
                  SEDAR+ has no public API — open the issuer profile to check
                  filings manually.
                </p>
                <a
                  href={sedarUrl(item.company)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-block text-sm font-medium text-[#171717] underline hover:text-[#24b47e]"
                >
                  Open SEDAR+ profile search for {item.company}
                </a>
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
