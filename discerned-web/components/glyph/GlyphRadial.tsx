import { CATEGORIES, interestRank, ethicsRank } from '@/lib/constants';
import { interestColor, ethicsColor } from '@/lib/dimensionColor';

interface GlyphRadialProps {
  interest: string;
  ethics: string;
  category: string;
}

export default function GlyphRadial({ interest, ethics, category }: GlyphRadialProps) {
  const cat = CATEGORIES[category] ?? { label: category, hue: 60 };
  const cx = 32, cy = 32, r = 22;
  const iRank = interestRank(interest);
  const eRank = ethicsRank(ethics);
  const iAngle = ((iRank + 1) / 5) * 360;
  const eAngle = ((eRank + 1) / 5) * 360;
  const iColor = interestColor(iRank, 1, 4);
  const eColor = ethicsColor(eRank, 2, 4);

  const arc = (radius: number, angle: number) => {
    const a = (angle - 90) * Math.PI / 180;
    const x = cx + radius * Math.cos(a);
    const y = cy + radius * Math.sin(a);
    const large = angle > 180 ? 1 : 0;
    return `M ${cx} ${cy - radius} A ${radius} ${radius} 0 ${large} 1 ${x} ${y}`;
  };

  const iNeutral = iRank === 1;
  const eNeutral = eRank === 2;

  return (
    <div className="glyph" style={{ alignItems: 'center', minWidth: 80 }}>
      <div className="cat-tag" style={{ marginBottom: 4 }}>
        <span className="swatch" style={{ background: `oklch(0.50 0.08 ${cat.hue})` }} />
        {cat.label}
      </div>
      {(!iNeutral || !eNeutral) && (
        <svg width="64" height="64" viewBox="0 0 64 64">
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--rule)" strokeWidth="1.5" />
          <circle cx={cx} cy={cy} r={r - 7} fill="none" stroke="var(--rule)" strokeWidth="1.5" />
          {!iNeutral && <path d={arc(r, iAngle)} fill="none" stroke={iColor} strokeWidth="3" strokeLinecap="round" />}
          {!eNeutral && <path d={arc(r - 7, eAngle)} fill="none" stroke={eColor} strokeWidth="3" strokeLinecap="round" />}
          <circle cx={cx} cy={cy} r="3" fill={`oklch(0.50 0.08 ${cat.hue})`} />
        </svg>
      )}
    </div>
  );
}
