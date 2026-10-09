'use client';

import { useState } from 'react';
import ReleaseTable, { type ReleaseItem } from './ReleaseTable';

function extractReleases(json: unknown): ReleaseItem[] {
  if (Array.isArray(json)) return json as ReleaseItem[];
  if (json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    for (const key of ['releases', 'results', 'items', 'data']) {
      if (Array.isArray(o[key])) return o[key] as ReleaseItem[];
    }
  }
  return [];
}

export default function SearchTab() {
  const [company, setCompany] = useState('');
  const [project, setProject] = useState('');
  const [pressUrl, setPressUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [releases, setReleases] = useState<ReleaseItem[] | null>(null);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setStatus(null);
    setReleases(null);
    if (!company.trim() || !project.trim()) {
      setError('Company and project are required.');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company: company.trim(),
          project: project.trim(),
          ...(pressUrl.trim() ? { pressUrl: pressUrl.trim() } : {}),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (json as { error?: string }).error ??
            `Search failed (${res.status}).`
        );
      }
      setReleases(extractReleases(json).slice(0, 3));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed.');
    } finally {
      setLoading(false);
    }
  }

  async function handleAdd() {
    setError(null);
    setStatus(null);
    setAdding(true);
    try {
      const res = await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company: company.trim(),
          project: project.trim(),
          ...(pressUrl.trim() ? { pressUrl: pressUrl.trim() } : {}),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (json as { error?: string }).error ??
            `Add failed (${res.status}).`
        );
      }
      setStatus('Added to watchlist. Verify it under the Watchlist tab.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Add failed.');
    } finally {
      setAdding(false);
    }
  }

  const inputCls =
    'w-full rounded-md border border-[#dfdfdf] bg-white px-3 py-2 text-base text-[#171717] placeholder:text-[#b2b2b2] focus:border-[#3ecf8e] focus:outline-none';

  return (
    <div className="flex flex-col gap-6">
      <form
        onSubmit={handleSearch}
        className="rounded-xl border border-[#dfdfdf] bg-white p-6"
      >
        <h2 className="text-lg font-medium text-[#171717]">
          Verify before you watch
        </h2>
        <p className="mt-1 text-sm text-[#707070]">
          Search a company + project, review the top 3 releases, then add.
        </p>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm font-medium text-[#171717]">
            Company
            <input
              className={inputCls}
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="e.g. Northern Superior"
              required
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium text-[#171717]">
            Project
            <input
              className={inputCls}
              value={project}
              onChange={(e) => setProject(e.target.value)}
              placeholder="e.g. Philibert"
              required
            />
          </label>
        </div>
        <label className="mt-4 flex flex-col gap-1 text-sm font-medium text-[#171717]">
          Company news URL (optional)
          <input
            className={inputCls}
            value={pressUrl}
            onChange={(e) => setPressUrl(e.target.value)}
            placeholder="https://…/news-releases"
            inputMode="url"
          />
        </label>
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
        <div className="mt-4">
          <button
            type="submit"
            disabled={loading}
            className="rounded-md bg-[#3ecf8e] px-4 py-2 text-sm font-medium text-[#171717] disabled:opacity-50"
          >
            {loading ? 'Searching…' : 'Search'}
          </button>
        </div>
      </form>

      {loading && (
        <p className="text-sm text-[#707070]">Searching company + news feeds…</p>
      )}

      {releases !== null && !loading && (
        <div className="flex flex-col gap-4">
          <ReleaseTable releases={releases} />
          {releases.length > 0 && (
            <div>
              <button
                type="button"
                onClick={handleAdd}
                disabled={adding}
                className="rounded-md border border-[#c7c7c7] bg-white px-4 py-2 text-sm font-medium text-[#171717] disabled:opacity-50"
              >
                {adding ? 'Adding…' : 'Add to watchlist'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
