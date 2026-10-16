'use client';

import { useCallback, useEffect, useState } from 'react';
import ReleaseTable, { type ReleaseItem } from './ReleaseTable';

interface WatchItem {
  id: string;
  company: string;
  project: string;
  pressUrl?: string | null;
  pressConfig?: { newsUrl?: string; url?: string };
  createdAt?: string;
  lastCheckedAt?: string | null;
  releases?: ReleaseItem[];
}

function effectivePressUrl(item: WatchItem): string | null {
  return item.pressUrl ?? null;
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editUrl, setEditUrl] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

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

  async function handleSaveUrl(id: string) {
    setSavingId(id);
    setSaveError(null);
    try {
      const trimmed = editUrl.trim();
      const res = await fetch('/api/watchlist', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, pressUrl: trimmed ? trimmed : null }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (json as { error?: string }).error ??
            `Save failed (${res.status}).`,
        );
      }
      const updated = (json as { item?: WatchItem }).item;
      const nextUrl = updated ? effectivePressUrl(updated) : trimmed || null;
      setItems((prev) =>
        (prev ?? []).map((it) =>
          it.id === id ? { ...it, pressUrl: nextUrl } : it,
        ),
      );
      setEditingId(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSavingId(null);
    }
  }

  async function handleClearUrl(id: string) {
    setSavingId(id);
    setSaveError(null);
    try {
      const res = await fetch('/api/watchlist', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, pressUrl: null }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (json as { error?: string }).error ??
            `Clear failed (${res.status}).`,
        );
      }
      setItems((prev) =>
        (prev ?? []).map((it) =>
          it.id === id ? { ...it, pressUrl: null } : it,
        ),
      );
      setEditingId(null);
      setEditUrl('');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Clear failed.');
    } finally {
      setSavingId(null);
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

              {(() => {
                const url = effectivePressUrl(item);
                const isEditing = editingId === item.id;
                return (
                  <div className="mt-3">
                    {url ? (
                      <p className="text-sm text-[#171717]">
                        News source:{' '}
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline"
                        >
                          {url}
                        </a>
                      </p>
                    ) : (
                      <p className="text-sm text-[#707070]">
                        (no company URL — news+SEDAR only)
                      </p>
                    )}
                    {!isEditing ? (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(item.id);
                          setEditUrl(url ?? '');
                          setSaveError(null);
                        }}
                        className="mt-1 text-sm font-medium text-[#171717] underline hover:text-[#24b47e]"
                      >
                        Edit URL
                      </button>
                    ) : (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <input
                          value={editUrl}
                          onChange={(e) => setEditUrl(e.target.value)}
                          placeholder="https://…/news-releases"
                          inputMode="url"
                          className="w-full max-w-md rounded-md border border-[#dfdfdf] bg-white px-3 py-2 text-sm text-[#171717] placeholder:text-[#b2b2b2] focus:border-[#3ecf8e] focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => handleSaveUrl(item.id)}
                          disabled={savingId === item.id}
                          className="rounded-md bg-[#3ecf8e] px-3 py-1.5 text-sm font-medium text-[#171717] disabled:opacity-50"
                        >
                          {savingId === item.id ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleClearUrl(item.id)}
                          disabled={savingId === item.id}
                          className="rounded-md border border-[#c7c7c7] bg-white px-3 py-1.5 text-sm font-medium text-[#171717] disabled:opacity-50"
                        >
                          Clear
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(null);
                            setSaveError(null);
                          }}
                          className="text-sm font-medium text-[#707070] underline"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                    {isEditing && saveError && (
                      <p role="alert" className="mt-1 text-sm text-[#e2005a]">
                        {saveError}
                      </p>
                    )}
                  </div>
                );
              })()}

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
