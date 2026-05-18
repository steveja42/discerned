// Component test for the ClipRow renderer. Confirms that all the fields
// extension users expect to see actually surface in the DOM, regardless of
// which ClipFormat the clip carries.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ClipRow from '@/components/feed/ClipRow';
import type { ClipData } from '@/lib/types';

function makeClip(over: Partial<ClipData['capture']> = {}, evalOver: Partial<ClipData['evaluation']> = {}): ClipData {
  return {
    capture: {
      id: 'test-clip-1',
      format: 'article',
      url: 'https://example.com/articles/cool-thing',
      title: 'A Cool Thing Happened',
      timestamp: 1_740_000_000_000,
      bodyText: 'This is the body text of the cool thing that happened.',
      ...over,
    },
    evaluation: { interest: 'Insightful', ethics: 'Honest', category: 'Science', ...evalOver },
    encrypted: '',
  };
}

describe('<ClipRow />', () => {
  it('renders title, domain, excerpt and date', () => {
    const onClick = vi.fn();
    render(<ClipRow clip={makeClip()} selected={false} onClick={onClick} />);

    expect(screen.getByText('A Cool Thing Happened')).toBeInTheDocument();
    expect(screen.getByText('example.com')).toBeInTheDocument();
    expect(screen.getByText(/This is the body text/)).toBeInTheDocument();
  });

  it('strips HTML when rendering a selection excerpt', () => {
    const clip = makeClip({
      format: 'selection',
      bodyText: undefined,
      selectionText: '<p>Plain <strong>truth</strong> beats fancy lies.</p>',
    });
    render(<ClipRow clip={clip} selected={false} onClick={vi.fn()} />);
    expect(screen.getByText('Plain truth beats fancy lies.')).toBeInTheDocument();
  });

  it('shows the user note when present', () => {
    const clip = makeClip({ note: 'Worth coming back to — argues against the Slovic findings.' });
    render(<ClipRow clip={clip} selected={false} onClick={vi.fn()} />);
    expect(screen.getByText(/Worth coming back to/)).toBeInTheDocument();
  });

  it('invokes onClick when the article body is clicked', () => {
    const onClick = vi.fn();
    render(<ClipRow clip={makeClip()} selected={false} onClick={onClick} />);
    fireEvent.click(screen.getByText('A Cool Thing Happened'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('reflects selected/checked state on the article element', () => {
    const { container } = render(
      <ClipRow clip={makeClip()} selected={true} isSelectMode={true} isSelected={true} onClick={vi.fn()} />,
    );
    const article = container.querySelector('article.clip');
    expect(article?.className).toMatch(/selected/);
    expect(article?.className).toMatch(/select-mode/);
    expect(article?.className).toMatch(/checked/);
  });

  it('falls back to the raw URL string when the URL is malformed', () => {
    const clip = makeClip({ url: 'not a url' });
    render(<ClipRow clip={clip} selected={false} onClick={vi.fn()} />);
    expect(screen.getByText('not a url')).toBeInTheDocument();
  });
});
