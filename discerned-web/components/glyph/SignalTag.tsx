// Compact signal-rating pill (N filled stars) + qualifier chips, shared by all
// three Glyph variants. Renders nothing when a clip is unrated and untagged, so
// legacy interest/ethics clips are unaffected.

import { signalRank } from '@/lib/constants';

interface SignalTagProps {
  signal?: string;
  qualifiers?: string[];
}

export default function SignalTag({ signal, qualifiers }: SignalTagProps) {
  const rank = signalRank(signal);
  const quals = qualifiers ?? [];
  if (rank === 0 && quals.length === 0) return null;

  return (
    <>
      {rank > 0 && (
        <span className="signal-tag" title={`Signal: ${signal}`}>
          <span className="signal-stars" aria-hidden>
            {'★'.repeat(rank)}
            <span className="signal-stars-off">{'★'.repeat(5 - rank)}</span>
          </span>
          <span className="signal-name">{signal}</span>
        </span>
      )}
      {quals.length > 0 && (
        <span className="qual-tags">
          {quals.map((q) => (
            <span key={q} className="qual-chip">{q}</span>
          ))}
        </span>
      )}
    </>
  );
}
