// A cast body is markdown, and DetailPanel's markdown <a> renderer turns some
// anchors into click-to-play cards. That decision is what produced the Phase 3
// "grey pill sliced by an arrow" on 8 corpus sites: marking on the HREF alone
// made every PROSE link to YouTube/X/Vimeo a card, and .tweet-video
// (block, fit-content, overflow:hidden) plus .tweet-video-play (absolute,
// inset:0, dark panel, 44px glyph) renders a sentence fragment as a grey box
// with the arrow over its middle. A card needs a poster to lay the overlay on.

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import DetailPanel from '@/components/feed/DetailPanel';
import type { ClipData } from '@/lib/types';

function castWithMarkdown(markdown: string): ClipData {
  return {
    capture: {
      id: 'cast-1',
      format: 'article',
      url: 'https://example.com/post',
      title: 'A Cast',
      timestamp: 1_740_000_000_000,
      markdown,
    },
    evaluation: { signal: 'Worthwhile', qualifiers: [], category: 'Science' },
    encrypted: '',
  } as ClipData;
}

function renderCast(markdown: string) {
  const { container } = render(
    <DetailPanel
      clip={castWithMarkdown(markdown)}
      onDelete={vi.fn()}
      onUpdateNote={vi.fn()}
      bodies={new Map()}
      onBodyFetched={vi.fn()}
    />,
  );
  return container;
}

describe('cast markdown play cards', () => {
  it('leaves a PROSE link to an embeddable provider as an ordinary link', () => {
    const c = renderCast(
      'Its editor [sat down to talk with David Senra](https://www.youtube.com/watch?v=dQw4w9WgXcQ) about the archive.',
    );
    const a = c.querySelector('a[href*="youtube.com"]')!;
    expect(a).toBeTruthy();
    expect(a.className).not.toContain('tweet-video');
    expect(c.querySelector('.tweet-video-play')).toBeNull();
    // The whole link text must survive — the defect sliced it in two.
    expect(a.textContent).toBe('sat down to talk with David Senra');
  });

  it('still marks a POSTER link (the [![](poster)](watch) shape) as playable', () => {
    const c = renderCast(
      '[![](https://img.example.com/poster.jpg)](https://www.youtube.com/watch?v=dQw4w9WgXcQ)',
    );
    const a = c.querySelector('a[href*="youtube.com"]')!;
    expect(a).toBeTruthy();
    expect(a.className).toContain('tweet-video');
    expect(c.querySelector('.tweet-video-play')).not.toBeNull();
  });

  it('leaves a prose link to a NON-embeddable host alone', () => {
    const c = renderCast('See the [council minutes](https://example.test/minutes) in full.');
    const a = c.querySelector('a[href*="example.test"]')!;
    expect(a.className).not.toContain('tweet-video');
    expect(a.textContent).toBe('council minutes');
  });
});
