// An x.com CONVERSATION capture must carry the replies, not just the focused
// tweet — and must carry exactly the replies, not the page's other articles.
//
// The DOM shape asserted here was measured on the live new-shape x.com with
// tests/e2e/tools/x-thread-probe.spec.ts (2026-09-16): the focused tweet and
// every reply are sibling <article>s inside ONE shared <ul>, one <li> each,
// with no data-testid hooks at all, and the focused tweet's own <li> held a
// SECOND, nested article — its quoted tweet. The three tests below pin the
// three rules that follow from that: replies are collected, a quoted tweet is
// not mistaken for a reply, and an article outside the container (the sidebar's
// "Relevant people" card) is ignored.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { captureContext, __setTestHostOverride } from '@/content/capture';

const FOCUSED_URL = 'https://x.com/author/status/1000';

function resetDocument(url: string): void {
  document.open();
  document.write('<!doctype html><html><head><title>Author on X: "Focused"</title></head><body></body></html>');
  document.close();
  const u = new URL(url);
  Object.defineProperty(window, 'location', {
    value: {
      href: u.href, origin: u.origin, protocol: u.protocol, host: u.host,
      hostname: u.hostname, port: u.port, pathname: u.pathname,
      search: u.search, hash: u.hash, toString() { return u.href; },
    },
    writable: true, configurable: true,
  });
}

/** One tweet article, in the new (testid-less) shape the probe measured. */
function article(handle: string, name: string, text: string, statusId: string): string {
  return `
    <article class="flex flex-col gap-1">
      <a href="/${handle}"><span>${name}</span></a>
      <a href="/${handle}">@${handle}</a>
      <div dir="auto">${text}</div>
      <a href="/${handle}/status/${statusId}">Jul 8</a>
    </article>`;
}

/**
 * The conversation container: a <ul> of <li> cells. The focused cell nests a
 * SECOND article (the quoted tweet) exactly as the live page does, so the
 * "outermost article per cell" rule is actually exercised.
 */
function buildConversation(opts: { quoted?: boolean; sidebarArticle?: boolean } = {}): void {
  // A real quoted tweet is a [role="link"] card nesting its own <article>.
  // Both parts matter: the role is what extractTweet detects as a quote, and
  // the nested article is what would be mis-read as a reply without the
  // "outermost article per cell" rule.
  const focusedInner = opts.quoted
    ? `<div role="link">
         <article class="flex flex-col gap-1">
           <a href="/quoted"><span>Quoted Person</span></a>
           <a href="/quoted">@quoted</a>
           <div dir="auto">The quoted older post.</div>
           <a href="/quoted/status/55">Jan 1</a>
         </article>
       </div>`
    : '';
  document.body.innerHTML = `
    <div id="react-root">
      <ul>
        <li>
          <div>
            <article class="flex flex-col gap-1">
              <a href="/author"><span>Author</span></a>
              <a href="/author">@author</a>
              <div dir="auto">The focused tweet everyone is replying to.</div>
              <a href="/author/status/1000">4:57 PM · May 14, 2026</a>
              ${focusedInner}
            </article>
          </div>
        </li>
        <li><div>${article('replierone', 'Replier One', 'First reply, disagreeing politely.', '1001')}</div></li>
        <li><div>${article('repliertwo', 'Replier Two', 'Second reply, adding a source.', '1002')}</div></li>
      </ul>
      ${opts.sidebarArticle ? `
      <aside>
        <article class="flex flex-col gap-1">
          <a href="/somebody"><span>Relevant Person</span></a>
          <div dir="auto">A sidebar profile card, not a reply.</div>
        </article>
      </aside>` : ''}
    </div>`;
}

describe('x.com conversation capture', () => {
  beforeEach(() => {
    resetDocument(FOCUSED_URL);
    __setTestHostOverride('x.com');
  });
  afterEach(() => {
    __setTestHostOverride(null);
  });

  it('captures the replies below the focused tweet', async () => {
    buildConversation();
    const cap = await captureContext('article');
    const html = cap.bodyHtml ?? '';

    // The focused tweet still leads.
    expect(html).toContain('The focused tweet everyone is replying to.');
    expect(html).toContain('tweet-thread');

    // Both replies are present, each as its own card.
    expect(html).toContain('First reply, disagreeing politely.');
    expect(html).toContain('Second reply, adding a source.');
    expect((html.match(/class="tweet-reply"/g) ?? []).length).toBe(2);

    // And they are attributed to their own authors, not the focused tweet's.
    expect(html).toContain('@replierone');
    expect(html).toContain('@repliertwo');

    // The cast body carries the conversation too.
    expect(cap.bodyText ?? '').toContain('First reply, disagreeing politely.');
    expect(cap.bodyText ?? '').toContain('Replies (2)');
  });

  it('does not mistake the focused tweet\'s QUOTED tweet for a reply', async () => {
    buildConversation({ quoted: true });
    const cap = await captureContext('article');
    const html = cap.bodyHtml ?? '';

    // The quote is captured, but as part of the focused card — still 2 replies.
    expect(html).toContain('The quoted older post.');
    expect((html.match(/class="tweet-reply"/g) ?? []).length).toBe(2);
  });

  it('ignores an article outside the conversation container', async () => {
    buildConversation({ sidebarArticle: true });
    const cap = await captureContext('article');
    const html = cap.bodyHtml ?? '';

    expect(html).not.toContain('A sidebar profile card, not a reply.');
    expect((html.match(/class="tweet-reply"/g) ?? []).length).toBe(2);
  });

  it('leaves a single-tweet page as one card with no thread wrapper', async () => {
    document.body.innerHTML = `<div id="react-root"><ul><li><div>
      <article class="flex flex-col gap-1">
        <a href="/author"><span>Author</span></a>
        <a href="/author">@author</a>
        <div dir="auto">A lone tweet with no replies loaded.</div>
        <a href="/author/status/1000">4:57 PM · May 14, 2026</a>
      </article>
    </div></li></ul></div>`;
    const cap = await captureContext('article');
    const html = cap.bodyHtml ?? '';

    expect(html).toContain('A lone tweet with no replies loaded.');
    expect(html).not.toContain('tweet-thread');
    expect(html).not.toContain('tweet-reply');
  });
});
