// Phase 3.1/3.2 — canary targets for each per-site tagger.
//
// At least one entry per tagger registered in SITE_TAGGERS (discerned-ext
// capture.ts). A tagger gets MORE than one entry when the site has distinct page
// SHAPES that render different containers — primal has a profile feed and a
// thread; the shared manifest must group those variants, so only a per-shape
// target (via `extraAnchors`) can pin the selector unique to each shape.
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
  /** Tagger name — must equal the SITE_TAGGERS `name`. Resolves which tagger's
   *  manifest runs. A tagger may have MORE THAN ONE target (see primal: profile
   *  feed + thread), so this is not unique across the list. */
  name: string;
  /** Display label in the report. Defaults to `name`; set it when a tagger has
   *  several targets so the report distinguishes them (`primal:thread`). */
  label?: string;
  /** A stable live URL that exercises the tagger's layout. */
  url: string;
  /** Host the anchor check resolves the tagger by (SITE_TAGGERS match input). */
  hostOverride: string;
  /** CSS selector to wait for before checking anchors (SPA has rendered). */
  renderWait: string;
  /** Env var overriding `url` (so a dead link can be swapped without a code edit). */
  urlEnv: string;
  /**
   * Selectors this SPECIFIC page shape must also match, beyond the tagger's
   * shared manifest. The shared manifest has to hold for every page shape, so
   * it groups variants (`_primaryNote_, _noteThread_`) — which alone would let a
   * rename of one variant slip through. A shape-specific target pins the
   * selector that only IT renders. Dead ones fail exactly like a manifest anchor.
   */
  extraAnchors?: string[];
}

export const TAGGER_CANARY_TARGETS: TaggerCanaryTarget[] = [
  {
    name: 'primal',
    // A profile page reliably renders notes headless; a single-note nevent URL
    // sometimes stalls on relay fetch. Override with PRIMAL_URL for a specific
    // note/thread. jack's npub — stable, high-activity.
    //
    // NOTE: this is a PROFILE feed, which renders `_noteThread_` rows and NO
    // `_primaryNote_`. That is why the primal anchor manifest groups the two
    // page-shape variants into one selector — see SITE_TAGGERS in capture.ts.
    // Don't "fix" a `_primaryNote_ → 0` report here by editing the tagger.
    url: 'https://primal.net/p/npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m',
    hostOverride: 'primal.net',
    renderWait: '[class*="_primaryNote_"], [class*="_noteThread_"], article',
    urlEnv: 'PRIMAL_URL',
  },
  {
    // Second primal shape. The profile target above renders NO `_primaryNote_`,
    // so on its own it can never notice primal renaming the main-note class —
    // the grouped manifest anchor would still match via `_noteThread_`. This
    // thread target pins `_primaryNote_` (and the reply/quote structure the
    // profile feed doesn't exercise) via extraAnchors.
    //
    // A note URL can stall on relay fetch where a profile feed wouldn't; that
    // shows up as a SKIP, not a FAIL, so a slow relay never breaks the run. The
    // profile target remains the reliable primal signal.
    name: 'primal',
    label: 'primal:thread',
    // Same note the primal-visual spec captures — known to render.
    url: 'https://primal.net/e/nevent1qqs23jpquykrlg2psqhyhhxzn06nmf3dr6yejwvgws0733x8d9vgnugqfuqeq',
    hostOverride: 'primal.net',
    // Deliberately NOT `_primaryNote_` alone: if that class were renamed, a
    // wait on it would time out and report SKIP, hiding the very regression
    // this target exists to catch. Wait on any rendered note, then let the
    // extraAnchors check deliver the FAIL.
    renderWait: '[class*="_primaryNote_"], [class*="_noteThread_"], article',
    urlEnv: 'PRIMAL_THREAD_URL',
    extraAnchors: ['[class*="_primaryNote_"]'],
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
  {
    name: 'hackernews',
    // A high-comment story so table.fatitem + tr.athing.comtr both render.
    url: 'https://news.ycombinator.com/item?id=38710709',
    hostOverride: 'news.ycombinator.com',
    renderWait: '#hnmain, table.fatitem',
    urlEnv: 'HACKERNEWS_URL',
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
