'use client';

import { useId } from 'react';
import { INTEREST_LEVELS, ETHICS_LEVELS } from '@/lib/constants';

const INTEREST_NEUTRAL = 1;
const ETHICS_NEUTRAL = 2;

type Kind = 'interest' | 'ethics';

interface Palette {
  base: string;
  soft: string;
  t: number;
  dir: -1 | 0 | 1;
}

function wedgePalette(kind: Kind, idx: number, neutralIdx: number, max: number): Palette {
  if (idx === neutralIdx) {
    return { base: 'var(--neutral-faded)', soft: 'var(--neutral-faded)', t: 0, dir: 0 };
  }
  if (idx < neutralIdx) {
    const t = (neutralIdx - idx) / neutralIdx;
    return {
      base: `oklch(${0.62 - t * 0.10} ${0.10 + t * 0.13} 28)`,
      soft: `oklch(${0.85 - t * 0.05} ${0.05 + t * 0.05} 32)`,
      t, dir: -1,
    };
  }
  const t = (idx - neutralIdx) / (max - neutralIdx);
  const hue = kind === 'interest' ? 250 : 145;
  return {
    base: `oklch(${0.60 - t * 0.06} ${0.08 + t * 0.13} ${hue})`,
    soft: `oklch(${0.86 - t * 0.04} ${0.04 + t * 0.06} ${hue})`,
    t, dir: 1,
  };
}

interface WedgeProps {
  kind: Kind;
  label: string;
}

export default function Wedge({ kind, label }: WedgeProps) {
  const uid = useId();
  const levels  = kind === 'interest' ? INTEREST_LEVELS : ETHICS_LEVELS;
  const neutral = kind === 'interest' ? INTEREST_NEUTRAL : ETHICS_NEUTRAL;
  const max     = levels.length - 1;
  const idx     = (levels as readonly string[]).indexOf(label);
  const palette = wedgePalette(kind, idx, neutral, max);
  const { dir }  = palette;
  const dist    = Math.abs(idx - neutral);
  const span    = dir < 0 ? neutral : max - neutral;

  const W = 88, H = 18;
  const cx = W / 2;

  if (dir === 0) {
    return (
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-label={`${kind}: Neutral`} role="img">
        <circle cx={cx} cy={H / 2} r="3"   fill="var(--neutral-faded)" />
        <circle cx={cx} cy={H / 2} r="5.5" fill="none" stroke="var(--neutral-faded)" strokeWidth="0.8" />
      </svg>
    );
  }

  const len    = (dist / span) * 38;
  const tipX   = cx + dir * len;
  const gradId = `wedge-grad-${uid}`;

  const points = dir > 0
    ? `${cx},${H/2 - 1.5} ${cx},${H/2 + 1.5} ${tipX - 0.5},${H/2 + 6} ${tipX + 1},${H/2} ${tipX - 0.5},${H/2 - 6}`
    : `${cx},${H/2 - 1.5} ${cx},${H/2 + 1.5} ${tipX + 0.5},${H/2 + 6} ${tipX - 1},${H/2} ${tipX + 0.5},${H/2 - 6}`;

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-label={`${kind}: ${label}`} role="img">
      <defs>
        <linearGradient id={gradId}
                        x1={dir > 0 ? '0%' : '100%'} y1="0%"
                        x2={dir > 0 ? '100%' : '0%'} y2="0%">
          <stop offset="0%"   stopColor={palette.soft} stopOpacity="0.6" />
          <stop offset="100%" stopColor={palette.base} />
        </linearGradient>
      </defs>
      <circle cx={cx} cy={H / 2} r="2.4" fill="var(--ink-3)" />
      <polygon points={points} fill={`url(#${gradId})`} />
      {Array.from({ length: dist }, (_, i) => {
        const xc = cx + dir * ((i + 0.5) * (len / dist));
        return (
          <line key={i}
                x1={xc} y1={H/2 - 3.5}
                x2={xc} y2={H/2 + 3.5}
                stroke="var(--paper)" strokeOpacity="0.55" strokeWidth="0.7" />
        );
      })}
    </svg>
  );
}
