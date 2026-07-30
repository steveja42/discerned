# Corpus-sweep capture-quality — handoff

Status snapshot for picking this up in a fresh context. The corpus sweep
(`tests/e2e/corpus-sweep.spec.ts`) captures the uncurated domains listed in
`tests/fixtures/corpus-domains.json` (195 as of 2026-07-30 — Phase 4.4 added
100 seeds; Phase 4.5 added 6 book/film/music review+catalogue entity pages),
scores each
clip with content-free heuristics, and writes 3 images/domain (source/clip/cast)
to `test-output/corpus-sweep-run/`. A human visual review lives in
`test-output/corpus-sweep-run/visual-findings.json` (the gallery sorts by it).

## PHASE 4.5 (2026-07-30) — book/film/music review+catalogue sites

Added the 6 missing sites in the "rate + review a work" class (the corpus already
had goodreads-book, goodreads-author, letterboxd, rottentomatoes, metacritic,
discogs, lastfm): **storygraph, librarything, rateyourmusic, spotify-album,
applemusic-album, ytmusic-album**. All 6 URLs discovered live; 7 of the 9 sites in
this class captured and were eyeballed (verdicts in `visual-findings.json`).

### FIXED (2026-07-30) — the four defects this batch found

**1. Small images ballooned to full width (the class's dominant defect).** Seen on
letterboxd (festival country FLAGS — a giant stacked column of circles),
metacritic + imdb (Top Cast), spotify/ytmusic/RYM (cover rails). **Two
independent causes, both needed fixing:**
- *Capture* — `annotateLiveImageSizes` early-returned on a zero-size rect, so a
  lazy/off-screen image got NO width/height stamp. An unstamped **SVG** has no
  intrinsic raster size, so with the source CSS stripped it stretched to the full
  column. It now falls back to `naturalWidth/Height`, then the element's own
  attributes, then `SVG_FALLBACK_PX` (24) for SVGs specifically.
- *CSS* — even a stamped size was discarded by `.clip-body img { height: auto
  !important }`. A new rule caps each image at `attr(width px)`, so it renders no
  larger than the source drew it. Verified in Chromium 148: `width="40"` → 40px,
  `width="230"` → 230px, no-attr hero → unchanged full width.
Measured on the real letterboxd capture: images >400px went **63 → 0**, flags
420px → 24px, clip height **57,617px → 30,346px**, with poster (230), related
posters (110) and avatars (40) all at source size.
Note `aspectDistorted: 0` throughout — the images were never *stretched*, just
unwrapped, so **the auto-scorer was blind to this** (letterboxd scored 0.001 /
"likely healthy" while visually wrecked). Don't trust a good composite on an
entity page; look at the clip.

**2. StoryGraph's Community Reviews block was being deleted.** Not a capture
miss — `removeReviewsSection`'s *orphan-ratings cleanup* removed it. That cleanup
drops any prose-free block under a `REVIEWS_SECTION_RE` heading (an Amazon
leftover-star-histogram fix), and StoryGraph's block has no ≥120-char `<p>`. But
on a REVIEW site that block IS the primary content: the 4.29 score, "1,292
reviews", mood percentages and pace/plot distributions. New
`hasAggregateRatingData()` keeps a block carrying a score **and** a count, or ≥3
distribution percentages. The Amazon case is unaffected because its medley is
removed by the MAIN pass (≥3 per-review signals) and never reaches the cleanup —
both behaviours are now pinned by `entity-product.test.ts` +
`tests/fixtures/sites/review-aggregate.html`.

**3. Cross-sell / recirculation tails.** Added media-catalogue rail headings to
`CROSS_SELL_HEADING_RE` ("More by …", "Releases for you", "More to Hear", "Other
Versions", "Recommendations", "Fans might also like", …) and raised
`removeCrossSellRails`' climb from 5 to **8 hops** — SPA catalogue pages nest the
module card deeper than a server-rendered Amazon rail. The no-long-prose +
link/image-dominance + 12k-char guards (re-checked per hop) remain the safety.
Result: ytmusic clip ~1/3 its former height, applemusic text 22KB → 3.4KB.

**4. Spotify's album title was clipped off-canvas.** The captured `<h1>` carries
an inline `white-space: nowrap; font-size: 3rem` from the SPA, which assumes the
source's wide layout — in the narrower clip column it ran off the edge ("The Dark
Side of the Mo…"). `.clip-body` headings now force `white-space: normal
!important` (inline styles need the `!important` to lose). Font-size is left
alone so hierarchy is preserved.

**Verification:** all **20 fixture pixel baselines** pass, 221 extension + 146 web
unit tests, both type-checks and ext lint clean. One baseline was intentionally
updated: `bsky-thread` shrank 13991→13928px, and a row-by-row comparison proved
the first 13,928 rows are **byte-identical** and the removed 63px was pure white
trailing space. **Caveat learned the hard way:** running these baselines at
`--workers=3` produced 3 spurious failures (medium/wikipedia/bsky) that all pass
at `--workers=1` — run them serially before believing a regression.

**Known-residual (deliberately not fixed):**
- *metacritic/imdb Top Cast* stack one photo per row. They're now capped at source
  size (176px), but re-flowing them into a grid needs markup restructuring — each
  photo sits in deeply nested per-card divs. Cosmetic.
- *applemusic "Other Versions"* stub survives (last ~5% of the clip). Its module
  card is a shared ancestor that also holds the album's editorial prose, so the
  long-prose guard correctly refuses to remove it. Forcing it would delete real
  content.
- *ytmusic* album title/artist header still missing (cover → track 1 directly).

**librarything + rateyourmusic: the 403s were URL-SPECIFIC, not domain-wide.**
An earlier pass concluded both domains were permanently bot-walled (hard 403 on
headless, headed AND curl). **That was wrong** — the user supplied different URLs
on the same domains and both capture fine:
- `librarything` — `/work/<id>/<id>` (e.g. `/work/24789629/319692205`) loads
  **headless**; the `/work/<id>/t/<slug>` form 403s. Now the richest capture in
  this whole class (see the verdict note).
- `rateyourmusic` — `/song/<artist>/<title>/` clears on the **headed retry**; the
  `/release/album/...` form hard-403s.
LESSON: a 403 on one deep link is not evidence the domain is walled. Try another
URL shape on the same site before writing a domain off — and note `curl` 403s
prove nothing either way, since it carries no `cf_clearance`. The RYM
`Invalid target origin 'null'` seen earlier came from the opaque-origin block
page, not from the site proper; it does not recur on the working URL.
The `blocked` verdict (new, ranks after `clean`) stays in the gallery vocabulary
for genuinely uncapturable domains, but nothing in this class needs it now.

**`librarything-catalog` (member catalog) is a CRITICAL capture defect — content
in a CHILD IFRAME.** The clip is just the "20 YEARS" badge + three nav links,
while the source renders a full 3-book table (covers/titles/authors/tags/ratings).
Diagnosed with `finder-diag-probe` plus a frame dump: the table lives in
**`catalog_bottom.php`** (3 tables / 6 rows) and the **top document has 134 chars
and ZERO tables** — so there is nothing for the layout finder to pick and no
scoring tweak can help. This is NOT a finder mis-pick (the initial guess,
"table-shaped content with no `<p>` prose", was wrong). Fixing it needs
cross-frame capture — the same `chrome.webNavigation.getAllFrames` +
`chrome.scripting.executeScript` round-trip `harvestEmbeddedTweets` already uses.
Caught by the scorer as `blank-space 41%`.

**Sweep block-detector fix:** `music.youtube.com` serves a UA-sniff stub ("Sorry,
YouTube Music is not optimized for your browser") to the headless UA. It is short
and chrome-free, so the scorer read it as a **healthy 100 %-coverage clip** — the
same false-pass class as the phys.org block already documented in the detector.
Added `is not optimized for your browser` / `unsupported browser` /
`browser is not supported` to the CHALLENGE list (CF-shaped: the headed retry
sends the real branded-Chrome UA and gets the actual album page). Verified: the
domain now SKIPs headless then captures on the headed retry.

**Discovery-tool fix:** the scrape path waited a fixed ~5 s, so JS-hydrated
listing grids (StoryGraph/Turbo, RYM charts) reported `no link matched picker`
even though their regex was correct — the picker probe, which waits longer, said
"would match now". It now re-scrapes up to 5×2.5 s before declaring a miss,
mirroring the `direct` branch's existing poll. Also fixed the librarything regex
(`/work/<id>/t/<slug>`, not bare `/work/<id>$`) and the ytmusic seed (use the
canonical `/browse/MPREb_<id>` form — `OLAK` playlist ids rot, and a dead one
renders the signed-in chrome with an EMPTY content pane, which reads as a bot
wall but is really just a dead id).

## RESOLVED (2026-07-24) — AP News (P1), Hacker News, YouTube view-count (P2)

All three fixed in `discerned-ext/src/content/capture.ts`; guarded by fixtures.

- **AP News — fixed GENERICALLY, no tagger. VERIFIED LIVE (the offline-only
  diagnosis was WRONG).** The handoff's "layout finder picks comments" was
  incomplete: with `smartArticleDetection:false` (the sweep's capture-bridge
  default) **`findArticleElement` (Tier 1) wins**, and `ARTICLE_SELECTORS[0]`
  `article` matches Viafoura's `<article class="vf3-comment">` — so the FIRST
  `<article>` on the page is a comment. Fixed at THREE layers keyed off a new
  `COMMENT_WIDGET_SELECTOR` (Viafoura/Disqus/Coral/OpenWeb/FB/Hyvor/Commento):
  `findArticleElement` skips comment-widget `<article>`s, `scoreContentBlock`
  won't pick a comment block, `markExcluded` drops the widget from a whole-
  `<main>` capture. Live sweep now: `textCoverage 0.098→0.626`, story captured,
  no comments. Guards: `comment-widget.test.ts` (BOTH detection modes — the bug
  only shows at `false`) + `apnews-article` sidecar (fixture uses real
  `<article class="vf3-comment">`). LESSON: offline fixtures + a finder-only fix
  falsely passed; you MUST drive a live capture (Chrome Profile 3 probe, or the
  sweep) to confirm — the isolated-world logs aren't visible to Playwright's
  page-console listener.
- **Hacker News — new `tagHackerNews` tagger** (`ycombinator.com`). HN is nested
  `<table>` soup, no `<article>`. Stamps `dx-post`/`dx-reply` per comment with
  `dx-byline` + body, `dx-stats` post-meta, indents by `td.ind[indent]`, drops
  vote arrows / `[–]` toggles / nav links / masthead / reply form. Returns
  `#hnmain`. Guards: `hackernews-thread` fixture + sidecar + anchor test +
  `hackernews-thread-fixture-visual` pixel baseline (via `hostOverride`).
- **YouTube view-count (P2) — fixed in `tagYoutube`/`postCloneYoutube`.** The
  `<yt-animated-rolling-number>` odometer's per-digit positioned spans collapsed
  to one-digit-per-line after sanitisation; `rebuildYoutubeInfoBar()` now
  replaces it with a clean `dx-stats` "N views · date" text row (count read from
  the `aria-label`). The like/dislike/subscribe/share/download SVG view-models
  are excluded (oversized glyphs). Also moved the owner/info-bar transforms OUT
  of the `!videoId` early-return in `postCloneYoutube` (they don't need the id;
  the fixture URL lacks `?v=`). Guard: `youtube-viewcount` fixture (POPULATED
  odometer — the full `youtube-watch` snapshot's dynamic widgets are empty) +
  `youtube-viewcount-fixture-visual` pixel baseline.

## The one real open item: AP News tagger (P1) — SUPERSEDED, see RESOLVED above

**Symptom:** the AP News clip captures the **Viafoura reader-comments thread
instead of the article body.**

**Root cause (already diagnosed — don't re-derive):**
- AP article pages have **no `<article>` element** — only `<main class="Page-main">`.
  So capture falls through to the **layout finder** (`findContentBlockByLayout`),
  which picks the biggest text block by area/density.
- The **Viafoura comment thread** is a huge text block that outscores the story.
- The real story body is `<div class="RichTextStoryBody">` (≈6k chars, ~32 `<p>`),
  a child of `<main class="Page-main">`.
- The Viafoura widget roots are: `<div id="ap-comments" class="viafoura">` ›
  `<vf-widget id="vf-conversations">` › `<div id="vf-conv">` › `section.vf-...`.
  Comments **lazy-load** — they're often absent at 3.5 s, present after scroll/6 s.

**What was tried and REVERTED (so you don't repeat it):** a generic comment-widget
exclusion in `markExcluded` (`capture.ts`) — marking `vf-widget, .viafoura, …`
with `EXCL_MARKER` so `removeMarked` drops them, plus a `scoreContentBlock` guard
to skip excluded blocks in the finder. It **stopped comments winning but EMPTIED
the AP capture** (`bodyHtml=0` — the "one image only" symptom). A/B probes proved:
the finder guard alone was NOT the cause (guard on/off both empty), and the
comment selector does NOT wrap the story (`storyWrappedBy: []`), yet capture still
emptied — an internal extraction interaction I couldn't isolate from outside the
extension. **`capture.ts` is back at clean HEAD.** AP currently captures comments
(wrong, but not empty — no regression).

**Recommended fix — a per-site tagger** (the clean tool for this, like
reddit/youtube/goodreads). See `SITE_TAGGERS` in `discerned-ext/src/content/capture.ts`
and `tagGoodreads` / `tagReddit` as templates. Sketch:
```ts
// match: host === 'apnews.com'
function tagApNews(root) {
  // exclude the comment widget so it can't ride into the capture
  root.querySelectorAll('#ap-comments, vf-widget, .viafoura').forEach(el => appendClass(el, 'dx-excl'));
  // return the story column as the capture root → bypasses the finder entirely
  return root.querySelector('main.Page-main') ?? root.querySelector('.RichTextStoryBody') ?? undefined;
}
```
Returning a root makes `extractArticle` capture that subtree directly (Tier 1.5
uses `siteTaggerRoot`), so the finder-vs-comments contest never happens. User is
fine leaving comments in the clip **below** the story — so you could instead NOT
dx-excl them and just return `main.Page-main` (story leads, comments follow).
Add `anchors: ['main.Page-main', '.RichTextStoryBody']` for the canary.

**To finish cleanly, wire up the extension's own logs.** `extractArticle` already
`log(LL.DEBUG, …)`s which tier fires + sizes, but those go to the **content
script's isolated world**, which external Playwright `page.on('console')` can't
read (see memory `feedback_isolated_world_console_context`). Either bump the log
bridge to surface them, or add a temporary `window.__DX_DEBUG` hook the probe can
read, so you can see exactly which tier wins and the text length at each step.

**Verify with:** `tests/fixtures/corpus-domains.json` apnews URL, headed, WITH
comments loaded (scroll to force Viafoura). A working capture has the story text
(`drone|Rocheleau|Zaporizhzhia`) and `bodyHtml` well over a few KB. Add an
`apnews-fixture-visual` pixel baseline once it's right (snapshot the page first —
see `tools/snapshot-fixtures.spec.ts`).

## Other open items (lower priority — see the audit report)

Report: `test-output/corpus-sweep-run/sweep-gallery.html` (sort by "visual
finding") and the artifact at the URL in the session. Priorities:
- **P2 youtube-watch** — view/like counts render one-digit-per-line + oversized
  glyphs. `tagYoutube` stat-row handling. Cosmetic.
- **P3 imdb, amazon buy-box** — structured entity pages; imdb captures poster+title
  only, amazon has residual buy-box lines after the Prime/cross-sell strip. Small
  taggers each; low value.
- **P4 paywalls** (nytimes, theatlantic, bloomberg, economist) — real articles,
  body truncates at the paywall gate. NOT a capture bug. BUT: user reports **NYT is
  NOT truncated when clipped from the test profile** — so NYT's sweep truncation may
  be capture-timing / login-state, worth a recheck (maybe just needs the article-
  body wait / a warm login).

## What changed this session (all in the working tree, uncommitted)

- `tests/fixtures/corpus-domains.json` — every URL is now a real ARTICLE deep-link
  (was mix of homepages/sections). Discovered live via
  `tests/e2e/tools/discover-article-urls.mjs`. reddit→thread, bloomberg/reuters/
  theatlantic/economist→articles. URLs rot; re-run the discovery tool to refresh.
- `tests/e2e/corpus-sweep.spec.ts` — two-pass (headless main + **headed retry** for
  CF-challenged domains, no manual clicking needed), interstitial/block detector
  (skips CF/403/iframe-wall pages cleanly), `clearSwCacheForRawDir` (so background
  rebuilds take effect on the raw Profile 3), and a **best-effort article-body wait**
  before capture (helps lazy-loading news sites — reuters/AP).
- `tests/e2e/corpus-sweep-manual.spec.ts` (NEW) — converted the old raw-`.mjs`
  manual pass into a spec so it can build **casts** via `castShotSafe`, WAITS on
  block pages instead of capturing them, and has the same body-wait. Run:
  `SWEEP_MANUAL=1 SWEEP_MANUAL_ONLY=apnews SWEEP_MANUAL_WAIT_MS=60000 pnpm exec
  playwright test -c tests/e2e/playwright.config.ts --project=corpus-sweep-manual`
- `tests/e2e/tools/sweep-gallery.mjs` — reads `visual-findings.json`, shows a
  verdict pill per row, and **sorts by visual finding** (default) / score / date.
- `tests/e2e/playwright.config.ts` — registered `corpus-sweep-manual` project
  (and anchored `corpus-sweep` testMatch so it doesn't also match `-manual`).
- `tests/e2e/helpers/sweepArtifacts.ts` — added `note` + `VisualFinding` types.
- `discerned-ext/src/content/capture.ts` — **CLEAN HEAD** (AP comment-exclusion
  fully reverted). Amazon cross-sell (`removeCrossSellRails`) + Prime/commerce-promo
  removal + the substack cast phantom-hero fix (`markdownHasAnyImage`) from earlier
  in the session ARE committed/kept — verify with `git diff` if unsure which.

## Which sites need HEADED runs (important for future sweeps)

The main sweep runs **headless** and auto-retries CF-challenged domains headed at
the end (no clicking needed). But several sites only capture correctly headed, in
three tiers:

**A. Auto headed-retry (handled by the sweep itself — no action needed).** The
sweep's pass 2 opens a brief headed window for domains that hit a Cloudflare
Turnstile challenge headless and re-captures them. The profile's `cf_clearance` +
a visible window clears them with **no manual clicking**:
- `politico`, `axios`, `economist`, `medium-generic`

**B. Need the MANUAL headed pass (`corpus-sweep-manual` spec).** These HARD-block
headless (IP/bot walls, 403 stubs) or are too lazy-load-flaky for the headless
timing. Run them via the manual spec (headed, waits, builds casts):
- `reuters` — bot wall + lazy body; headless gets the block page or empty body.
- `bloomberg` — paywall + bot wall; article deep-link 403s headless.
- `imdb`, `goodreads-book`, `nytimes` — 403 / entity-page stubs headless.
- `hackernews` — returned an empty/iframe-wall body headless in the sweep.
- `reddit-thread` — Reddit "blocked by network security" page headless.
```
SWEEP_MANUAL=1 SWEEP_MANUAL_ONLY=reuters,bloomberg,imdb,goodreads-book,nytimes,hackernews,reddit-thread \
  SWEEP_MANUAL_WAIT_MS=90000 pnpm exec playwright test \
  -c tests/e2e/playwright.config.ts --project=corpus-sweep-manual
```
(Default `SWEEP_MANUAL_ONLY` is `reuters,imdb,goodreads-book,nytimes,hackernews`.)
Most of these actually cleared **without** manual interaction once headed — but the
window must be visible. Watch it; solve any wall that does appear within the wait.

**C. AP News** — captures headless but grabs comments (the open P1 above). Once it
has a tagger it should work headless.

Everything else (the ~40 clean domains) captures fine **headless**.

## Run the sweep

Chrome must be **fully closed** (Profile 3 single-instance lock — `taskkill /F /IM
chrome.exe` if a probe left zombies), and the web app up on :3000 (`pnpm dev`).
```
SWEEP=1 pnpm exec playwright test -c tests/e2e/playwright.config.ts --project=corpus-sweep
node tests/e2e/tools/sweep-gallery.mjs   # rebuild gallery from disk
```
Profile 3 (`.vscode/browser-test-profiles/chrome/Profile 3`) has the extension
hand-installed + a warm `cf_clearance` — the only setup that clears Cloudflare AND
runs the extension. See memory `project_real_chrome_extension_cdp_load`.

## Gotchas that cost time this session

- **Chrome zombies**: rapid probe runs leave chrome.exe processes holding the
  Profile 3 lock → `launchPersistentContext` fails or captures degrade. Always
  `taskkill /F /IM chrome.exe` between runs; check `tasklist | grep -ci chrome`.
- **Stale MV3 service worker**: background changes (createLongFormEvent, BUILD_CAST)
  serve STALE unless the SW/code cache is cleared (`clearSwCacheForRawDir` does this
  for the sweep; standalone probes must `rmSync` the Service Worker/Code Cache dirs).
- **Lazy content**: AP/Reuters inject the story after first paint; capturing at
  3.5 s can miss it. The specs now wait for a populated article body.
- **Isolated-world logs**: extension `log()` output isn't visible to Playwright's
  page-console listener — it's in the content-script world.
