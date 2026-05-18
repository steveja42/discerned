import { CATEGORIES, interestRank, ethicsRank } from '@/lib/constants';
import Wedge from './Wedge';

interface GlyphBarsProps {
  interest: string;
  ethics: string;
  category: string;
}

export default function GlyphBars({ interest, ethics, category }: GlyphBarsProps) {
  const cat = CATEGORIES[category] ?? { label: category, hue: 60 };
  const iRank = interestRank(interest);
  const eRank = ethicsRank(ethics);
  const iNeutral = iRank === 1;
  const eNeutral = eRank === 2;
  return (
    <div className="glyph">
      <div className="cat-tag">
        <span className="swatch" style={{ background: `oklch(0.50 0.08 ${cat.hue})` }} />
        {cat.label}
      </div>
      {!iNeutral && (
        <div className="glyph-row" title={`Interest: ${interest}`}>
          <span className="axis-key">I</span>
          <Wedge kind="interest" label={interest} />
          <span className="dim-label">{interest}</span>
        </div>
      )}
      {!eNeutral && (
        <div className="glyph-row" title={`Ethics: ${ethics}`}>
          <span className="axis-key">E</span>
          <Wedge kind="ethics" label={ethics} />
          <span className="dim-label">{ethics}</span>
        </div>
      )}
    </div>
  );
}
