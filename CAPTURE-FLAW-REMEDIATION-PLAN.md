# Capture flaw remediation plan

Derived from the 2026-09-15 corpus sweep (206 domains, 185 captured, all reviewed).
Source data: `test-output/corpus-sweep-run/visual-findings.json`,
gallery at `test-output/corpus-sweep-run/sweep-gallery.html`.

**Sequencing principle:** phases are ordered by *blast radius*, not by difficulty.
A fix confined to one selector is safe at any time; a fix inside
`htmlToMarkdown` or the layout finder touches every one of the 206 captures.
Do not batch across phases — each phase ends with a verification gate that must
pass before the next begins.

## Status

A phase is **Done** only once its own Gate line has passed — not when the code
change lands. Mark the sub-item first, the phase second.

| Phase | Scope | Blast radius | Status |
|---|---|---|---|
| 0 | Cast-side pixel baselines | — (blocking) | ☐ Not started |
| 1 | Low-risk narrow fixes (1a-1e) | low | ☐ Not started |
| 2 | Cast whitespace corruption | **high** | ☐ Not started |
| 3 | Grey-pill link mangling | medium | ☐ Not started |
| 4 | Recirculation blocks | medium | ☐ Not started |
| 5 | Structural (5a-5c) | **highest** | ☐ Not started |
| 6 | Low-risk cosmetic (6a-6c) | low | ☐ Not started |

Phase 6 is independent of 0-5 and may be done at any time. Everything else
follows the stated order.

---

## Phase 0 — Build cast-side pixel baselines (BLOCKING)

**Nothing in Phases 2-4 should start before this lands.**

Today all 29 `*-fixture-visual.spec.ts` baselines screenshot `.clip-body`.
There is **no automated guard on the cast at all** — verified: `castShotSafe` /
`renderCast` appear only in *live* opt-in specs, and no `*-snapshots/` directory
contains a cast image. Roughly 30 of the flaws below are cast-only, so a
regression there would leave every existing test green.

The machinery already exists and drives production code — no new harness:
- `tests/e2e/helpers/castFromCapture.ts` (`buildCastTemplates`, via the real
  `__DISCERNED_TEST_CAST` bridge → real `deriveLongFormMarkdown` + `BUILD_CAST`)
- `tests/e2e/helpers/renderCast.ts` (mocked-relay `/discerns` render)
- `tests/e2e/helpers/castShot.ts`

**Task:** add `*-cast-fixture-visual.spec.ts` with `toHaveScreenshot()` baselines
for offline fixtures, driven the same way `runFixtureVisual` drives clips.

Minimum set (chosen to cover each cast failure mode):
| Fixture | Guards |
|---|---|
| a code-heavy page with token-span highlighting | whitespace padding |
| a news article with several inline links | grey-pill link mangling |
| a page with `**bold**` headings | literal markdown leakage |
| a plain-prose essay | paragraph-separation loss |

Existing fixtures under `tests/fixtures/sites/` may cover some of these; prefer
reusing one over snapshotting a new site. None of the whitespace-affected docs
sites (mdn, pypi, crates-io, kubernetes-docs) currently has a fixture, so at
least one new snapshot is likely needed.

**Gate:** new cast baselines committed and green; existing 29 clip baselines
still green.

- [ ] **Phase 0 done** (gate passed)

---

## Phase 1 — Low-risk, narrowly scoped fixes

Additive or single-selector. A mistake surfaces immediately in the clip
baselines. Safe to do as one batch.

### 1a. Oversized promoted og:image — 4 confirmed, up to 20 at risk
Confirmed: `postgresql-docs` (~450px) `gitlab-repo` (~350px)
`courtlistener` (~280px) `mayoclinic` (~260px) `tildes` (~150px)

**Cause (verified):** `withThumbnailFallback` (capture.ts) promotes the declared
`og:image` into the body when the capture has no hero. That `<img>` is
synthesised, never walked by `annotateLiveImageSizes` (~line 7879), so it
carries **no `width` attribute** — and the CSS cap at
`discerned-web/app/globals.css` ~1439
(`max-width: min(100%, attr(width px, 100%))`) falls back to 100%.

**Do:** stamp width/height on the synthesised `<img>` so the existing cap
engages. One change, purely additive.

