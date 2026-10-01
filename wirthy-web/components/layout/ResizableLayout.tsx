'use client';

import { useRef, useCallback, useState, useSyncExternalStore, type ReactNode } from 'react';

interface ResizableLayoutProps {
  sidebar: ReactNode;
  feed: ReactNode;
  detail: ReactNode;
  showDetail?: boolean;
  showFeed?: boolean;
  initialSidebarWidth?: number;
}

const MIN_SIDEBAR = 160;
const MAX_SIDEBAR = 400;
const MIN_FEED = 280;
const MIN_DETAIL = 260;
const STACK_BREAKPOINT = 900;

// The viewport is an external store, so read it with useSyncExternalStore rather
// than mirroring it into state from an effect — that costs an extra render on
// every mount and briefly lays out wide on a narrow screen.
const stackedQuery = () => window.matchMedia(`(max-width: ${STACK_BREAKPOINT}px)`);
function subscribeStacked(fn: () => void) {
  const mq = stackedQuery();
  mq.addEventListener('change', fn);
  return () => mq.removeEventListener('change', fn);
}
const getStackedSnapshot = () => stackedQuery().matches;
// No viewport on the server; assume the unstacked desktop layout.
const getStackedServerSnapshot = () => false;

export default function ResizableLayout({
  sidebar,
  feed,
  detail,
  showDetail = true,
  showFeed = true,
  initialSidebarWidth = 200,
}: ResizableLayoutProps) {
  const [sidebarW, setSidebarW] = useState(initialSidebarWidth);
  // null = use CSS fr-based default; number = user has dragged, use px
  const [detailW, setDetailW] = useState<number | null>(null);
  const stacked = useSyncExternalStore(subscribeStacked, getStackedSnapshot, getStackedServerSnapshot);
  const containerRef = useRef<HTMLDivElement>(null);

  const startDrag = useCallback(
    (
      e: React.MouseEvent,
      setter: (w: number) => void,
      getNewWidth: (dx: number, containerW: number, currentW: number) => number,
    ) => {
      e.preventDefault();
      const startX = e.clientX;
      const containerW = containerRef.current?.offsetWidth ?? window.innerWidth;
      // If detail hasn't been dragged yet, measure its current rendered width
      const currentDetailW = detailW ?? (containerRef.current
        ? containerRef.current.offsetWidth - sidebarW - 8
        : 600);
      const currentW = setter === setSidebarW ? sidebarW : currentDetailW;

      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        setter(getNewWidth(dx, containerW, currentW));
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [sidebarW, detailW],
  );

  const dragSidebar = useCallback(
    (e: React.MouseEvent) => {
      startDrag(e, setSidebarW, (dx, _cw, cur) =>
        Math.max(MIN_SIDEBAR, Math.min(MAX_SIDEBAR, cur + dx)),
      );
    },
    [startDrag],
  );

  const dragDetail = useCallback(
    (e: React.MouseEvent) => {
      startDrag(e, setDetailW as (w: number) => void, (dx, cw, cur) => {
        const maxDetail = cw - sidebarW - MIN_FEED - 8;
        return Math.max(MIN_DETAIL, Math.min(maxDetail, cur - dx));
      });
    },
    [startDrag, sidebarW],
  );

  let gridStyle: React.CSSProperties;
  if (stacked) {
    // 2-column: [sidebar + feed pane] | resizer | detail
    const rightCol = showDetail
      ? detailW !== null ? `${detailW}px` : `1fr`
      : `0px`;
    gridStyle = {
      gridTemplateColumns: showDetail ? `1fr 4px ${rightCol}` : `1fr`,
    };
  } else if (!showFeed) {
    // Feed column hidden: sidebar | resizer | detail (fills remaining space)
    gridStyle = { gridTemplateColumns: `${sidebarW}px 4px 1fr` };
  } else {
    // Single row, all columns
    const cols = showDetail
      ? detailW !== null
        ? `${sidebarW}px 4px 1fr 4px ${detailW}px`
        : `${sidebarW}px 4px 1fr 4px 1.4fr`
      : `${sidebarW}px 4px 1fr`;
    gridStyle = { gridTemplateColumns: cols };
  }

  return (
    <div
      ref={containerRef}
      className={`main resizable-main${stacked ? ' main--stacked' : ''}`}
      style={gridStyle}
    >
      {stacked ? (
        <div className="left-pane">
          {sidebar}
          {showFeed && feed}
        </div>
      ) : (
        <>
          {sidebar}
          <div
            className="col-resizer"
            onMouseDown={dragSidebar}
            title="Drag to resize"
          />
          {showFeed && feed}
        </>
      )}

      {showDetail && (
        <>
          {(stacked || showFeed) && (
            <div
              className="col-resizer"
              onMouseDown={dragDetail}
              title="Drag to resize"
            />
          )}
          {detail}
        </>
      )}
    </div>
  );
}
