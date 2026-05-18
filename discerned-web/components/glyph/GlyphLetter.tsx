import { CATEGORIES, interestRank, ethicsRank } from '@/lib/constants';
import { interestColor, ethicsColor } from '@/lib/dimensionColor';

interface GlyphLetterProps {
  interest: string;
  ethics: string;
  category: string;
}

export default function GlyphLetter({ interest, ethics, category }: GlyphLetterProps) {
  const cat = CATEGORIES[category] ?? { label: category, hue: 60 };
  const iRank = interestRank(interest);
  const eRank = ethicsRank(ethics);
  const iNeutral = iRank === 1;
  const eNeutral = eRank === 2;
  const iShort = interest.slice(0, 4);
  const eShort = ethics.slice(0, 4);
  const iColor = interestColor(iRank, 1, 4);
  const eColor = ethicsColor(eRank, 2, 4);
  return (
    <div className="glyph" style={{ alignItems: 'flex-end', minWidth: 130 }}>
      <div className="cat-tag">
        <span className="swatch" style={{ background: `oklch(0.50 0.08 ${cat.hue})` }} />
        {cat.label}
      </div>
      {(!iNeutral || !eNeutral) && (
        <div className="letter-grade">
          {!iNeutral && (
            <div
              className="lg-axis interest"
              style={{ width: 'auto', padding: '0 8px', fontSize: 10, fontFamily: 'var(--mono)', fontStyle: 'normal', letterSpacing: '0.04em', textTransform: 'uppercase', background: iColor }}
              title={`Interest: ${interest}`}
            >
              {iShort}
            </div>
          )}
          {!eNeutral && (
            <div
              className="lg-axis ethics"
              style={{ width: 'auto', padding: '0 8px', fontSize: 10, fontFamily: 'var(--mono)', fontStyle: 'normal', letterSpacing: '0.04em', textTransform: 'uppercase', background: eColor }}
              title={`Ethics: ${ethics}`}
            >
              {eShort}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
