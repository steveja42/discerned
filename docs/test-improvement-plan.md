# Test-suite & capture-quality improvement plan

*From the 2026-07-12 full test review: all 16 Vitest files + ~55 Playwright specs reviewed, all 14 live
visual specs run and screenshots inspected, always-on e2e baseline run. Evidence in `test-output/`.*

## Key findings

**Test-suite defects (tests that can't find bugs):**
- `extension.spec.ts` used `mode: 'serial'` → the pre-existing `reddit-thread` failure aborted 8 other
  fixtures every run, including `xss-injected.html` (the sanitization e2e guard never executed).
- Live visual specs for bsky/goodreads/reddit/youtube/wikipedia/bbc/stackoverflow had **zero assertions**
  (screenshot-only). Broken Reddit output "passed". Only primal-visual asserted structure, and its checks
  missed its own defect (stray stretched avatar outside the dx elements it checks).
- `discerned-web/tests/parse.test.ts` hand-mirrors the **old** event format (leading `Discerned:` summary
  line) that the extension no longer emits — the cross-package round-trip test can't catch drift anymore.
  `tweet-cast-photos-visual.spec.ts` likewise mirrors the retired `--- body ---` format.
- Screenshots of clip bodies taller than 16,384 px are garbage (Chromium raster-tile limit: first ~8k px
  render, then tile-duplication + blank). wikipedia/stackoverflow renders were unjudgeable below the fold.
  `youtube-visual` already caps viewport at 8,000 px; others didn't.
- `web-shot.spec.ts` was a leftover debug spec running in every default suite, writing a PNG into a stale
  session temp dir.

**Capture bugs found (live sites, 2026-07-12):**

| Site | Severity | Defect |
|---|---|---|
| Reddit | **Broken** | Comments squeeze to one-word-per-line columns; "N more replies" renders letter-per-line vertically, duplicated; sort-menu chrome captured. `tagReddit` drifted from current DOM. Fixture e2e fails the same way. |
| Bsky | Poor | "Suggested for you" rail captured; "Reposted by" label renders as crushed vertical strip; tab-bar text leaks. |
| Primal | 1 defect | One reply obscured by giant stretched avatar-ellipse; orphan bare-number stat rows. |
| Medium | 2 defects | Engagement row duplicated 4×; "Press enter or click to view image in full size" captions survive. |
| ZeroHedge | Chrome leaks | Share-icon row + "ADD US ON GOOGLE" top; "Want to know more?" + newsletter + "Show Comments" bottom. |
| Breitbart | Minor | Two in-article "Discover more" boxes leak. |
| BBC | Minor | Share/Save/preferred-source row; byline runs together ("…Rahman-JonesTechnology reporter"); related-story teasers. |
| StackOverflow | Minor | Share/Follow/Improve link chrome; badge counts run together ("28.1k2222 gold badges…"). |
| Goodreads | Minor | Skip-link + duplicate title link; genre pills overflow; reader avatars stack vertically. |
| YouTube | Minor | Comments empty (not loaded pre-capture); "…more Show less" residue; "399M views21 years ago" run together. |
| Twitter/X | Excellent | — |

Cross-site patterns: (a) **run-together text** where inline-block siblings lose separation after CSS strip
(BBC byline, SO badges, YT views/date); (b) **related-content / newsletter blocks** leak on 3+ news sites.

**Unit-coverage gaps:** ext — background.ts handlers, relay-manager (≥2-ACK/timeout), overlay.ts,
web-bridge.ts (bodyHtml-strip contract), auth/nip46. web — matchesSignal/matchesQualifiers/
deriveQualifierOptions (new rating filters), enex-parser, export-utils, useLibraryBridge, useNostrAuth,
DetailPanel gallery, feed.ts/follows.ts.

---

## Phase 1 — Make the tests trustworthy  *(done 2026-07-13, except noted deferrals)*

- [x] 1.1 Drop `mode: 'serial'` in `extension.spec.ts` so one fixture failure can't hide the rest.
      Consequence (intended): `reddit-thread` + `youtube-watch` now fail visibly (pre-existing bugs);
      `xss-injected` and the other formerly-skipped fixtures run again.
- [x] 1.2 Delete `web-shot.spec.ts` (leftover debug spec).
- [x] 1.3 Shared `assertClipBodyHealth(clipBody)` helper (`tests/e2e/helpers/clipBodyHealth.ts`), wired
      into all 13 live visual specs + `fixtureVisual.ts` (all fixture-visual specs). Checks: dx-header
      flex & ≤90 px; dx-reply height > 0; zaps-row avatars ≤ 32 px; img aspect distortion (catches the
      primal blob); narrow-column text squeeze (catches reddit/bsky strips); giant blank runs;
      chrome-leak strings. primal-visual's inline assertions were folded into the helper.
      NOTE: primal/bsky/reddit/zerohedge/bbc/goodreads live specs are EXPECTED to fail these until
      Phase 2 fixes land — that is the point. Use `disable: ['chrome-leak']` etc. only for documented
      exceptions.
- [x] 1.4 Tall-safe screenshots: `tests/e2e/helpers/clipShot.ts` (`screenshotClipBody`) replaces the
      per-spec viewport/element-screenshot blocks. Elements taller than 8,000 px get a viewport-clipped
      page screenshot of the top instead of Chromium's blank/tile-duplicated element capture.
- [x] 1.5 Kill parse.test.ts drift: `discerned-ext/tests/nostr/event-fixture-generation.test.ts`
      regenerates `tests/fixtures/events/*.json` (16 templates: kind1 / kind1-longform-ref / kind30023
      per clip fixture) from the REAL factory on every ext `pnpm test` (write-if-changed, committed).
      Web `parse.test.ts` signs + parses all of them; the old hand-mirrored block is kept as an explicit
      LEGACY-format test (old casts live forever on relays).
      *Resolved 2026-07-14:* tweet-cast-photos-visual migrated to the current kind-1 format (sentinel
      snippet + `body` tag + imeta, no `--- body ---`). See Cast-rendering test layer below.
- [x] 1.6 New unit tests (+42 total; suites now ext 119 / web 75):
      `tests/filters.test.ts` (matchesSignal/matchesQualifiers/deriveQualifierOptions/signalRank),
      `tests/enex-parser.test.ts` — **found + fixed a real bug**: `querySelector('parseerror')` typo
      (should be `parsererror`) meant invalid ENEX silently returned `[]` instead of throwing,
      `tests/export-utils.test.ts` (CSV escaping incl. quotes/commas/newlines, JSON payload),
      `discerned-ext/tests/background/relay-manager.test.ts` (ACK thresholds local/production, the
      resolved-"connection failure"-string-is-a-failure quirk, explicit override).
      *Deferred:* background GET_CLIPS bodyHtml/thumbnail-strip unit test — the handlers are closures
      inside background.ts (importing it boots the whole SW against incomplete chrome shims, and
      IndexedDB needs fake-indexeddb). Needs a small deliberate refactor (export handlers) first; the
      contract is meanwhile covered by end-to-end.spec.ts through a real browser.

## Phase 2 — Fix the capture bugs  *(done 2026-07-13, except noted deferrals)*

All new generic logic lives in `sanitiseTreeInPlace` so every capture path (site-tagger or generic;
article/selection/full-page) inherits it. New fixture `chrome-patterns.html` + `chrome-patterns.test.ts`
guard the generic passes; `matchExpected` gained a `bodyText.excludes` assertion (ext + e2e mirrors).

- [x] 2.1 Reddit: the squeeze was NOT a tagger-selector drift — the comment DOM tagged fine. Root causes
      were (a) "N more replies" lazy-loaders rendered 3× per branch into grid gutters that collapsed to
      letter-per-line strips, and (b) flex children losing separation. Fixed by dx-excl'ing
      `faceplate-partial[slot^="children"]` / `[slot="loading"]` / `a[slot="more-comments-permalink"]`
      + the bare "Sort by:" label, plus the generic `applyFlexSeparation`. DOM probe post-fix confirmed
      zero squeezed text. Also de-flaked reddit-visual.spec (re-post BRIDGE_CLIPS until the row mounts —
      the huge image-inlined clip raced React). *No re-snapshot needed.*
- [x] 2.2 Bsky: dx-excl "Suggested for you" module (climb to the avatar-bearing wrapper) + all
      "Reposted by …" leaf labels (scanned at feed level, not per-post). Header name-under-avatar fixed
      with a `.dx-header:has(img.dx-avatar)` float rule (bsky nests the avatar ~7 levels inside the
      header's first child, so the flex-row avatar/name split couldn't see it). bsky-visual now passes
      all health checks.
- [x] 2.3 Generic chrome pass `removeGenericChrome`: skip-links, exact-text chrome verbs
      (share/save/follow/improve/report/show-comments/add-us-on-google), related-content boxes
      (strong headings removed structurally; weak headings require link-dominance + no long prose),
      newsletter blocks, "preferred source" promos, and ARIA menu/listbox/tablist/select. Also strips
      HTML comments during the sanitise walk. Skips tweet-card subtrees.
- [x] 2.4 Generic text-spacing `applyFlexSeparation`: `annotateLiveImageSizes` now also marks
      flex/grid containers (and containers whose span/a children are block/inline-block) with
      FLEXSEP_MARKER on the live DOM; the pass inserts a space text node between their children on the
      clone. Fixes "399M views21 years ago", "Imran Rahman-JonesTechnology reporter". Also added an
      sr-only (1px-clip / absolute) exclusion in `markExcluded` → fixes SO "2222 gold badges".
- [x] 2.5 Medium: dedup identical `.dx-stats` rows (the "79 4" ×3 engagement duplication) + drop
      image-viewer hint captions ("Press enter or click to view image…"). primal gray-ellipse fixed by
      guarding every dx-reply-row / dx-header avatar-cell CSS rule with `:not(:only-child)` (an
      avatar-less reply's single child is the CONTENT column, which the positional rule was painting as
      a 561×40 ellipse). YouTube: dx-excl the "…more/Show less" expander toggles + the empty Comments
      section. *Goodreads pill-wrap + avatar-pile deferred — cosmetic, no health-check failure.*
- [x] 2.6 youtube-watch fixture: stripped the 62 surviving `<script>` blocks (one of which rewrote
      `location` via history.replaceState, causing the `capture.url` mismatch) — fixture shrank 1.9 MB →
      619 KB and still captures. Note: the reddit-thread + youtube-watch extension.spec captures may
      still be network-sensitive; re-verify with the default e2e project.

## Cast-rendering test layer  *(added 2026-07-14)*

**The gap it closes:** every visual test verified the CLIP path (`bodyHtml` → `/clips`). Nothing rendered
a PUBLISHED cast. The public feed prefers the kind-30023 long-form (dedup wins over the companion kind-1),
and its body is `htmlToMarkdown(bodyHtml)` — a conversion no test exercised. That shipped four defects
(tweet + primal casts): giant full-width avatars, `](url)` brace spills from block-content anchors
(`tweet-video`, `dx-quote`), smashed stat digits (`852862`), and a duplicate hero above inline media. A
substring assertion in `long-form.test.ts` passed while the rendered output was broken.

Two new layers, both proven to fail on the pre-fix code (verified by disabling the fix rules):

- **Unit — `discerned-ext/tests/nostr/cast-markdown.test.ts`**: runs the REAL `htmlToMarkdown` over
  representative tweet-card and primal-note-card HTML; asserts no brace spills (a `](` with no `[` opener
  on the same line), no data: URIs, name/handle separated, video poster as one nested linked image, photo
  inline, stats separated (`8 · 528 · 62`, never glued), avatars dropped (never full-width images).
- **Web e2e — `tests/e2e/web-cast-render.spec.ts`** (always-on `web` project): signs the generated
  kind-30023 card fixtures, delivers them through the mocked relay, renders each in the real feed +
  DetailPanel (ReactMarkdown), and asserts the rendered DOM — no literal `](`, exactly one poster image,
  zero avatar images, blockquoted embedded note, hero inline exactly once (not duplicated as a top hero).

**Fixtures:** `event-fixture-generation.test.ts` now also emits `card-{tweet-card,primal-note,article-
inline-img}.kind30023.json` from real card HTML through the real `htmlToMarkdown` + `createLongFormEvent`.
Regenerate via `pnpm test` in discerned-ext; commit the diff.

**Converter fixes (`html-to-markdown.ts`):** avatar/icon-image drop (alt=avatar, dx-avatar, ≤72px);
`safe-links` rule (never wrap multi-line anchor content → no spill; drop emptied links); `dx-quote` →
blockquote; `tweet-video`/`tweet-header`/`tweet-footer`/`dx-header`/`dx-stats` rules that rebuild clean
lines. Plus the extension capture fixes: `data-dx-src` plumbed through tweet photo/video builders (so the
markdown keeps the real URL), bare `video[poster]` fallback for newest X DOM, and `number-flow-react`
odometer count reading. Web: DetailPanel suppresses the top hero when the markdown already carries it inline.

## Phase 3 — Handle future site redesigns efficiently  *(done 2026-07-21)*

Foundation is the **selector-anchor manifest** (3.2): each `SITE_TAGGERS` entry declares its load-bearing
selectors, and `checkTaggerAnchors(host, root)` (exported from `capture.ts`) reports per-selector match
counts + the dead list + `allDead`. 3.1 and 3.4 both consume it. Guarded by
`discerned-ext/tests/extraction/tagger-anchors.test.ts` (unknown-host → null, real fixture → all live,
redesigned page → allDead). Full write-up in `discerned-ext/CLAUDE.md` → "Tagger canary / repair loop".

- [x] 3.1 Lightweight weekly canary `tests/e2e/tagger-canary.spec.ts` (`CANARY=1`, `--project=tagger-canary`):
      visits each tagger's live target (`helpers/taggerCanaryTargets.ts`), runs its anchor manifest against
      the live DOM via a new `__DISCERNED_TEST_ANCHORS` bridge (tree-shaken in prod), FAILS naming the exact
      dead selector, page-load flakes are SKIPs not fails. Scheduled two ways: `scripts/tagger-canary-local.ps1`
      (warm `test` Chrome profile → covers CF-walled Reddit/YT/SO — the authoritative run) and
      `.github/workflows/tagger-canary.yml` (Mondays 08:00 UTC, open sites only). *Verified live 2026-07-21:*
      reddit/youtube/bsky/goodreads anchors all matched; primal/SO skipped on infra as designed.
- [x] 3.2 Selector-anchor manifests per tagger — the `anchors` field on every `SITE_TAGGERS` entry (see above).
- [x] 3.3 Repair loop documented in `discerned-ext/CLAUDE.md` (+ root pointer): canary fail → read
      `test-output/tagger-canary.txt` → `SNAP=1` re-snapshot → fix tagger + `anchors` offline against the
      fixture-visual spec → `--update-snapshots` → refresh gallery → commit together.
- [x] 3.4 Graceful degradation: `applySiteTagger()` runs the anchor check BEFORE the tagger — if `allDead`
      it skips the tagger and falls back to the generic pipeline, logging the dead selectors at WARN (partial
      death warns but still runs). Post-capture `selfCheckCapture()` in `captureContext()` WARNs when a
      tagger-active clip carries zero dx-* markers or its body text is <5% of the visible page text.

## Phase 4 — Confidence across the broad web

- [x] 4.1 Corpus sweep harness *(built + smoke-verified 2026-07-21)*: `tests/e2e/corpus-sweep.spec.ts`
      (`SWEEP=1`, `--project=corpus-sweep`) runs article capture across `tests/fixtures/corpus-domains.json`
      (~50 uncurated popular domains; `SWEEP_ONLY` / `SWEEP_LIMIT` / `SWEEP_URL_<NAME>` env filters), scores
      each clip with four **content-free** heuristics (`helpers/sweepScorers.ts`: text-coverage %, blank-space
      ratio, aspect-distorted imgs, chrome-string hits → weighted composite, worst = 1), writes three images
      + a `score.json` per domain to `test-output/corpus-sweep-run/{domain}--{1-source,2-clip,3-cast}.png`
      (`helpers/sweepArtifacts.ts`), and builds a worst-first / by-date sortable review gallery with an
      "only flagged" filter (`helpers/sweepGallery.ts` + `tools/sweep-gallery.mjs`). Every per-domain stage
      (load, capture, AND render/score/cast) is wrapped so any failure demotes that one domain to a SKIP and
      the sweep continues — the whole run is a single serial test, so an un-caught throw would otherwise kill
      every downstream domain (a stray reuters `.clip-body` timeout aborted 48). Load-vs-capture failures are
      SKIPs, not scored findings (same split as the tagger canary). **Launches the warm branded-Chrome
      profile** (`.vscode/browser-test-profiles/chrome` / `Profile 3`, extension hand-installed + valid
      `cf_clearance`) via `launchWithExtension({ preinstalledExtension, channel:'chrome' })` — runs **headless**
      (verified: StackOverflow clears Cloudflare and the capture bridge responds with no window on screen), so
      it doesn't interfere with the user's machine. Calibration: high text-coverage on a minimal-chrome page
      is the *healthy* case, so the high-coverage signal only feeds the composite when `chromeHits > 0`
      (otherwise noted informationally, weight 0) — this keeps text-only pages (danluu, paulgraham, HN,
      Wikipedia) out of the worst decile. This is a **discovery tool, not a CI gate**: it triages which unseen
      sites are likely broken so a human can classify failures as *patterns* and fix them generically (per the
      capture-quality philosophy: general solutions over per-site ones). The pixel-baseline fixture specs
      remain the real regression floor.
### 4.1 first-run findings *(50-domain headless sweep, 2026-07-21)*

43/50 scored, 7 skipped (all clean challenge/error skips), no crash. The sweep triaged the worst decile
into three buckets — only the first is a real pipeline defect:

- **🔴 Hero-only capture (the real, generalizable finding)** — on 5 modern article layouts (**github-blog,
  npr, arstechnica, aljazeera, css-tricks**) capture locked onto the article's **hero/header card** (hero
  image + category + headline + dek + byline) and **stopped before the prose body**, giving text-coverage
  2.7–4.0%. This is a *pattern*, not 5 site quirks: `findContentBlockByLayout` appears to score the large
  visual hero block above the text body, and `maybeExpandToFeed` doesn't widen to include the body (or the
  body is lazy-loaded below the fold at the 3.5 s capture mark). **Follow-on fix (generic, not per-site):**
  make the layout finder prefer/expand to the block whose subtree maximises text density even when a
  sibling hero card has larger visual area; add a github-blog or ars fixture as the guard. This is exactly
  the kind of class-N defect the sweep exists to surface.
