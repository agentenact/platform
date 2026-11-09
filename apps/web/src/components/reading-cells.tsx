import type { Cell } from '@/lib/reading-cells';

/** The small grid of what a check read (Change, Your limit, Price now). Empty cells draw nothing. */
export function ReadingCells({ cells }: { cells: Cell[] }) {
  if (cells.length === 0) return null;
  return (
    <div data-readings="" className="mt-3 grid grid-cols-3 gap-2">
      {cells.map((c) => (
        <div key={c.label} className="min-w-0 rounded-xl border border-line px-3 py-2">
          <small className="block text-xs text-fg-3">{c.label}</small>
          <strong className="block break-words text-[15px] font-semibold">{c.value}</strong>
        </div>
      ))}
    </div>
  );
}
