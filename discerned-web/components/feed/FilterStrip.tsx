// Active filter pill bar rendered below the feed header when any filter is set.
// Returns null when no filters are active so it takes up no layout space.

'use client';

import { INTEREST_LEVELS, ETHICS_LEVELS } from '@/lib/constants';

interface FilterStripProps {
  interestMin: number;
  ethicsMin: number;
  activeCat: string | null;
  onClearInterest: () => void;
  onClearEthics: () => void;
  onClearCat: () => void;
  onClearAll: () => void;
}

export default function FilterStrip({
  interestMin,
  ethicsMin,
  activeCat,
  onClearInterest,
  onClearEthics,
  onClearCat,
  onClearAll,
}: FilterStripProps) {
  const hasFilters = interestMin > 0 || ethicsMin > 0 || !!activeCat;
  if (!hasFilters) return null;

  return (
    <div className="active-filters">
      <span className="label">Filters</span>
      {interestMin > 0 && (
        <span className="active-pill">
          Interest ≥ {INTEREST_LEVELS[interestMin - 1]}
          <span className="x" onClick={onClearInterest}>×</span>
        </span>
      )}
      {ethicsMin > 0 && (
        <span className="active-pill">
          Ethics ≥ {ETHICS_LEVELS[ethicsMin - 1]}
          <span className="x" onClick={onClearEthics}>×</span>
        </span>
      )}
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
