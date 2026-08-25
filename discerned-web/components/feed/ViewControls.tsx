// Sort + List/Stream view toggle row, shared by the Discerns feed and the private
// Library sidebar. 'list' shows sidebar + item list + a single detail pane; 'focus'
// (Stream) hides the item list and shows every filtered item's full detail, stacked
// and scrollable.

'use client';

export type SortOrder = 'recent' | 'oldest';
export type ViewMode = 'list' | 'focus';

interface ViewControlsProps {
  sortOrder: SortOrder;
  setSortOrder: (o: SortOrder) => void;
  viewMode: ViewMode;
  setViewMode: (m: ViewMode) => void;
}

function Icon({ name }: { name: 'chevdown' | 'list' | 'stack' }) {
  const paths: Record<string, React.ReactNode> = {
    chevdown: <polyline points="6 9 12 15 18 9" />,
    list: <><rect x="3" y="4" width="8" height="16" rx="1.5" /><rect x="13" y="4" width="8" height="16" rx="1.5" /></>,
    stack: <><rect x="4" y="3" width="16" height="6" rx="1.5" /><rect x="4" y="11" width="16" height="6" rx="1.5" /><rect x="4" y="19" width="16" height="2.5" rx="1.25" /></>,
  };
  return (
    <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      {paths[name]}
    </svg>
  );
}

export default function ViewControls({ sortOrder, setSortOrder, viewMode, setViewMode }: ViewControlsProps) {
  return (
    <div className="feed-controls">
      <button
        className="sort"
        onClick={() => setSortOrder(sortOrder === 'recent' ? 'oldest' : 'recent')}
      >
        Sort: {sortOrder === 'recent' ? 'Recent' : 'Oldest'} <Icon name="chevdown" />
      </button>
      <div className="density">
        <button className={viewMode === 'list' ? 'active' : ''} onClick={() => setViewMode('list')} title="List view">
          <Icon name="list" />
        </button>
        <button className={viewMode === 'focus' ? 'active' : ''} onClick={() => setViewMode('focus')} title="Stream view (full detail, scrollable)">
          <Icon name="stack" />
        </button>
      </div>
    </div>
  );
}
