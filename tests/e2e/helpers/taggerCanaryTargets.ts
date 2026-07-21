// Phase 3.1/3.2 — canary targets for each per-site tagger.
//
// One entry per tagger registered in SITE_TAGGERS (discerned-ext capture.ts).
// The canary (tagger-canary.spec.ts) visits each `url`, waits for `renderWait`
// so the SPA has painted its content, then asks the extension to run that
// tagger's selector-anchor manifest against the LIVE DOM. A dead anchor (zero
// matches) means the site redesigned out from under the tagger — the canary
// fails and NAMES the dead selector.
//
// `hostOverride` matches the tagger's SITE_TAGGERS host regex so the anchor
// check selects the right tagger even when the live hostname already matches
// (kept explicit so a target for a subdomain still resolves the right tagger).
//
// Keep this list in sync with SITE_TAGGERS. When you add a tagger there, add a
// row here and the canary covers it automatically.

export interface TaggerCanaryTarget {
  /** Tagger name — must equal the SITE_TAGGERS `name`. */
  name: string;
  /** A stable live URL that exercises the tagger's layout. */
  url: string;
  /** Host the anchor check resolves the tagger by (SITE_TAGGERS match input). */
  hostOverride: string;
  /** CSS selector to wait for before checking anchors (SPA has rendered). */
  renderWait: string;
  /** Env var overriding `url` (so a dead link can be swapped without a code edit). */
  urlEnv: string;
}

export const TAGGER_CANARY_TARGETS: TaggerCanaryTarget[] = [
  {
    name: 'primal',
    // A profile page reliably renders notes headless; a single-note nevent URL
    // sometimes stalls on relay fetch. Override with PRIMAL_URL for a specific
    // note/thread. jack's npub — stable, high-activity.
    url: 'https://primal.net/p/npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m',
    hostOverride: 'primal.net',
    renderWait: '[class*="_primaryNote_"], [class*="_noteThread_"], article',
    urlEnv: 'PRIMAL_URL',
  },
  {
    name: 'bsky',
    url: 'https://bsky.app/profile/bsky.app',
    hostOverride: 'bsky.app',
    renderWait: '[data-testid^="feedItem-by-"], [data-testid="profileHeaderDisplayName"]',
    urlEnv: 'BSKY_URL',
  },
  {
    name: 'goodreads',
    url: 'https://www.goodreads.com/book/show/2767052-the-hunger-games',
    hostOverride: 'www.goodreads.com',
    renderWait: '.BookPage, [class*="BookPageTitleSection"]',
    urlEnv: 'GOODREADS_URL',
  },
  {
    name: 'reddit',
    url: 'https://www.reddit.com/r/mildlyinfuriating/comments/1tw7cla/this_car_ive_never_seen_before_has_been_parked_in/',
    hostOverride: 'www.reddit.com',
    renderWait: 'shreddit-post',
    urlEnv: 'REDDIT_URL',
  },
  {
    name: 'youtube',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    hostOverride: 'www.youtube.com',
    renderWait: '#primary-inner, ytd-watch-flexy',
    urlEnv: 'YOUTUBE_URL',
  },
  {
    name: 'stackoverflow',
    url: 'https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array',
    hostOverride: 'stackoverflow.com',
    renderWait: '#mainbar',
    urlEnv: 'STACKOVERFLOW_URL',
  },
];

/** Shape returned by the __DISCERNED_TEST_ANCHORS bridge (mirrors capture.ts). */
export interface AnchorResult { selector: string; count: number; }
export interface TaggerAnchorReport {
  name: string;
  anchors: AnchorResult[];
  dead: string[];
  allDead: boolean;
}