- **🟠 Wrong corpus URL (fixture hygiene, not a capture bug)** — **cnn** and **vox** entries point at a
  homepage/section feed, so capture correctly grabbed the headline grid. Fix the corpus URLs to single
  articles; not a pipeline defect.
- **🟡 Challenge / error interstitials** — 7 domains (politico, axios, economist, medium-generic = Cloudflare
  "security verification"; imdb, goodreads-book = "403 Forbidden"; reuters = an "Access is temporarily
  restricted" bot-block rendered *inside an iframe*) navigated fine but had no article. **Fixed in-harness**:
  a post-load interstitial detector demotes them to load-vs-capture SKIPs so they no longer pollute the
  scored set or worst decile. It matches CF / bot-check / 403 / access-denied signature text on a <1500-char
  page, ALSO reads same-origin iframe bodies (Reuters' wall is in an iframe → top-doc `innerText` is empty),
  and treats a near-empty body (<20 chars after the 3.5 s paint wait) as a skip outright — an empty page has
  nothing to capture regardless of cause, and would otherwise fall through to a confusing "render/score
  failed" when the empty clip never paints a `.clip-body`. (Note: these bot-blocks are IP/network-level, not
  solvable CAPTCHAs — a headed run + manual click wouldn't clear them, so skipping is the correct handling.)

- [ ] 4.2 Re-run sweep quarterly / after major pipeline changes; pixel-baseline fixture specs remain the
      regression floor. **Open follow-on from the 4.1 first run: fix the hero-only capture defect
      generically + add a fixture; correct the cnn/vox corpus URLs to single articles.**

## Known pre-existing failures  *(fixed 2026-07-21)*

- [x] `reddit-thread` in extension.spec: the sidecar expected tagger-only content (`Fallout76` subreddit
      byline) but the e2e ran the GENERIC pipeline — site taggers gate on the live hostname, which is
      `127.0.0.1` under the fixture server, so `tagReddit` never fired. Fixed by threading an optional
      `hostOverride` from the sidecar (`ExpectedCapture.hostOverride`) through `loadSiteFixtures` →
      `extension.spec` → the `__DISCERNED_TEST_CAPTURE` bridge, and through `article.test.ts` via
      `__setTestHostOverride`; `reddit-thread.expected.json` sets `hostOverride: "www.reddit.com"`. Also
      fixed a genuine tagger leak the firing exposed: `tagReddit` now dx-excl's `shreddit-sort-dropdown`
      wholesale (its "Open comment sort options" tooltip text lived in a slotted `<div>` the label pass
      couldn't reach). `youtube-watch` was already passing (its `contains` needle is the video title, which
      the generic path surfaces). extension.spec now 24/24.
- [x] Fixture-visual pixel baselines: re-recorded after per-spec visual confirmation. Most were pure
      sub-pixel/1px-height font drift or an *improved* render (primal −150 px of stale whitespace; reddit
      now renders via the real tagger). One was a genuine defect, not drift: **bsky reply headers** crushed
      into a one-word-per-line column because `.dx-header:has(img.dx-avatar) img.dx-avatar { float:left }`
      lacked `!important` and lost to `.clip-body img { float:none !important }` — the avatar never floated,
      so the deep-nested name/handle collapsed. Fixed the float `!important` + neutralised the inline
      flex-shrink/max-width constraints on the floated header's descendants, and taught `assertClipBodyHealth`
      to recognise the valid floated-avatar layout (name-beside-float) vs the crush (narrow name column).
      All 18 fixture-visual specs green; extension.spec + ext (153) + web (88) unit suites green.
