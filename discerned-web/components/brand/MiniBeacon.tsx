// Hand-authored SVG of the Discerned beacon-on-cliff tower — used in the TopBar brand mark.
// Renders in currentColor so it inherits the text colour of its container.
// Do not replace with an icon library icon; this SVG is load-bearing for brand identity.
//
// viewBox is the mark's TIGHT bbox (5.8 1.95 20.4 29.05) in the beacon-on-cliff's own
// 0..32 coordinate system (beacon tower nested in translate(2.4 -0.6) scale(0.85),
// cliff base drawn directly in outer coords) — same geometry as art/icon.svg.

interface MiniBeaconProps {
  size?: number;
}

export default function MiniBeacon({ size = 26 }: MiniBeaconProps) {
  return (
    <svg
      viewBox="5.8 1.95 20.4 29.05"
      width={size}
      height={size * 29.05 / 20.4}
      style={{ display: 'block' }}
      fill="none"
    >
      <g transform="translate(2.4 -0.6) scale(0.85)">
        <g stroke="currentColor" strokeWidth="1.18" strokeLinecap="round" opacity="0.5">
          <line x1="16" y1="9" x2="16" y2="3" />
          <line x1="11.5" y1="10" x2="7.5" y2="6" />
          <line x1="20.5" y1="10" x2="24.5" y2="6" />
          <line x1="9" y1="13" x2="4" y2="12" />
          <line x1="23" y1="13" x2="28" y2="12" />
        </g>
        <circle cx="16" cy="14" r="5" fill="currentColor" opacity="0.12" />
        <path d="M 15.5 7 L 16.5 7 L 16 4 Z" fill="currentColor" />
        <circle cx="16" cy="14" r="2.4" fill="currentColor" />
        <rect x="13.2" y="15.5" width="5.6" height="2.4" rx="0.5" fill="currentColor" />
        <path
          d="M 14.2 18 L 17.8 18 L 19.4 31.3 L 12.6 31.3 Z"
          stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" fill="none"
        />
        <line x1="13.4" y1="22.5" x2="18.6" y2="22.5" stroke="currentColor" strokeWidth="1.06" opacity="0.7" />
        <line x1="13" y1="27" x2="19" y2="27" stroke="currentColor" strokeWidth="1.06" opacity="0.7" />
      </g>
      <path d="M 8 26 L 24 26 L 24 29 L 19 31 L 11 30 L 8 28.4 Z" fill="currentColor" />
    </svg>
  );
}
