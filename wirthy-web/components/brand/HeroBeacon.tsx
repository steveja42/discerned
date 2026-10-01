// Full-panel hero illustration used on the About page: the beacon-on-cliff mark,
// animated to read as actively transmitting — dashed rays travel outward along their
// length (.hero-beacon-ray, see app/globals.css) and the lamp halo breathes
// (.hero-beacon-lamp). Geometry and animation timing are as designed in Claude Design;
// port verbatim, don't restyle.

export default function HeroBeacon() {
  const ink = '#1d4ed8';

  return (
    <svg
      viewBox="0 0 600 600"
      preserveAspectRatio="xMidYMid slice"
      width="100%"
      height="100%"
      role="img"
      aria-label="Beacon on a cliff transmitting a signal"
      style={{ display: 'block' }}
    >
      <g color={ink}>
        <g fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" opacity="0.7">
          <line className="hero-beacon-ray" x1="300" y1="180" x2="300" y2="24" />
          <line className="hero-beacon-ray" x1="256" y1="206" x2="146" y2="96" />
          <line className="hero-beacon-ray" x1="344" y1="206" x2="454" y2="96" />
          <line className="hero-beacon-ray" x1="230" y1="250" x2="74" y2="250" />
          <line className="hero-beacon-ray" x1="370" y1="250" x2="526" y2="250" />
          <line className="hero-beacon-ray" x1="256" y1="294" x2="170" y2="380" />
          <line className="hero-beacon-ray" x1="344" y1="294" x2="430" y2="380" />
        </g>
        <g stroke="currentColor" strokeWidth="6" strokeLinecap="round" opacity="0.55">
          <line x1="300" y1="176" x2="300" y2="130" />
          <line x1="248" y1="192" x2="212" y2="156" />
          <line x1="352" y1="192" x2="388" y2="156" />
          <line x1="222" y1="232" x2="174" y2="222" />
          <line x1="378" y1="232" x2="426" y2="222" />
        </g>
        <circle className="hero-beacon-lamp" cx="300" cy="250" r="54" fill="currentColor" opacity="0.16" />
        <path d="M295 168 L305 168 L300 132 Z" fill="currentColor" />
        <circle cx="300" cy="250" r="24" fill="currentColor" />
        <rect x="272" y="278" width="56" height="22" rx="4" fill="currentColor" />
        <path
          d="M282 302 L318 302 L344 520 L256 520 Z"
          fill="none" stroke="currentColor" strokeWidth="12" strokeLinejoin="round"
        />
        <g stroke="currentColor" strokeWidth="8" opacity="0.62" strokeLinecap="round">
          <line x1="286" y1="356" x2="314" y2="356" />
          <line x1="292" y1="410" x2="308" y2="410" />
          <line x1="296" y1="464" x2="304" y2="464" />
        </g>
        <g stroke="currentColor" strokeWidth="6" opacity="0.34" strokeLinecap="round">
          <line x1="284" y1="330" x2="316" y2="384" />
          <line x1="316" y1="330" x2="284" y2="384" />
          <line x1="290" y1="384" x2="310" y2="438" />
          <line x1="310" y1="384" x2="290" y2="438" />
          <line x1="294" y1="438" x2="306" y2="492" />
          <line x1="306" y1="438" x2="294" y2="492" />
        </g>
        <g transform="translate(60 130) scale(15)">
          <path d="M 5.5 26 L 26.5 26 L 26.5 29.2 L 20 31.2 L 11 30.3 L 5.5 28.6 Z" fill="currentColor" />
        </g>
      </g>
    </svg>
  );
}
