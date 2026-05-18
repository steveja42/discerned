function belowNeutralColor(rank: number, neutralRank: number): string {
  const t = neutralRank > 1 ? rank / (neutralRank - 1) : 0;
  const L = 0.50 + t * 0.08;
  const C = 0.18 - t * 0.04;
  const H = 25 + t * 20;
  return `oklch(${L.toFixed(3)} ${C.toFixed(3)} ${H.toFixed(1)})`;
}

// Interest above neutral: cornflower blue → deep indigo
// Interesting: oklch(0.68 0.14 230) — medium blue
// Insightful:  oklch(0.54 0.22 245) — strong blue
// Wise:        oklch(0.38 0.28 260) — deep indigo
export function interestColor(rank: number, neutralRank: number, maxRank: number): string {
  if (rank === neutralRank) return 'oklch(0.80 0.03 250 / 0.42)';
  if (rank < neutralRank) return belowNeutralColor(rank, neutralRank);
  const t = (rank - neutralRank) / (maxRank - neutralRank);
  const L = 0.68 - t * 0.30;
  const C = 0.14 + t * 0.14;
  const H = 230 + t * 30;
  return `oklch(${L.toFixed(3)} ${C.toFixed(3)} ${H.toFixed(1)})`;
}

// Ethics above neutral: sage green → deep forest green
// Honest:    oklch(0.65 0.14 148) — clear mid-green
// Exemplary: oklch(0.42 0.22 158) — deep rich green
export function ethicsColor(rank: number, neutralRank: number, maxRank: number): string {
  if (rank === neutralRank) return 'oklch(0.80 0.03 150 / 0.42)';
  if (rank < neutralRank) return belowNeutralColor(rank, neutralRank);
  const t = (rank - neutralRank) / (maxRank - neutralRank);
  const L = 0.65 - t * 0.23;
  const C = 0.14 + t * 0.08;
  const H = 148 + t * 10;
  return `oklch(${L.toFixed(3)} ${C.toFixed(3)} ${H.toFixed(1)})`;
}
