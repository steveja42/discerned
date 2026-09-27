// Guards two defects measured on ESPN's free-agency tracker (2026-09-26,
// tools/espn-probe.spec.ts):
//  1. The page's FIRST <article> is an empty ad slot (`article.ad-300`). Tier 1
//     took it, failed the length gate and skipped the whole `article` selector,
//     so the layout finder captured #global-viewport — NFL scores strip and all.
//  2. The tracker itself is a cross-origin Arena live-blog <iframe> wrapped in an
//     <aside>; its harvested body must replace the iframe AND survive the
//     landmark stripper, which drops every <aside>.

import { describe, it, expect } from 'vitest';
import { captureContext, substituteContentFrames } from '@/content/capture';

const STORY = 'NFL free agency began with the legal negotiation window on March 9, while March 11 marked the start of the new league year. '.repeat(3);
const SCORES = Array.from({ length: 30 }, (_, i) => `<div class="cscore">ATL ${i} GB ${i + 1} Sun 10:00 AM PT FOX</div>`).join('');

describe('ESPN live-blog article', () => {
  it('an empty ad-slot <article> does not shadow the real story', async () => {
    document.body.innerHTML = `<div id="global-viewport">
      <div class="scoreboard-content">${SCORES}</div>
      <article class="ad-300"></article>
      <article class="article"><h1>2026 NFL free agency tracker</h1>
        <div class="article-body"><p>${STORY}</p><p>${STORY}</p></div></article>
    </div>`;
    const cap = await captureContext('article', { smartArticleDetection: false, stripInlineStyles: false });
    expect(cap.bodyHtml ?? '').toContain('legal negotiation window');
    expect(cap.bodyHtml ?? '').not.toContain('ATL 0 GB 1');
  });

  it('replaces a harvested content iframe and unwraps its <aside>', () => {
    const root = document.createElement('div');
    root.innerHTML = `<p>${STORY}</p><aside class="module-iframe-wrapper">
      <iframe src="https://go.arena.im/embed?event=X"></iframe><script>var x=1;</script></aside>`;
    const frameHtml = '<div class="live-message--container"><h2>Chiefs sign Kenneth Walker III</h2>'
      + '<blockquote class="twitter-tweet"><a href="https://x.com/a/status/123">t</a></blockquote></div>';
    substituteContentFrames(root, new Map([['https://go.arena.im/embed?event=X', frameHtml]]));
    expect(root.querySelector('iframe')).toBeNull();
    expect(root.querySelector('aside')).toBeNull();
    expect(root.textContent).toContain('Chiefs sign Kenneth Walker III');
    expect(root.querySelector('blockquote.twitter-tweet')).not.toBeNull();
  });

  it('links an unreadable content iframe (no all-sites grant) instead of dropping it', () => {
    const root = document.createElement('div');
    root.innerHTML = '<aside><iframe src="https://go.arena.im/embed?event=X"></iframe></aside>';
    substituteContentFrames(root, new Map([['https://go.arena.im/embed?event=X', '']]));
    const a = root.querySelector('a');
    expect(root.querySelector('iframe')).toBeNull();
    expect(root.querySelector('aside'), 'the landmark stripper would drop the link').toBeNull();
    expect(a?.getAttribute('href')).toBe('https://go.arena.im/embed?event=X');
    expect(a?.textContent).toContain('go.arena.im');
  });

  it('leaves an iframe with no harvested body alone', () => {
    const root = document.createElement('div');
    root.innerHTML = '<aside><iframe src="https://example.com/widget"></iframe></aside>';
    substituteContentFrames(root, new Map([['https://other.example/', '<p>x</p>']]));
    expect(root.querySelector('aside iframe')).not.toBeNull();
  });
});
