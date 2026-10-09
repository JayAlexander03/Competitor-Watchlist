# Competitor Watchlist — PLAN.md

Source: `PROMPT.md` — mining exploration competitor watchlist (Search / Watchlist / Notifications).
Stack: Next.js 16.4.0 App Router, React 19, Tailwind 4, TypeScript. Design: `DESIGN.md` (Supabaze).

## Locked decisions (user-confirmed)

- Persistence: JSON file + store seam (`data/*.json`, atomic tmp+rename, `WatchlistStore` interface for future Vercel KV/Postgres swap).
- SEDAR: link-out placeholder (SEDAR+ has no public API, prohibits scraping). Build `sedarplus.ca` profile search URL per company; schema keeps `source: SEDAR` for future inbox-parse/CSV.
- Email: SMTP + app password via `nodemailer` (`smtp-mail.outlook.com:587`, Outlook.com 2FA + app password, SMTP AUTH on). Current `.env` placeholder `123456` must be replaced.
- Daily check: Manual `Refresh All` button + Windows Task Scheduler `curl` to refresh API. Same `checkAll()` reused; Vercel Cron later.
- AI: free-tier OpenRouter model (e.g. `meta-llama/llama-3.3-70b-instruct:free`) via Vercel AI SDK `generateObject` + `zod`, batched, verdict cached by URL hash.

New deps only (4): `ai`, `@openrouter/ai-sdk-provider`, `zod`, `nodemailer` (+ `@types/nodemailer` dev). Everything else native `fetch` + regex.

## 1. Architecture

```
src/app/          Server Components + Client tabs shell
src/lib/          Pure logic (testable without UI)
src/components/   UI per DESIGN.md
data/             gitignored JSON: watchlist.json, notifications.json
```

- `src/lib/store.ts` — `WatchlistStore` interface, file-JSON impl, in-process mutex, atomic writes.
- No DB, no auth, no cron lib, no headless browser, no paid news API for MVP.
- DESIGN.md Supabaze: white canvas `#ffffff`, ink `#171717`, single emerald `#3ecf8e` CTA with dark text, 6px buttons, 12px cards, Inter/Geist 500 display, mono code blocks.

## 2. Components

- `AppTabs`: `?tab=search|watchlist|notifications`, server shell + client tab state.
- Search tab: `SearchForm` (company, project, optional company news URL), `ReleaseTable` (source, date DD-MMM-YYYY, title, link, max 3 rows), `AddToWatchlistButton` (verification gate before add).
- Watchlist tab: `WatchlistGroup` per `{company, project}` → full release list + SEDAR link-out card + `lastCheckedAt` + per-item Remove; global `RefreshAllButton` → `POST /api/watchlist/refresh`.
- Notifications tab: `EmailListInput`, `LastCheckStatus`, `DigestPreview`, `TestSendButton`, `mailto:` fallback.

## 3. Routes

| Route | Method | Purpose |
|---|---|---|
| `/ ?tab=` | GET | 3-tab UI |
| `/api/search` | POST | On-demand pipeline, no persistence, top-3 |
| `/api/watchlist` | GET/POST/DELETE | CRUD `{company, project, pressConfig}` |
| `/api/watchlist/refresh` | POST | Manual daily check, `CRON_SECRET` header |
| `/api/cron/check` | GET | Same handler for Task Scheduler / future Vercel Cron |
| `/api/notifications/recipients` | GET/POST | Email list CRUD |
| `/api/notify/test` | POST | SMTP test send |

`lib/` split:
- `types.ts` — `Release {id, source: company|sedar|news, title, url, date DD-MMM-YYYY, hash, firstSeenAt}`, `WatchItem {id, company, project, pressConfig, createdAt, lastCheckedAt, releases[]}`.
- `sources/company.ts` — RSS → sitemap → HTML-list fallback, native fetch, 10s timeout.
- `sources/news.ts` — Google News RSS primary (`news.google.com/rss/search?q="Company"+"Project"`), Bing News RSS fallback, follow redirect lazily for top-3 only.
- `sources/sedar.ts` — link builder only.
- `relevance.ts` — keyword prefilter → OpenRouter `generateObject({relevant, reason, projectMentioned})`, batched, cached.
- `checker.ts` — `checkAll(): Promise<NewRelease[]>` shared by UI + cron.
- `notify.ts` — SMTP digest + `sentLog` idempotency.
- `store.ts` — file JSON CRUD.

## 4. Data flow

Search (verify before add):

```
POST /api/search {company, project}
→ Promise.allSettled([company RSS/sitemap, Google News RSS])
→ normalize → keyword prefilter → OpenRouter relevance (batched, cached)
→ top 3 → UI
```

Watchlist daily:

```
Refresh button / Task Scheduler curl → checkAll()
→ per project same pipeline (full list)
→ diff by normalized URL id + sha256(title|url|date) vs stored
→ new = flag + append sentLog → SMTP digest to recipients
```

Detection: `id` = normalized URL (lowercase, strip utm/#, trailing `/`) else `sha256(title+url+date)`; unseen `id` = new, notify once.

Env: `OPENROUTER_API_KEY`, `SMTP_HOST/PORT/USER/PASS`, `NOTIFY_FROM`, `CRON_SECRET`.

## 5. Implementation steps (no code yet)

1. Scaffold: tabs shell, `types.ts`, `store.ts` + `data/` gitignore, DESIGN tokens in `globals.css`.
2. Sources: `company.ts` + `news.ts` + `sedar.ts`, `POST /api/search` + Search UI (top-3).
3. Relevance: `relevance.ts` (ai + OpenRouter + zod), batched free-model, verdict cache.
4. Watchlist: CRUD API + UI + `checker.ts` + refresh/cron routes.
5. Notify: `notifications.json`, recipients API, `nodemailer` SMTP, digest preview + test send, Task Scheduler doc.
6. Verify: `eslint`, `tsc --noEmit`, `next build`, manual search → add → refresh → email preview.

## Deferred

DB (SQLite/Postgres/KV), auth, Graph OAuth, Vercel Cron deploy, full-article extraction, SEDAR inbox-parse/CSV import, embeddings/pgvector.
