'use client';

interface BulkActionBarProps {
  count: number;
  onDelete: () => void;
  onExport: () => void;
  onClear: () => void;
}

export default function BulkActionBar({ count, onDelete, onExport, onClear }: BulkActionBarProps) {
  return (
    <div className={`bulk-bar${count > 0 ? ' visible' : ''}`} aria-hidden={count === 0}>
      <span className="bulk-count">
        {count} clip{count !== 1 ? 's' : ''} selected
      </span>
      <button className="btn-bulk-cancel" onClick={onClear}>
        Cancel
      </button>
      <button className="btn-bulk-export" onClick={onExport}>
        Export {count}
      </button>
      <button className="btn-bulk-delete" onClick={onDelete}>
        Delete {count}
      </button>
    </div>
  );
}
