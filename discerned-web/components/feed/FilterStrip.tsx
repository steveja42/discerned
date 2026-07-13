// Active filter pill bar rendered below the feed header when any filter is set.
// Returns null when no filters are active so it takes up no layout space.

'use client';

interface FilterStripProps {
  activeSignals: string[];
  activeQuals: string[];
  activeCat: string | null;
  onClearSignal: (s: string) => void;
  onClearQual: (q: string) => void;
  onClearCat: () => void;
  onClearAll: () => void;
}

export default function FilterStrip({
  activeSignals,
  activeQuals,
  activeCat,
  onClearSignal,
  onClearQual,
  onClearCat,
  onClearAll,
}: FilterStripProps) {
  const hasFilters = activeSignals.length > 0 || activeQuals.length > 0 || !!activeCat;
  if (!hasFilters) return null;

  return (
    <div className="active-filters">
      <span className="label">Filters</span>
      {activeSignals.map((s) => (
        <span key={s} className="active-pill">
          Signal: {s}
          <span className="x" onClick={() => onClearSignal(s)}>×</span>
        </span>
      ))}
      {activeQuals.map((q) => (
        <span key={q} className="active-pill">
          {q}
          <span className="x" onClick={() => onClearQual(q)}>×</span>
        </span>
      ))}
      {activeCat && (
        <span className="active-pill">
          {activeCat}
          <span className="x" onClick={onClearCat}>×</span>
        </span>
      )}
      <button className="clear-all" onClick={onClearAll}>Clear all</button>
    </div>
  );
}
