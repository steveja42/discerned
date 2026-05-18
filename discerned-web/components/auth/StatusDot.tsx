'use client';

interface StatusDotProps {
  connected: boolean;
  tooltip: string;
  onClick?: () => void;
  label: string;
}

export default function StatusDot({ connected, tooltip, onClick, label }: StatusDotProps) {
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag
      className="status-dot-wrap"
      onClick={onClick}
      aria-label={label}
      style={onClick ? { background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' } : undefined}
    >
      <span className={`status-dot ${connected ? 'connected' : 'disconnected'}`} />
      <span className="status-tip" role="tooltip">{tooltip}</span>
    </Tag>
  );
}
