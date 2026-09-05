import { describe, it, expect } from 'vitest';
import { useRef } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { useClipVideoPlayers } from '@/components/clips/ClipVideoPlayers';

/**
 * Harness mirroring DetailPanel: the clip body is injected as raw HTML, so the
 * poster cards live outside React's tree and only a delegated listener can
 * reach them. `ready` models the body arriving ASYNCHRONOUSLY — the real panel
 * fetches it from the extension after first paint.
 */
function Harness({ html, ready = true }: { html: string; ready?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useClipVideoPlayers(ref, [ready]);
  return ready
    ? <div ref={ref} data-testid="body" className="clip-body" dangerouslySetInnerHTML={{ __html: html }} />
    : <div data-testid="body" className="clip-body" />;
}

const ytCard = (href: string) =>
  `<figure><a class="tweet-video" href="${href}" target="_blank" rel="noopener noreferrer">` +
  `<img class="tweet-video-poster" src="https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" alt="Video thumbnail">` +
  `<div class="tweet-video-play">▶</div></a></figure>`;

describe('useClipVideoPlayers', () => {
  it('swaps a YouTube poster card for an inline nocookie player', () => {
    render(<Harness html={ytCard('https://www.youtube.com/watch?v=dQw4w9WgXcQ')} />);
    const card = document.querySelector('a.tweet-video')!;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    card.dispatchEvent(ev);

    expect(ev.defaultPrevented).toBe(true);
    const frame = document.querySelector('iframe.clip-video-frame') as HTMLIFrameElement | null;
    expect(frame).not.toBeNull();
    expect(frame!.src).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ');
    // The card is gone; a way out to the source remains.
    expect(document.querySelector('a.tweet-video')).toBeNull();
    expect(screen.getByText('Open on YouTube')).toBeTruthy();
  });

  it('swaps an Instagram reel card for the /reel/<code>/embed/ player', () => {
    render(<Harness html={ytCard('https://www.instagram.com/reel/Dc1goBzv1Rm/')} />);
    document.querySelector('a.tweet-video')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    const frame = document.querySelector('iframe.clip-video-frame') as HTMLIFrameElement | null;
    expect(frame!.src).toBe('https://www.instagram.com/reel/Dc1goBzv1Rm/embed/');
  });

  it('binds once the body arrives asynchronously', () => {
    // The regression this guards: keying the effect on the clip id alone left
    // it bound to a null ref, so a body fetched after first paint got no
    // listener and every poster opened a new tab instead of playing.
    const html = ytCard('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    const { rerender } = render(<Harness html={html} ready={false} />);
    expect(document.querySelector('a.tweet-video')).toBeNull();

    rerender(<Harness html={html} ready />);
    document.querySelector('a.tweet-video')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    expect(document.querySelector('iframe.clip-video-frame')).not.toBeNull();
  });

  it('leaves an unknown provider alone so the link opens normally', () => {
    render(<Harness html={ytCard('https://example.com/some/video')} />);
    const card = document.querySelector('a.tweet-video')!;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    card.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(document.querySelector('iframe.clip-video-frame')).toBeNull();
    expect(document.querySelector('a.tweet-video')).not.toBeNull();
  });

  it('respects modifier-clicks and middle-clicks (open in new tab)', () => {
    render(<Harness html={ytCard('https://www.youtube.com/watch?v=dQw4w9WgXcQ')} />);
    const card = document.querySelector('a.tweet-video')!;
    for (const init of [
      { button: 0, metaKey: true }, { button: 0, ctrlKey: true },
      { button: 0, shiftKey: true }, { button: 1 },
    ]) {
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true, ...init });
      card.dispatchEvent(ev);
      expect(ev.defaultPrevented, JSON.stringify(init)).toBe(false);
    }
    expect(document.querySelector('iframe.clip-video-frame')).toBeNull();
  });

  it('plays when the click lands on the poster image inside the card', () => {
    render(<Harness html={ytCard('https://www.youtube.com/watch?v=dQw4w9WgXcQ')} />);
    // Real clicks hit the <img> or the play glyph, not the <a> itself.
    document.querySelector('img.tweet-video-poster')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    expect(document.querySelector('iframe.clip-video-frame')).not.toBeNull();
  });
});
