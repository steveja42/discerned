# Corpus-sweep capture-quality — handoff

Status snapshot for picking this up in a fresh context. The corpus sweep
(`tests/e2e/corpus-sweep.spec.ts`) captures the uncurated domains listed in
`tests/fixtures/corpus-domains.json` (195 as of 2026-07-30 — Phase 4.4 added
100 seeds; Phase 4.5 added 6 book/film/music review+catalogue entity pages),
scores each
clip with content-free heuristics, and writes 3 images/domain (source/clip/cast)
to `test-output/corpus-sweep-run/`. A human visual review lives in
`test-output/corpus-sweep-run/visual-findings.json` (the gallery sorts by it).

## PHASE 4.7 (2026-08-22) — re-swept all skipped/blocked/dead domains

Re-ran every domain that was skipped, error'd, or scored "ok" but was actually
a bot-block/dead-URL page (per `visual-findings.json`'s `blocked` verdicts) —
26 domains total, via `corpus-sweep-manual` (headed, warm Profile 3).

**19 domains recovered** (now captured + visually verified clean/flaw, not
just scored): reuters, bloomberg, reddit-thread, nytimes, forbes, venturebeat,
tripadvisor, zillow, producthunt, globeandmail, sec-edgar, courtlistener,
github-issue, mayoclinic, xda-forums, postguam, and (after the extension
deregistration below was fixed) ndtv. Two prior corpus-JSON replacement URLs
(venturebeat, github-issue) that had never actually been re-swept are now
confirmed captured cleanly. `sciencemag`'s URL is fixed-pending (see below).

**New defects found during visual verification** (composite score alone
missed both — same lesson as Phase 4.6's 7 false passes):
- **globeandmail — CRITICAL, new.** Headline/byline/dateline capture fine,
  but the entire article BODY is missing; clip jumps straight into
  "Tickers mentioned"/newsletter promos/SecureDrop chrome. Not previously
  documented for this domain. Needs investigation.
- **reuters — flex-collapse, same known pattern.** One paragraph renders
  one character per line (the `dx-stats`/flex-collapse signature, see
  memory `project_dx_stats_flex_collapse`). Adds to the existing list
  (thehindu/wikivoyage/engadget/zdnet/zenodo/rottentomatoes).
- **tripadvisor — cross-sell dominance.** Attraction page's own content is
  swamped by a long "Recommended experiences nearby" rail of unrelated
  tours, same class as the documented straitstimes commerce gap.
- **producthunt** flagged 1 distorted image by the scorer — not yet
  investigated further, capture otherwise reads fine.
- **xda-forums** — thin capture (OP post only, no replies visible); unclear
  if the thread genuinely has none or the tagger misses them.

**Two domains had DEAD corpus URLs** (404):
- `ndtv` — old URL 404'd. Found a live replacement
  (`/business-news/india-space-economy-...`) via a throwaway DOM-scrape probe
  against the real ndtv.com homepage (warm Profile 3). The new URL then hit a
  hard 30s/60s `__DISCERNED_TEST_CAPTURE` timeout on 3 attempts — root cause
  was NOT the site or the pipeline: the SAME throwaway discovery probe passed
  `clearSwCacheForRawDir: true` (copied from the established
  `corpus-sweep-manual.spec.ts` pattern) and was re-run several times while
  debugging its own unrelated failures, which deletes `Extension State` /
  `Extension Rules` dirs under Profile 3 — this silently deregistered
  Discerned from the profile with zero trace (not even a disabled record in
  `Secure Preferences`). 18 captures earlier in the SAME session had worked
  fine; the probe broke it partway through. User caught it (dev mode was off,
  extension missing), reinstalled from `dist-test`, and the exact same ndtv
  URL captured cleanly on the next attempt — full article, hero image, all
  sections. Fixed, verdict now `clean`. See memory
  `project_extension_silently_deregistered` — **do not pass
  `clearSwCacheForRawDir` from a throwaway probe**, especially not one being
  re-run repeatedly against a live persistent profile.
- `sciencemag` — old URL also 404'd. Could NOT find a replacement:
  **science.org hard-walled the warm profile** on every entry point tried
  (news hub, journal page, search, even the bare homepage), title stuck on
  "Just a moment..." through a full 60s headed wait with a human clicking.
  Four hits on the domain in a short window (partly from my own tooling
  mistakes — see "mistakes made" below) likely pushed it into the same
  Cloudflare cooldown documented for librarything/rateyourmusic in Phase 4.6.
  **Do not retry in a loop.** Leave for several hours, then one single headed
  attempt with a freshly-discovered article URL.

**5 domains remain genuinely blocked** (tried at both 90s and 150s wait,
still didn't clear passively): `medium-generic`, `discogs`, `openai-blog`,
`lemmy-thread`, `netflix-techblog`. These are hard bot/CF walls that don't
self-clear without real human interaction — user confirmed medium-generic
specifically. Left as `blocked` verdicts; no code fix applies.

**Rate-limited trio still cooling down**: `librarything`,
`librarything-catalog`, `rateyourmusic` — single non-looping attempt (60s
wait) 5 days after the Phase 4.6 cooldown started, still blocked. Needs
longer than 5 days, or the repeated attempts across sessions keep resetting
the clock. Leave alone.

**Mistakes made this session:**
- Ran a discovery probe against science.org **headless first** (no window
  for a human to clear CF), then gave up and deleted it instead of just
  switching to headed — wasted a hit on the domain for nothing.
- Forgot to raise the Playwright per-test timeout above the 30s default when
  writing a throwaway headed probe with a coded 60s wait — the process was
  killed at 30s, cutting off the human's in-progress click.
- Shell working directory silently drifted to `discerned-ext/` after an
  earlier `cd`, causing `pnpm exec` to intermittently no-op (`playwright not
  found`) on retries — always `cd /c/dev/discerned` (or verify `pwd`) before
  a Bash-tool Playwright invocation in this monorepo, don't trust persisted
  cwd across many tool calls in one turn.
- Net effect of the above three: 4 real/attempted hits on science.org in
  ~10 minutes, which is the same over-fast pattern that cooled down
  postguam and librarything/rateyourmusic in Phase 4.6. Pace single-domain
  probes against a known-fragile site deliberately, don't just retry blind.
- The SAME throwaway science.org probe also carried `clearSwCacheForRawDir:
  true`, copied uncritically from `corpus-sweep-manual.spec.ts`'s launch
  call without noticing it deletes `Extension State`/`Extension Rules`, not
  just an SW cache. Re-running it several times against the live persistent
  Profile 3 silently deregistered the hand-installed Discerned extension
  with zero trace — not a Cloudflare/site issue, not a different session.
  18 prior captures in this same session had worked fine; this broke it
  mid-run. Cost: a real "is this my fault" back-and-forth with the user
  before the mechanism was found by checking `Secure Preferences` directly
  and correlating capture timestamps against when the probe ran. See memory
  `project_extension_silently_deregistered`. Lesson: never copy
  `clearSwCacheForRawDir` into a new probe without reading what it deletes,
  and never re-run ANY launchWithExtension call repeatedly against a live
  persistent profile while debugging something unrelated (PATH glitches,
  timeout tuning) — each run is a fresh chance to corrupt shared state.

### Follow-up (same day) — 8 of the remaining 9 blocked domains recovered

After the extension-deregistration fix above, two things also changed before
the final push: (1) `launchExtension.ts` now strips `--no-sandbox` from
Playwright's own default arg list on the real-Chrome path too (it was
already never added explicitly, but Playwright injects it regardless,
triggering an "unsupported flag" banner the user saw) — see the
`ignoreDefaultArgs` block; (2) `clearServiceWorkerCache` now carries a loud
doc-comment warning about the `Extension State`/`Extension Rules` deletion
risk, without removing the option itself (6 established call sites rely on
it clearing genuinely-stale SW caches after a rebuild).

User then supplied fresh/working URLs for 9 of the 10 domains and confirmed
several had already cleared manually in the warm profile. A single,
non-repeated `corpus-sweep-manual` pass (90s wait, 10 domains) captured
**8 of 10** cleanly: medium-generic, discogs, openai-blog, lemmy-thread,
netflix-techblog, librarything, rateyourmusic — plus a NEW
`librarything-author` entry (kept separate from `librarything-catalog`
because the user's replacement URL was an author page, not a member catalog,
and `librarything-catalog`'s whole reason to exist is testing a documented
cross-frame capture defect that a different page shape wouldn't exercise;
that original URL was kept and re-verified the SAME defect still reproduces,
unrelated to the wall). **librarything + rateyourmusic's 2026-08-17
rate-limit cooldown has fully cleared** — both captured excellent, rich
entity pages (member reviews/ratings/lists/credits) on the first attempt.

Two didn't clear on that 10-domain automated pass: `sciencemag` and the new
`librarything-author`. Both were RE-TRIED individually, isolated from any
other same-domain hit, and both cleared cleanly first try —
`librarything-author` in particular had been the THIRD rapid
`librarything.com` request in ~90s in the batched run (after `librarything`
+ `librarything-catalog`), so the isolated retry points at request CADENCE
being the actual trigger, not a per-URL/per-path block. Both are now
`clean` with rich, complete captures (sciencemag: full article;
librarything-author: full author entity page — bio, works, tags, reviews,
lists, awards).

**All 10 of the originally-blocked/dead domains from this session are now
resolved.** Updated: `tests/fixtures/corpus-domains.json` (9 URLs
replaced/annotated + 1 new entry), `test-output/corpus-sweep-run/visual-findings.json`
(29 new/updated verdicts total across all passes this session),
`tests/e2e/helpers/launchExtension.ts` (sandbox-flag fix + deregistration
warning), gallery rebuilt.

**Lesson for future sweep runs against Cloudflare-protected domains:**
batching multiple URLs on the SAME domain back-to-back in one
`corpus-sweep-manual` run can trip a rate/cadence-based challenge even when
each individual URL would clear fine on its own — if a domain-batched run
shows one entry blocked after its siblings on the same domain cleared,
retry that one in ISOLATION (its own `SWEEP_MANUAL_ONLY` run, not bundled
with anything else on the same domain) before concluding the URL itself is
walled.

## PHASE 4.6 (2026-08-17) — full re-run + harness false-pass fixes + visual re-review COMPLETE

Triggered by a pre-ship regression check ("are we sure Rotten Tomatoes is still
fine before we ship?"). Short answer: no regressions found (198/205 domains
scored identically to the pre-session baseline), but the exercise found the
**scorer has been silently certifying block/dead pages as healthy captures**
seven separate times, plus two harness bugs that made the sweep undermine the
user's own manual gate-clearing. All of the below is committed except the
visual re-review, which is **now 100% done (185/185 clips + casts)** — see
"RESUME POINT" at the end of this section for the final tally and two new
findings the completion pass turned up.

### Harness fixes (all in `tests/e2e/corpus-sweep.spec.ts`, tsc-clean)

1. **`GATE_RE` (headed PerimeterX/Cloudflare gate-wait loop) matched only 1 of 8
   real wall texts.** It was written for PerimeterX's "press & hold" phrasing
   and never extended to Cloudflare's. Concretely: Zillow's wall says "press
   **AND** hold" (no ampersand) and LibraryThing's says "verif**ying** you are
   human" — neither matched the old `/press\s*&?\s*hold|.../i`. Effect: the
   loop exited in ~6s instead of waiting the intended ~3.5 minutes, the
   "please clear it in the window" prompt never printed, and **the sweep
   advanced while the user was still clicking the gate** (reported live by the
   user on both Zillow and LibraryThing). Fixed: `GATE_RE` now covers both
   wall families — verified 11/11 real wall texts match, 0 false positives on
   ordinary prose (two draft patterns, `verify your` and bare `just a moment`,
   were REJECTED because they matched real article text — kept the tighter
   `verif(y|ying)\s+(that\s+)?you\s+are` and anchored `^\s*just a moment`).
2. **The headed-retry pass never actually ran the gate-wait loop at all**,
   independent of bug #1. The loop is gated on a `ctxIsHeaded` boolean; the
   retry call site (`captureDomainDeadlined(headedCtx, d)`) omitted the `true`
   argument, so `ctxIsHeaded` was false in the ONE pass whose entire purpose is
   clearing walls in a real window. A CF wall fell straight to the interstitial
   detector and skipped in ~10s. **Both bugs had to be fixed together** — #1
   alone would have made no difference, since the loop it improves was not
   running. Confirmed fixed by watching the manual-clear prompt print live for
   the first time ever, on rateyourmusic.
3. **No per-domain timeout.** `captureDomain` was failure-isolated (every
   throw becomes a skip record) but not time-boxed — the only guard was the
   whole-test budget (~4.4h for a full run). Observed: storygraph loaded
   PERFECTLY (its source screenshot is a flawless book page, no gate) then
   wedged 23+ minutes downstream in capture/render/cast with zero artifact
   writes, blocking the rest of the headed-retry queue. Added
   `captureDomainDeadlined()` — `Promise.race` against a
   `SWEEP_DOMAIN_TIMEOUT_MS` (default 240s) that persists an honest
   `domain timeout` skip and lets the sweep move on.
4. **Whole-test timeout didn't budget for a possible headed retry per domain.**
   The old formula (`domains * 75s`) assumes headless steady-state cost; once
   fix #2 made the gate-wait loop actually run in the retry pass, a small
   `SWEEP_ONLY` run could need ~3.5 min/domain just for gate waits and got
   killed mid-run by the outer Playwright test timeout (observed: an 8-domain
   run got 720s total and died with `Test timeout of 720000ms exceeded`).
   Fixed: budget now includes `DOMAIN_TIMEOUT_MS` per domain
   (`domains * (75_000 + DOMAIN_TIMEOUT_MS)`).
5. **`clipShot.ts` threw a confusing raw `TypeError` instead of an honest skip**
   when a site tears down its own document mid-capture (observed on ebay: a
   bot-mitigation reload nulled `document.documentElement` between page-load
   and screenshot, surfacing as `Cannot read properties of null (reading
   'scrollHeight')` — reads like OUR bug, isn't). Fixed: optional-chain +
   `.catch(() => 0)`, falls back to a plain viewport screenshot.

### The interstitial/block-page detector — 7 confirmed false passes, all now fixed

The composite score has NO defense against a block/dead/rate-limited page that
renders as well-formed prose — it scores `ok` with a healthy composite because
there's nothing malformed about "Too Many Requests" as English text. Found by
visually checking `--2-clip.png` against `score.json` rather than trusting the
composite (this is now standard practice — see "the scorer lies" below).
Confirmed false passes, all now caught by the extended `CHALLENGE`/`HARD` lists
in `corpus-sweep.spec.ts`'s interstitial check:

| Domain | Scored | Was actually | Signature added |
|---|---|---|---|
| homedepot (old URL) | ok 0.002 | 403 on deep link → silently redirected to the bare **homepage** | new homepage-redirect detector (any entity/article URL landing on `/` with no query) |
| github-issue (old URL) | ok 0.051 | GitHub's 404 page | new dead-title detector (`404`, `not found`, `page not found`, …) |
| venturebeat (old URL) | ok 0.177 | "Not Found — Could not find requested resource" | same dead-title detector |
| postguam | ok 0.200 | "Too Many Requests" (WE caused it, sweeping too fast) | `too many requests`, `429 too many`, `rate limit exceeded` |
| bloomberg | ok 0.111 | "Why did this happen? … Block reference ID" | `block reference id`, `why did this happen` |
| reddit-thread | ok 0.076 @ 100% coverage | "**You've** been blocked by network security" (contraction missed `you have been blocked`) | `you've been blocked`, `blocked by network security` — **this one matters most: Reddit's hand-tuned tagger had never actually been exercised by the sweep** |
| sec-edgar | ok 0.053 @ 98.6% coverage | SEC.gov's "Your Request Originates from an Undeclared Automated Tool" — long, well-formed prose, so NO length gate could have caught it | `undeclared automated tool`, `declare your traffic` |

Dead corpus URLs were also replaced (not just detected): `github-issue` →
`microsoft/TypeScript#13297` (a long real comment thread, matching the entry's
"comment timeline" intent), `venturebeat` → a current `/orchestration/...`
article (the site moved off `/ai/...` URLs), `msn-slideshow` → a live
`/ss-AA28tMqG` Smithsonian gallery (kept the `/ss-` slideshow SHAPE on purpose —
this entry guards the PRELOADED-NEXT-ARTICLE regression from Phase 4.something,
and its own note warns a failure there scores healthy, so the replacement
was verified to show Smithsonian content, not a preloaded story).
`homedepot` was fixed with a user-supplied working product URL (Anvil claw
hammer) after an AI-agent attempt to find one via curl 403s incorrectly
concluded the whole domain was walled — see "mistakes made" below.

**librarything, librarything-catalog, rateyourmusic are RATE-LIMITED as of
2026-08-17 and need a real cooldown (hours) before re-attempting** — repeated
sweep runs against them during this session's harness-testing put them into a
Cloudflare "verifying you are human" state that would not clear even with a
human clicking, headed, with the gate-wait loop finally working correctly.
Noted directly in their `corpus-domains.json` entries. Do not loop-retry them.

### Pixel-baseline fixture-visual suite: 22 passed, 1 failed

**Trap for next time:** `pnpm exec playwright test <fixture-visual specs>` with
no env vars reports `23 skipped, exit code 0` — a FALSE GREEN. Every spec is
gated on its own flag. To actually run the gate:
```
BB_FIX=1 BCT=1 BLOG_FIX=1 BSKY_FIX=1 EMB_FIX=1 FB_FIX=1 GH_FIX=1 GR_FIX=1 \
HN_FIX=1 HN_TAG=1 MED_FIX=1 NEWS_FIX=1 PHPBB=1 PRIM_FIX=1 REDDIT_FIX=1 \
SHOW_FIX=1 SO_FIX=1 SUB_FIX=1 TWT_FIX=1 WIKI_FIX=1 XNEW_FIX=1 YT_FIX=1 YT_VC=1 \
pnpm exec playwright test -c tests/e2e/playwright.config.ts --workers=1 \
$(ls tests/e2e/*fixture-visual.spec.ts)
```
The one failure is `facebook-feed-fixture-visual` — the post-BODY assertion,
not the byline one. This is the SAME known-flawed area as the live
`facebook-home` finding below (same tagger, same commit `bdaac0e`), so it is
not a new regression, but it means the gate is currently red and will stay red
until `tagFacebook`'s feed branch is fixed. Diagnosed (do NOT re-derive): the
fixture's "Facebook x22" placeholder noise and raw image-URL-as-text are
FIXTURE ARTIFACTS (offline load, no external stylesheet, no image fetch) —
NOT proof the `aria-hidden` zero-area filter is broken; that filter's target
spans are not even inside `aria-hidden` wrappers. The missing post BODY is the
real, non-artifactual failure: the fixture genuinely contains it
("Give platelets", "special day for our beautiful") and both `FB_MSG_SEL`
markers are present, so `tagFacebook`'s feed branch has everything it needs
and still drops the body. Do not "fix" by loosening the aria-hidden filter.

### `facebook-home` (live) — confirmed pre-existing, NOT a regression

User-confirmed known-flawed area. Root cause (do not re-derive): `FB_BYLINE_SEL`
in `capture.ts` requires a heading/`<strong>`-wrapped byline anchor, but the
live feed serves a PLAIN `a[role="link"]` profile anchor with no such wrapper —
so the ancestor climb never acquires a byline and falls to the header-less
`if (!post) post = body.parentElement ?? body` fallback, which the code's own
comment admits captures the post "just without its header." The PERMALINK
branch of the same `tagFacebook` function already solved this exact problem by
matching bylines BY SHAPE instead of by tag — the fix is porting that matcher
to the feed branch. (An earlier working hypothesis in this session — "the old
capture was richer, so this is a regression" — was WRONG and retracted: a
surviving pre-tagger screenshot showed the OLD capture was also header-less
AND truncated mid-sentence, so the new tagger is strictly better on text
completeness, just still missing the header/avatar/photo.)

### The composite score is unreliable in BOTH directions — treat it as sort order only

Beyond the 7 false passes above, confirmed by eyeball against source screenshots:
- **Low coverage ≠ bad clip**: `substack-generic` (2.3% coverage) and
  `gutenberg` (1.4%) are both COMPLETE, EXCELLENT captures — the denominator
  is inflated by a long comment thread / an entire novel in one HTML file,
  not by dropped content. Same for `walmart`'s 66%→21% swing between two runs
  (source rendered more chrome; the clip was excellent both times).
- **High coverage ≠ chrome leak**: `appstore` (105%), `lesswrong` (121%),
  `danluu`/`w3c-spec` (100%) are all clean — the >100% figure is a known
  measurement artifact (clip legitimately holds more text than the throttled
  live DOM measured).
- Two counter-examples worth keeping: `pubmed` and `musicbrainz` are
  STRUCTURED ENTITY pages that captured perfectly (full author lists / full
  discography tables) — proof the imdb-name/spotify-album/ytmusic-album
  image-only failures are a tagger/pipeline gap, not something inherent to
  entity pages in general.

### Real capture defects found (all pre-existing unless noted; NOT ship-blocking on their own)

- **Flex-collapse / narrow-column text (6 sites and counting — a PATTERN, not
  isolated):** rottentomatoes (was affected, now fixed — this is what
  triggered the whole re-review), wikivoyage (climate table → 1 char/line),
  engadget (product spec blocks → 1 word/line), zdnet (a mid-article column),
  zenodo (citation-table year column wraps "2018"→"201"/"8"), **thehindu is
  the cleanest repro** (a related-article link renders literally one
  character-ish token per line down a vertical strip). This is the
  `dx-stats`/flex-collapse signature documented in memory
  `project_dx_stats_flex_collapse` — worth running `clip-width-probe` against
  thehindu rather than guessing further.
- **Image-only / text-dropped entity pages (4 sites, same signature):**
  imdb-name (headshot only), spotify-album + ytmusic-album (cover art only),
  ebay (BLANK — nothing at all, worst clip in the corpus, 443-byte PNG).
- **Hero-only capture — the OLD memory-documented class is FIXED**: npr,
  arstechnica, aljazeera, css-tricks, github-blog, wired now all capture full
  bodies (71–87% coverage). BUT japantimes is a NEW instance of the same
  symptom (hero image + caption only, ~20 paragraphs of visible non-paywalled
  text dropped) that the existing fix does not cover.
- **Comment-thread-outscores-story, on a PAYWALLED page:** haaretz — same
  shape as the AP News fix (RESOLVED 2026-07-24 section above), but here the
  story is ALSO paywalled, so run `hidden-prose-probe` before concluding
  anything (per memory `project_low_coverage_paywall_vs_finder` — two guessed
  fixes were wrong before on this exact ambiguity).
- **Vertical-stacking engagement counts (3 social captures):** instagram-home,
  instagram-reels, facebook-reels all stack like/comment/share counts one
  per line instead of a horizontal row (distinct from the flex-collapse
  pattern above — likely a different CSS selector gap).
- **Cast-only defects (clip fine, kind-30023 markdown is not):** youtube-watch's
  clean "1.8B views · 16 years ago" `dx-stats` row degrades to a bare "1.8B" in
  the cast — word "views" AND the date both lost in `htmlToMarkdown`.
- **Missing headline/byline on an otherwise-complete body (3 sites):** cnn,
  time, and (during ads) espn all open mid-article with no headline/byline —
  worth checking whether these share a cause.
- **Audio-widget remover has gaps (2 sites):** aws-blog's "Voiced by Amazon
  Polly" banner and thenation's audio-player control strip both survive —
  CLAUDE.md documents this remover already exists (`[data-mp3u]`,
  `Amplitude`, `Polly` id-matching); these two evaded it.
- **Material Symbols ligature-name leak (new class, 1 site):** playstore
  renders literal icon font ligature names (`chevron_right`, `arrow_forward`,
  `expand_more`) as visible text — the icon font isn't loading/rendering, so
  the fallback text (the ligature name itself) shows through. Also on
  playstore: page ORDER is wrong (app header renders at the very BOTTOM
  instead of the top).
- **Ad selection, not a capture bug:** instagram-home's tagger narrowing works
  correctly but picked an advertisement as "the" post — no ad-filter exists in
  `pickVisibleFeedPost`.
- **Commerce cross-sell gap:** straitstimes has a shopping-product rail with
  prices surviving at the end — `removeCrossSellRails`'s heading regex list
  doesn't cover it.
- Numerous **minor chrome-leak-only flaws** (residual ad labels, newsletter
  blocks, recirculation boxes, preferred-source badges) on otherwise-excellent
  captures: cnbc, allrecipes, timesofindia, yahoofinance, noahpinion,
  newyorker, postgresql-docs, smh, dev-to, aljazeera, aljazeera-tech, wired,
  boardgamegeek, npr, simonwillison, straitstimes, lefigaro, zdnet. Not worth
  individual write-ups here — see `visual-findings.json` per-domain notes.
- **Unresolved, needs the hidden-prose-probe before any fix:** folha (body
  entirely absent, 5.2% coverage — Folha is paywalled so this MAY be faithful).

### Mistakes made this session (so the next pass doesn't repeat them)

- Concluded "homedepot has no usable URL — domain-wide CDN block" from 4 curl
  403s (including the bare homepage) despite having ALREADY WRITTEN that curl
  403s prove nothing (no `cf_clearance`) and despite the real browser loading
  the site fine. **Wrong** — the user supplied a working product URL on the
  first try. Lesson: to test whether a URL works for the sweep, test it
  headed in the sweep's own warm profile, not curl/WebFetch (both share a bot
  fingerprint).
- Inferred "the old facebook-home capture was richer" from a single scorer
  field (`aspectDistorted: 1`) without looking at the actual old image first.
  Wrong — a surviving pre-tagger screenshot proved the old capture was
  equally header-less AND truncated. Corrected once challenged; the lesson
  generalizes the letterboxd note in memory `project_low_coverage_paywall_vs_finder`-
  adjacent territory: an image beats an inferred proxy metric every time.
- Nearly recorded a `visual-findings.json` verdict as clean via an unread
  placeholder note ("PLACEHOLDER - pending review") for `sec-edgar` before
  actually opening the image — the image turned out to be a bot-block page.
  Caught before it shipped, but it was a live near-miss. New rule adopted
  mid-session: never write a verdict before reading the corresponding image.
- Two test scripts written via shell heredocs silently had their `\s` escapes
  eaten, producing a run of BOGUS regex-validation failures that looked like
  the `GATE_RE` fix hadn't worked. Resolved by extracting the regex straight
  out of the committed spec file and testing THAT, rather than a hand-retyped
  copy — same principle as verifying against real files instead of memory.

### RESUME POINT — visual re-review is 100% DONE (2026-08-17)

Every verdict in `visual-findings.json` is a human/AI eyeball judgment against
the ACTUAL rendered `--2-clip.png` and `--3-cast.png` — NOT the composite
score, which this session repeatedly proved unreliable in both directions. A
verdict written during this session's re-review has its `note` field end with
(or contain) `Verified 2026-08-17` — that is the marker distinguishing a
re-verified entry from a stale pre-2026-08-17 one still sitting in the file
from an earlier pass.

**Final: all 185/185 scored clips + casts re-verified.** Split across five
parallel review passes (spiegel + 9to5mac done directly; the remaining 105
domains split into five ~21-domain batches, each independently eyeballing
every clip against its source and every cast against its clip, merged into
`visual-findings.json`). Final tally across the 198 total entries in the file
(185 from this pass + 13 pre-existing, unrelated to this batch — see below):
**93 clean / 82 flaw / 23 critical.** Gallery rebuilt:
`node tests/e2e/tools/sweep-gallery.mjs` → `test-output/corpus-sweep-run/sweep-gallery.html`.

**13 entries remain unstamped (pre-2026-08-17), intentionally out of scope for
this pass:** nytimes, reuters, medium-generic, forbes, discogs, tripadvisor,
zillow, producthunt, netflix-techblog, lemmy-thread, librarything,
rateyourmusic, librarything-catalog. Several of these are the domains this
handoff already documents as needing the manual headed pass (§ "Which sites
need HEADED runs") or are in the librarything/rateyourmusic rate-limit
cooldown noted above — re-verify them once re-captured, not before.

**Two new defects found during the completion pass, not previously
documented, both worth a fix:**
- **`theregister` cast — literal `###` markdown-heading syntax leaks as plain
  text inside list items.** The "MORE CONTEXT" bulleted list renders items
  like `### OpenAI won't let some customers export their chats, but this tool
  will` with the hashes visible, instead of the heading syntax being
  escaped/stripped by `htmlToMarkdown` when it appears inside a list-item's
  inline text (the source these came from are `<h3>`-in-`<li>`-flavored link
  cards). Same root family as the already-known `github-pr` /
  `hackaday` / `myanimelist` cast-only markdown-conversion defects below.
- **`target` clip — commerce entity page drops the entire product-identity
  block.** Clip starts directly with marketing/spec images (no title, no
  price, no star rating, no hero product photo), same class of defect as the
  documented `imdb-name`/`spotify-album`/`ytmusic-album`/`ebay` image-only
  entity-page failures, but inverted: this one keeps SOME text (highlights,
  specs, cross-sell rails) while dropping the identity header specifically.

**Recurring pattern confirmed at scale (23 critical findings total,
up from 13 pre-session):** the cast-only `htmlToMarkdown` table/structure
mangling seen on `github-pr` recurs independently on `myanimelist` (entity
table explodes into narrow-column garbage) and `hackaday` (shell `#` comments
misread as markdown headers, producing giant fake section titles) — three
independent domains hitting the same conversion-layer bug class. Worth a
dedicated fix pass on `htmlToMarkdown` / `deriveLongFormMarkdown` before the
next full sweep, rather than chasing each site individually.

To re-run this kind of review from scratch: read each
`test-output/corpus-sweep-run/{domain}--2-clip.png` (and `--3-cast.png`)
against `{domain}--1-source.png`, then record the verdict directly into
`visual-findings.json` under `.findings.{domain} = {verdict, where, note}`
(verdict ∈ clean/flaw/critical/blocked). After finishing, rebuild the gallery:
`node tests/e2e/tools/sweep-gallery.mjs`.

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
