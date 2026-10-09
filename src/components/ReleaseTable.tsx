export interface ReleaseItem {
  source: string;
  title: string;
  url: string;
  date: string;
}

export default function ReleaseTable({
  releases,
}: {
  releases: ReleaseItem[];
}) {
  if (!releases || releases.length === 0) {
    return (
      <div className="rounded-xl border border-[#dfdfdf] bg-white p-6 text-center">
        <p className="text-sm text-[#707070]">
          No releases found. Try a different company or project name.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-[#dfdfdf] bg-white">
      {/* Desktop table */}
      <table className="hidden w-full text-left text-sm md:table">
        <thead>
          <tr className="border-b border-[#ededed] bg-[#fafafa] text-xs font-medium text-[#707070]">
            <th className="px-4 py-3">Source</th>
            <th className="px-4 py-3">Date</th>
            <th className="px-4 py-3">Title</th>
            <th className="px-4 py-3 text-right">Link</th>
          </tr>
        </thead>
        <tbody>
          {releases.map((r, i) => (
            <tr
              key={`${r.url}-${i}`}
              className="border-b border-[#efefef] last:border-0"
            >
              <td className="px-4 py-3">
                <span className="inline-block rounded-full bg-[#fafafa] px-2 py-0.5 text-xs text-[#171717] ring-1 ring-[#ededed]">
                  {r.source}
                </span>
              </td>
              <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-[#707070]">
                {r.date}
              </td>
              <td className="px-4 py-3 font-medium text-[#171717]">{r.title}</td>
              <td className="px-4 py-3 text-right">
                <a
                  href={r.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-medium text-[#171717] underline hover:text-[#24b47e]"
                >
                  Open
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Mobile cards */}
      <ul className="divide-y divide-[#efefef] md:hidden">
        {releases.map((r, i) => (
          <li key={`${r.url}-${i}`} className="flex flex-col gap-2 p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-block rounded-full bg-[#fafafa] px-2 py-0.5 text-xs text-[#171717] ring-1 ring-[#ededed]">
                {r.source}
              </span>
              <span className="font-mono text-xs text-[#707070]">{r.date}</span>
            </div>
            <p className="text-sm font-medium text-[#171717]">{r.title}</p>
            <a
              href={r.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-[#171717] underline hover:text-[#24b47e]"
            >
              Open release
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
