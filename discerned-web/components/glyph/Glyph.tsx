// Dispatcher component that renders one of three axis visualisation styles.
// 'bars' is the default compact row view; 'radial' uses SVG arcs; 'letter' uses mono pills.
// The variant is set at the feed level and passed down through ClipRow.

import GlyphBars from './GlyphBars';
import GlyphRadial from './GlyphRadial';
import GlyphLetter from './GlyphLetter';

export type GlyphVariant = 'bars' | 'radial' | 'letter';

interface GlyphProps {
  interest: string;
  ethics: string;
  category: string;
  signal?: string;
  qualifiers?: string[];
  variant?: GlyphVariant;
}

export default function Glyph({ interest, ethics, category, signal, qualifiers, variant = 'bars' }: GlyphProps) {
  if (variant === 'radial') return <GlyphRadial interest={interest} ethics={ethics} category={category} signal={signal} qualifiers={qualifiers} />;
  if (variant === 'letter') return <GlyphLetter interest={interest} ethics={ethics} category={category} signal={signal} qualifiers={qualifiers} />;
  return <GlyphBars interest={interest} ethics={ethics} category={category} signal={signal} qualifiers={qualifiers} />;
}