**Do NOT** change *whether* to promote in this phase. Promotion exists for the
MSN syndication case — see `discerned-ext/CLAUDE.md`, "A CROSS-HOST canonical is
syndication, not staleness"; misfiring cost bodyHtml 2,265 → 177,294 chars.
`msn-slideshow` in this sweep is the working case. Promotion *policy* (should a
site's own logo or a 1200x630 OG card be promoted at all?) is a separate
judgement — see Phase 5.

**Scope check:** 20 domains have an unstamped first image; only 5 were eyeballed.
Full list in the sweep notes — the three kinds are site logos (tildes,
postgresql-docs, gitlab-repo, npmjs, signalvnoise, kaggle, ytmusic-album,
lastfm), purpose-built OG cards (courtlistener, mayoclinic, crates-io,
stripe-docs, python-docs, overreacted, meduza) and **genuine article art**
(fortune, folha, nature, lesswrong) where promotion is correct and only the size
is wrong.

- [ ] 1a done

### 1b. Icon ligature names as text — `kaggle`, `playstore`
Material Icons ligature text (`chevron_right`, `file_download`,
`keyboard_arrow_down`) rendering literally. Both are Google properties; App
Store and Docker Hub use SVG icons and are unaffected. Hide/strip text for known
icon-font class names.

- [ ] 1b done

### 1c. Audio narration widgets — `reason`, `smh`, `nbcnews`
"Listen to this article" strips surviving. The existing pass targets
Polly/Amplitude vendor classes; these use different markup. `lefigaro` is
already **fixed** — use it as the working reference.

- [ ] 1c done

### 1d. Video transport strips — `cbsnews`, `zdnet`, `nypost`, `tiktok-foryou`
Timecode/control bars (`00:00 04:15`) leaking as body text. `CLAUDE.md` already
documents the apnews transport-bar removal; extend it.

- [ ] 1d done

### 1e. Newsletter / subscription blocks — `chicagotribune`, `newyorker`, `thenation`, `noahpinion`, `straitstimes`
Widen `NEWSLETTER_RE`. `chicagotribune` is the severe case: the block does not
merely interrupt, it **replaces** the body (17% coverage).

- [ ] 1e done

**Gate:** 29 clip baselines + new cast baselines green; `pnpm test` green;
`SWEEP_ONLY=<the ~14 affected domains>` re-sweep reviewed by eye.

- [ ] **Phase 1 done** (gate passed)

---

## Phase 2 — Cast whitespace corruption (highest value, highest risk)

**~20 sites.** Do this **alone**, after Phase 0.

`mdn` `python-docs` `reactdev` `github-pr` `github-repo` `github-issue` `pypi`
`crates-io` `kubernetes-docs` `npmjs` `go-docs` `wiktionary` `dockerhub`
`reuters` `cnbc` `usatoday` `chosun` `seattletimes` `weather-gov` `vox`

**One bug, three faces** — spaces inserted at inline element boundaries, or lost
where separators should be:
- padded: `r . json ()`, `use serde :: { Deserialize , Serialize };`, `( nonstandard )`
- stripped: `python-mpipinstallrequests`, `BellevueCIDDowntownMagnuson`
- separators lost between numbers: `20263:09 AM`, `21~28도` → `2128도`

**Evidence the cause is element boundaries, not "code":**
- `kubernetes-docs`: on ONE page, highlighted YAML is destroyed
  (`apiVersion : v1 kind : Pod`, flattened to one line) while a plain shell block
  beside it is perfect. **Use this as the primary test case.**
- `crates-io`: Rust padded throughout, but string literals (single text nodes)
  are correct.
- `github-issue`: highlighted block mangled; the identical call in prose two
  lines below is fine.
- `wiktionary`: same padding in plain prose — so it is not code-specific.
- Clean counter-examples: `postgresql-docs` (ASCII tables with pipe alignment
  intact), `stackoverflow-q`, `superuser`, `jvns`, `hackaday`, `css-tricks`.

**Prime suspect:** `applyFlexSeparation` inserting a space between element
children (`FLEXSEP_MARKER`, stamped by `annotateLiveImageSizes`). It exists to
fix run-together text — "399M views21 years ago" — so **narrowing it risks
reintroducing that**. Add a guard for that case before touching it.

**Warning:** the bug runs in BOTH directions (`pypi` shows add and strip on one
page). A naive "stop adding spaces" fix will not address the stripping half and
may worsen it.

**Gate:** cast baselines green; `SWEEP_ONLY` re-sweep of all ~20 plus the six
clean counter-examples above, every one reviewed by eye.

- [ ] **Phase 2 done** (gate passed)

---

## Phase 3 — Grey-pill link mangling (8 sites, cast only)

`bbc-news` `theguardian` `theatlantic` `techcrunch` `kotaku` `huffpost`
`theregister` `signalvnoise`

Link text split into two grey pill boxes with an arrow glyph slicing through it:
`Tru`▸`said`, `sat down to tal`▸`th David Senra`. **Selective** — neighbouring
links in the same paragraph render correctly, so a specific link property
triggers it. `signalvnoise` has six on one page.

**Sequence after Phase 2 deliberately:** this may share the whitespace root
cause (both are inline-boundary damage in `htmlToMarkdown`). Re-check these 8
*after* Phase 2 lands — some may already be fixed, and if not, the remaining
signal is cleaner.

**Gate:** cast baselines green; re-sweep the 8.

- [ ] **Phase 3 done** (gate passed)

---

## Phase 4 — Recirculation blocks not stopping (12 sites)

`economist` `globeandmail` `japantimes` `msnbc` `newsweek` `time` `scmp` `npr`
`axios` `chosun` `genius` `thedailybeast`

Content continuing past the article's end: "More from Science & technology",
"Interact with The Globe", KEYWORDS tails, promo rails.

Widening `STRONG_RELATED_RE` / `RELATED_HEADING_RE` **risks eating real
content**. The existing guards (bail if the container holds a ≥200-char `<p>`;
weak headings additionally require ≥60% link text) exist because an over-eager
rule removed article bodies. See `project_recirculation_heading_gap` in memory —
5 of 6 real headings currently unmatched.

**Gate:** full 29 clip baselines; re-sweep the 12 **plus** a sample of
long-article domains to confirm no body truncation.

- [ ] **Phase 4 done** (gate passed)

---

## Phase 5 — Structural / high blast radius (defer; one at a time)

Do not start until Phases 1-4 are stable. Each of these can regress the whole
corpus.

### 5a. Missing headline / title — 13 sites
`cnn` `fortune` `newsweek` `gizmodo` `zdnet` `pcmag` `motherjones` `huffpost`
`ndtv` `msn-slideshow` `thedailybeast` `sciencemag` `rottentomatoes`
`goodreads-author`

Touches the **layout finder** — the most load-bearing component, and the source
of every "hero-only capture" and "wrong block picked" defect in memory. Use
`tools/finder-diag-probe.spec.ts` to establish *why* the headline is excluded
before changing selection logic.

- [ ] 5a done

### 5b. Column / ribbon collapse — 7 sites
`msnbc` `myanimelist` `newsweek` `scmp` `steam` `zenodo` `lastfm`

CSS in `globals.css` affecting all 206 clips. `project_dx_stats_flex_collapse`
records `.dx-stats` flex collapsing comment threads — a regression from exactly
this kind of change. Diagnose offline with `tools/clip-width-probe.spec.ts`
(works from a saved HTML file, no live site needed).

- [ ] 5b done

### 5c. og:image promotion *policy* (the judgement half of 1a)
Should a site's own logo or a purpose-built 1200x630 OG card be promoted at all?
Distinguishable by intrinsic aspect/size, and often by URL (brittle). Weigh
against the MSN syndication case.

- [ ] 5c done

**Gate:** each sub-item separately — full 29 clip baselines + cast baselines
green, `pnpm test` green, and a re-sweep of the affected domains **plus** a
sample of unaffected ones (these touch shared code, so the unaffected sample is
the point).

- [ ] **Phase 5 done** (all sub-items, each gated separately)

---

## Phase 6 — Low-risk cosmetic defects

Independent of Phases 1-5 and of each other; no shared blast radius. Can be done
in any order, or folded into another phase's batch — but tracked here so each
can be marked done cleanly.

### 6a. Literal markdown leaking — 6 sites
`aws-blog` `time` `smashingmagazine` `simonwillison` `kaggle` `lemmy-thread`

`**bold**` and `![img](url)` rendering as visible text. Cast-side; the markdown
conversion is emitting syntax the renderer then shows literally.

- [ ] Fixed
- [ ] Re-swept + reviewed

### 6b. Unlabelled stat runs — 6 sites
`spotify-album` `producthunt` `imdb` `imdb-name` `tiktok-foryou` `genius`

Structured lists reduced to bare numbers. `spotify-album` is the severe case —
the whole tracklist becomes `1 · 1`, `2 · 2`. Related: the YouTube odometer
rebuild in `discerned-ext/CLAUDE.md` solved the same shape of problem.

- [ ] Fixed
- [ ] Re-swept + reviewed

### 6c. Broken-image placeholders — 6 sites claimed, 0 reproduced
`instagram-home` `instagram-reels` `goodreads-book` `biorxiv` `ndtv`
`sciencemag`

**DIAGNOSE BEFORE FIXING — the recorded cause is wrong.** The verdicts say
"CDN URLs expiring during inlining", but measured on the captured HTML
(2026-09-15) that does not hold:

| domain | imgs | not inlined | decode-fails on render |
|---|---|---|---|
| `instagram-home` | 7 | **0** | 0 |
| `instagram-reels` | 2 | **0** | 0 |
| `goodreads-book` | 114 | 54 | 0 |
| `biorxiv` | 2 | 1 | 0 |
| `ndtv` | 2 | **0** | 0 |
| `sciencemag` | — | — | no `--clip.html` on disk |

Both Instagram clips — called "the consistent pair" — have **every** image
inlined as base64 and every one decodes (real `naturalWidth`). Nothing can
expire. `goodreads-book`'s 54 hotlinked images still resolve, and it is already
verdicted `clean`.

Two candidate explanations, neither yet confirmed:
1. **Review artifact.** A hotlinked image shows as broken in a renderer with no
   network — which is the state during review, not during use. That would make
   this a reviewing-harness defect, not a capture defect.
2. **Mistaken for a squashed avatar.** `instagram-home` renders a 150x150
   avatar into a 24x44 box; a distorted circle reads as a broken placeholder at
   a glance. If so the real defect is aspect ratio, and it belongs with 5b.

**Do:** reproduce first. Render each clip with network disabled and compare
against network enabled; if nothing breaks in either, re-review the images and
correct the verdicts rather than changing capture code. Only `biorxiv`'s
un-inlined logo is a genuine durability gap, and it is one image on one site.

- [ ] Reproduced (or verdicts corrected as a review artifact)
- [ ] Fixed
- [ ] Re-swept + reviewed

**Gate:** 29 clip baselines + cast baselines green; `pnpm test` green;
`SWEEP_ONLY=<affected domains>` re-sweep reviewed by eye.

- [ ] **Phase 6 done** (gate passed)

---

## Standing rules for every phase

1. **Visually verify before reporting done.** Type-check and unit tests miss
   "wrong element picked". Read the rendered PNG.
   (`feedback_visually_verify_after_refactor`)
2. **Never mark a verdict `regression: "regressed"`** without opening the
   BASELINE image and confirming the defect is absent there. A stricter
   re-review is not a regression. Byte deltas prove nothing — the 14 false
   positives in this sweep spanned 0.11%-12.93%.
   (`feedback_regressed_needs_baseline_image`)
3. **`regression`/`regressedFrom` are settable only via
   `record-verdict.mjs --batch`** — on the positional form they are silently
   swallowed into the note text.
4. **Re-run `node tests/e2e/tools/sweep-gallery.mjs`** after editing verdicts;
   the gallery computes its own tiers.
5. **Never run `prune-stale-findings.mjs` right after a full sweep** — it
   compares against baseline images and would delete every fresh verdict
   (measured: it offered to delete 176 of 206).
6. **Check the source screenshot** (`<domain>--1-source.png`) before claiming
   something is missing. `hackernews` was marked down for an absent post header;
   the URL was a comment permalink that never had one.
7. **Review for PROPORTION, not just presence.** Two independent model reviews
   both rated `postgresql-docs` and `tildes` clean because the content was all
   there — neither asked whether an element was the right *size*. A human caught
   it by eye.
