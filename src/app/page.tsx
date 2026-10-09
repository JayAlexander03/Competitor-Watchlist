import { Suspense } from 'react';
import SearchTab from '@/components/SearchTab';
import WatchlistTab from '@/components/WatchlistTab';
import NotificationsTab from '@/components/NotificationsTab';

type Tab = 'search' | 'watchlist' | 'notifications';

const TABS: { id: Tab; label: string }[] = [
  { id: 'search', label: 'Search' },
  { id: 'watchlist', label: 'Watchlist' },
  { id: 'notifications', label: 'Notifications' },
];

function fallback(label: string) {
  return <p className="text-sm text-[#707070]">Loading {label}…</p>;
}

function PageSkeleton() {
  return (
    <div className="min-h-full bg-white font-sans text-[#171717]">
      <header className="border-b border-[#ededed] bg-white">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-6 py-6">
          <h1 className="text-3xl font-medium tracking-tight">
            Competitor Watchlist
          </h1>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl px-6 py-8">
        <p className="text-sm text-[#707070]">Loading…</p>
      </main>
    </div>
  );
}

async function TabShell({
  searchParams,
}: {
  searchParams: PageProps<'/'>['searchParams'];
}) {
  const params = await searchParams;
  const raw = Array.isArray(params.tab) ? params.tab[0] : params.tab;
  const tab: Tab =
    raw === 'watchlist' || raw === 'notifications' ? raw : 'search';

  return (
    <div className="min-h-full bg-white font-sans text-[#171717]">
      <header className="border-b border-[#ededed] bg-white">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-6 py-6">
          <h1 className="text-3xl font-medium tracking-tight">
            Competitor Watchlist
          </h1>
          <nav aria-label="Tabs" className="flex gap-6">
            {TABS.map((t) => (
              <a
                key={t.id}
                href={t.id === 'search' ? '/' : `/?tab=${t.id}`}
                aria-current={tab === t.id ? 'page' : undefined}
                className={
                  tab === t.id
                    ? 'border-b-2 border-[#3ecf8e] pb-2 text-sm font-medium text-[#171717]'
                    : 'border-b-2 border-transparent pb-2 text-sm font-medium text-[#707070] hover:text-[#171717]'
                }
              >
                {t.label}
              </a>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl px-6 py-8">
        {tab === 'search' && (
          <Suspense fallback={fallback('search')}>
            <SearchTab />
          </Suspense>
        )}
        {tab === 'watchlist' && (
          <Suspense fallback={fallback('watchlist')}>
            <WatchlistTab />
          </Suspense>
        )}
        {tab === 'notifications' && (
          <Suspense fallback={fallback('notifications')}>
            <NotificationsTab />
          </Suspense>
        )}
      </main>
    </div>
  );
}

export default function Home({ searchParams }: PageProps<'/'>) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <TabShell searchParams={searchParams} />
    </Suspense>
  );
}
