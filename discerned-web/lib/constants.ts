// Axis vocabularies and category definitions shared across feed, glyphs, and filters.
// Hue values drive oklch() colour generation for category swatches in the UI.

export const INTEREST_LEVELS = ['Noise', 'Neutral', 'Interesting', 'Insightful', 'Wise'] as const;
export const ETHICS_LEVELS = ['Malicious', 'Misleading', 'Neutral', 'Honest', 'Exemplary'] as const;

export const CATEGORIES: Record<string, { label: string; hue: number }> = {
  General:    { label: 'General',    hue: 60 },
  Tech:       { label: 'Tech',       hue: 220 },
  Finance:    { label: 'Finance',    hue: 155 },
  Health:     { label: 'Health',     hue: 25 },
  Politics:   { label: 'Politics',   hue: 0 },
  Philosophy: { label: 'Philosophy', hue: 270 },
  Science:    { label: 'Science',    hue: 200 },
  Culture:    { label: 'Culture',    hue: 320 },
};

export const interestRank = (lvl: string): number =>
  INTEREST_LEVELS.indexOf(lvl as typeof INTEREST_LEVELS[number]);

export const ethicsRank = (lvl: string): number =>
  ETHICS_LEVELS.indexOf(lvl as typeof ETHICS_LEVELS[number]);

export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.snort.social',
] as const;
