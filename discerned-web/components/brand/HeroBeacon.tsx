// Full-width 800×400 hero illustration used on the About page.
// Includes radial sky gradient, scattered noise marks, fanned ray polygons, and the beacon tower.
// Colours are hardcoded to the Editorial palette — do not replace with a raster image.

export default function HeroBeacon() {
  const bg1 = '#f6f1e8';
  const bg2 = '#efe4cc';
  const ray = '#3B82F6';
  const tower = '#1a1714';
  const glow = '#60A5FA';

  return (
    <svg
      viewBox="0 0 800 400"
      preserveAspectRatio="xMidYMid slice"
      width="100%"
      height="100%"
      style={{ display: 'block' }}
    >
      <defs>
        <radialGradient id="hb-sky" cx="50%" cy="80%" r="80%">
          <stop offset="0%" stopColor={bg2} />
          <stop offset="100%" stopColor={bg1} />
        </radialGradient>
        <radialGradient id="hb-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={glow} stopOpacity="0.6" />
          <stop offset="100%" stopColor={glow} stopOpacity="0" />
        </radialGradient>
        <linearGradient id="hb-ray" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={ray} stopOpacity="0.55" />
          <stop offset="100%" stopColor={ray} stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="800" height="400" fill="url(#hb-sky)" />
      <g opacity="0.32" stroke={tower} strokeWidth="0.6">
        {Array.from({ length: 80 }).map((_, i) => {
          const x = (i * 137) % 800;
          const y = 60 + ((i * 211) % 280);
          const len = 3 + ((i * 7) % 10);
          const ang = (i * 41) % 180;
          return (
            <line
              key={i}
              x1={x} y1={y}
              x2={x + Math.cos(ang) * len}
              y2={y + Math.sin(ang) * len}
            />
          );
        })}
      </g>
      <circle cx="400" cy="130" r="200" fill="url(#hb-glow)" />
      <g opacity="0.85">
        {([-60, -42, -24, -8, 8, 24, 42, 60] as number[]).map((a, i) => {
          const rad = (a - 90) * Math.PI / 180;
          const x = 400 + Math.cos(rad) * 600;
          const y = 130 + Math.sin(rad) * 600;
          return (
            <polygon
              key={i}
              points={`400,130 ${x - Math.sin(rad) * 14},${y + Math.cos(rad) * 14} ${x + Math.sin(rad) * 14},${y - Math.cos(rad) * 14}`}
              fill="url(#hb-ray)"
            />
          );
        })}
      </g>
      <g fill={tower}>
        <path d="M 340 380 L 460 380 L 450 360 L 350 360 Z" />
        <path d="M 358 360 L 392 145 L 408 145 L 442 360 L 432 360 L 402 165 L 398 165 L 368 360 Z" />
        {([200, 240, 280, 320] as number[]).map((y) => {
          const k = (360 - y) / 215;
          const x1 = 400 - 50 * k * 0.5 - 8;
          const x2 = 400 + 50 * k * 0.5 + 8;
          return (
            <path key={y} d={`M ${x1} ${y} L ${x2} ${y + 6} L ${x2} ${y + 8} L ${x1} ${y + 2} Z`} />
          );
        })}
        <rect x="384" y="125" width="32" height="22" rx="2" />
        <rect x="386" y="118" width="28" height="8" rx="1" />
        <circle cx="400" cy="115" r="6" />
        <path d="M 398 80 L 402 80 L 400 60 Z" />
      </g>
      <circle cx="400" cy="115" r="5" fill={glow} />
      <circle cx="400" cy="115" r="2.5" fill="#fff" opacity="0.9" />
      <line x1="0" y1="380" x2="800" y2="380" stroke={tower} opacity="0.18" strokeWidth="0.5" />
    </svg>
  );
}
