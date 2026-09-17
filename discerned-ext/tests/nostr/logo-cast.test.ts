// Guards the CAST half of the square-logo policy (remediation plan 5c).
//
// Refusing to promote a logo into the clip body was not enough: pickImageUrl
// falls through `thumbnailUrl` → `thumbnail` → `imageUrls`, and an UNGRANTED
// capture stores a plain http URL in `thumbnail` (the optional <all_urls> grant
// is what would make it a data: URI, which pickImageUrl already skips). So the
// logo still heroed the published kind-30023 — measured on tildes, gitlab-repo,
// postgresql-docs and signalvnoise, whose casts were byte-identical after the
// clip was fixed.
//
// Skipping the FIELD is wrong: an article can carry its only hero URL in
// `thumbnail` (tests/fixtures/clips/article.json), and doing so silently dropped
// real heroes from casts. `thumbnailIsLogo` is what separates the two.
import { describe, it, expect } from 'vitest';
import { createLongFormEvent } from '@/shared/nostr/events';
import type { Capture, Evaluation } from '@/shared/types';

const base = {
  id: 'x', url: 'https://tildes.net/~enviro/1abc', title: 'A post',
  timestamp: 1_760_000_000_000, format: 'article',
  bodyHtml: '<p>body</p>', bodyText: 'body',
  thumbnail: 'https://tildes.net/images/tildes-logo-144x144.png',
  thumbnailUrl: null,
} as unknown as Capture;
const ev = { signal: null, qualifiers: [], category: 'Other' } as unknown as Evaluation;
const imageTag = (e: { tags: string[][] }) => e.tags.find(t => t[0] === 'image')?.[1];

describe('logo thumbnails and the cast image tag', () => {
  it('omits the image tag when the thumbnail is a flagged logo', () => {
    const e = createLongFormEvent({ ...base, thumbnailIsLogo: true }, ev, 'body');
    expect(imageTag(e)).toBeUndefined();
  });
  it('still casts the thumbnail when it is NOT flagged', () => {
    const e = createLongFormEvent(base, ev, 'body');
    expect(imageTag(e)).toBe('https://tildes.net/images/tildes-logo-144x144.png');
  });
});
