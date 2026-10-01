// Guards tagSlashdot and tagXenForo against their saved snapshots. Both are
// pure-selector taggers (no layout), so unlike most taggers they run in full
// under jsdom and their structure can be asserted here.
//
// Slashdot: the comment thread sits OUTSIDE the story's <article>, so Tier 1
// captured the story alone. XenForo (XDA Forums): the author column flattened
// into a stack of one-word lines, and XDA labels its stats with icons only, so
// they read as bare numbers ("Jul 5, 2017 21 1").
import { describe, it, expect } from 'vitest';
import { captureContext } from '@/content/capture';
import { htmlToMarkdown } from '@/content/html-to-markdown';
import { loadFixture } from '../helpers/loadFixture';

// Each fixture is captured once and shared by its describe block (a capture of
// these snapshots takes ~15s under jsdom).
const once = <T>(fn: () => Promise<T>) => { let p: Promise<T> | undefined; return () => (p ??= fn()); };
const capture = async (fixture: string, url: string) => {
  loadFixture(fixture, url);
  const cap = await captureContext('article', { smartArticleDetection: false, stripInlineStyles: false });
  const html = cap.bodyHtml ?? '';
  const body = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html').body;
  return { html, body, text: (body.textContent ?? '').replace(/\s+/g, ' ') };
};
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('tagSlashdot (slashdot-story fixture)', () => {
  const load = once(() => capture('slashdot-story.html',
    'https://hardware.slashdot.org/story/26/07/29/0441240/trump-administration-bans-new-chinese-humanoid-robots'));

  it('captures the story AND its comment thread, one flat row per comment', async () => {
    const { body, text: all } = await load();
    expect(all).toContain('The FCC has added the items to its Covered List');
    // Story + 2 top-level comments; 13 replies. The fixture's two unloaded
    // below-threshold placeholders produce no row.
    expect(body.querySelectorAll('.dx-post')).toHaveLength(3);
    expect(body.querySelectorAll('.dx-reply')).toHaveLength(13);
    expect(body.querySelector('li .dx-reply, .dx-reply li.comment'), 'thread is flattened').toBeNull();
    for (const r of Array.from(body.querySelectorAll('.dx-reply'))) {
      expect(r.getAttribute('style') ?? '', 'replies indent by depth').toMatch(/margin-left:\s*\d+px/);
    }
  });

  it('rebuilds each comment header as "name · score · date"', async () => {
    const { body, text: all } = await load();
    const first = body.querySelectorAll('.dx-post')[1];
    expect(text(first.querySelector('h4'))).toBe('Enron Husk desperate to stop the stock freefall');
    const parts = Array.from(first.querySelector('.dx-byline')!.children).map(text);
    expect(parts).toEqual(['T34L', 'Score:5, Funny', 'Wednesday July 29, 2026 @01:51AM']);
    // A poster who shows their email gets "<addr> on <date>"; only the date stays.
    const alain = Array.from(body.querySelectorAll('.dx-byline')).find(b => /Alain Williams/.test(text(b)))!;
    expect(Array.from(alain.children).map(text))
      .toEqual(['Alain Williams', 'Score:5, Insightful', 'Wednesday July 29, 2026 @03:12AM']);
    // The uid, the "(#cid)" permalink, and "Re:" echo subjects are chrome.
    expect(all).not.toContain('10503334');
    expect(all).not.toMatch(/#6626\d{4}/);
    expect(Array.from(body.querySelectorAll('h4')).some(h => /^Re:/.test(text(h)))).toBe(false);
  });

  it('marks truncated comments and turns reply quotes into blockquotes', async () => {
    const { body } = await load();
    const more = Array.from(body.querySelectorAll('a')).filter(a => text(a) === 'Read the rest of this comment');
    expect(more).toHaveLength(2);
    expect(more[0].getAttribute('href')).toMatch(/comments\.pl\?.*cid=\d+/);
    expect(body.querySelectorAll('.dx-reply blockquote').length).toBeGreaterThanOrEqual(2);
  });

  it('drops the page chrome between the story and the thread', async () => {
    const { text: all } = await load();
    for (const chrome of ['binspam', 'Forgot your password', 'Compare the top business software',
      'This discussion has been archived', 'Load All Comments', 'Related Links', '184744938 story']) {
      expect(all, chrome).not.toContain(chrome);
    }
  });
});

describe('tagXenForo (xenforo-thread fixture)', () => {
  const load = once(() => capture('xenforo-thread.html',
    'https://xdaforums.com/t/app-root-gunyah-droidvm-windows-on-arm-ubuntu-vm-on-android-with-native-virtualization.4794047/'));

  it('captures every post in the thread', async () => {
    const { body } = await load();
    expect(body.querySelectorAll('.dx-post')).toHaveLength(7);
  });

  it('rebuilds the author column with labelled stats', async () => {
    const { body } = await load();
    const [first, , third] = Array.from(body.querySelectorAll('.dx-post'));
    const rows = Array.from(first.querySelector('.dx-byline > div')!.children);
    expect(text(rows[0].querySelector('strong'))).toBe('hujk');
    expect(rows.map(text)).toEqual(['hujkNew member', 'Joined Jun 25, 2026 · Messages 3 · Reaction score 7']);
    // A real avatar is kept as a round pin; a letter avatar has no image to keep.
    expect(third.querySelector('.dx-byline > img.dx-avatar')).not.toBeNull();
    expect(first.querySelector('img.dx-avatar')).toBeNull();
  });

  it('keeps the date, thread meta and reactions, and drops the chrome', async () => {
    const { text: all } = await load();
    expect(all).toContain('Thread starter hujk');
    expect(all).toContain('Tags gfxstream, virtio-gpu, virtualization on android');
    expect(all).toContain('Reactions: pierro78, tik6111, rio9777 and 2 others');
    for (const chrome of ['Similar threads', 'You must log in or register to reply', 'Click to expand',
      'Click to collapse', 'Search titles only', 'Share:', '#1']) {
      expect(all, chrome).not.toContain(chrome);
    }
  });

  it('publishes a proxied image under its original URL', async () => {
    // The snapshot baked images to data: URIs, so restore the live proxy shape.
    loadFixture('xenforo-thread.html',
      'https://xdaforums.com/t/app-root-gunyah-droidvm-windows-on-arm-ubuntu-vm-on-android-with-native-virtualization.4794047/');
    const og = 'https://opengraph.githubassets.com/f7c9/Droid-VM/DroidVM';
    document.querySelector('.bbCodeBlock--unfurl img:not(.bbCodeBlockUnfurl-icon)')!
      .setAttribute('src', `/proxy.php?image=${encodeURIComponent(og)}&hash=abc`);
    const cap = await captureContext('article', { smartArticleDetection: false, stripInlineStyles: false });
    expect(cap.bodyHtml).toContain(`data-dx-src="${og}"`);
    expect(cap.bodyHtml).not.toContain('proxy.php');
  });

  it('casts each byline item as one leaf, not label · value', async () => {
    const md = htmlToMarkdown((await load()).html);
    expect(md).toContain('**hujk · New member · Joined Jun 25, 2026 · Messages 3 · Reaction score 7**');
    expect(md).toContain('**Reactions: pierro78, tik6111, rio9777 and 2 others**');
    expect(md).not.toContain('Thread starter · hujk');
  });
});
