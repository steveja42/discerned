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

// Active relay set. When NEXT_PUBLIC_LOCAL_RELAY is set (dev/test via .env.local)
// it REPLACES the public relays so the feed reads only local test casts; unset
// in production → real wss:// relays. Mirrors ACTIVE_RELAYS in the extension's
// shared/types.ts, but resolved via env var (Next idiom) rather than a build flag.
const LOCAL_RELAY = process.env.NEXT_PUBLIC_LOCAL_RELAY;
export const ACTIVE_RELAYS: readonly string[] = LOCAL_RELAY
  ? [LOCAL_RELAY]
  : DEFAULT_RELAYS;
