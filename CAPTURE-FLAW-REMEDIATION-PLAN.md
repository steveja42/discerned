# Capture flaw remediation plan

Derived from the 2026-09-15 corpus sweep (206 domains, 206 captured, all reviewed).
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
| 0 | Cast-side pixel baselines | — (blocking) | ☑ **Done** (gate passed 2026-09-15) |
| 1 | Low-risk narrow fixes (1a-1e) | low | ☑ **Done** (gate passed 2026-09-16; 1a reassigned to 5c) |
| 2 | Cast whitespace corruption | **high** | ☑ **Done** (gate passed 2026-09-16) |
| 3 | Grey-pill link mangling | medium | ☑ **Done** (gate passed 2026-09-16) |
| 4 | Recirculation blocks | medium | ☑ **Done** (gate passed 2026-09-16) |
| 5 | Structural (5a-5c) | **highest** | ☑ **Done** (each sub-item gated separately, 2026-09-16) |
| 6 | Low-risk cosmetic (6a-6c) | low | ☑ **Done** (gate passed 2026-09-16; 6c diagnosed — no capture fix warranted) |

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

### What landed (2026-09-15)

`tests/e2e/helpers/castFixtureVisual.ts` — the cast-side twin of
`fixtureVisual.ts`. Production path end to end: fixture →
`__DISCERNED_TEST_CAPTURE` → `__DISCERNED_TEST_CAST` (real
`deriveLongFormMarkdown` + `buildCastTemplates`) → sign with a throwaway key →
`/discerns` via a mocked relay. Only the key and the relay are fakes.
`renderCast.ts` gained `withRenderedCast` (yields the settled page + locator, so
`toHaveScreenshot` can drive it); `renderCastAndScreenshot` now shares that same
`openCast` path, so the live artifacts and the baselines cannot drift.

Three projects, all gated on `CAST_FIX=1`:

| Spec | Fixture | Covers |
|---|---|---|
| `highlighted-code-cast-fixture-visual` | `highlighted-code-docs.html` (new) | whitespace padding (Phase 2) |
| `linked-prose-cast-fixture-visual` | `linked-prose-article.html` (new) | inline links, `**bold**`, paragraph separation |
| `substack-essay-cast-fixture-visual` | `substack-essay.html` (reused) | plain-prose control |

**`knownBroken`.** A fixture may reproduce a defect deliberately, and its
baseline then records the BROKEN render — otherwise the fix has nothing to be
compared against. Strings listed there are reported, not failed; a string that
DISAPPEARS fails the spec, telling you to move it to `castMustNotContain` and
refresh the baseline. Without this a known-broken fixture is either permanently
red (and ignored) or silent about its own fix.

### Findings that change later phases

1. **Phase 2's cause is identified.** `separateInlineFacets`
   (`discerned-ext/src/content/html-to-markdown.ts` ~387) has `SPAN` and `CODE`
   in `INLINE_FACET_TAGS`, so it inserts a space at EVERY token boundary of a
   syntax-highlighted block. The new fixture reproduces all four sweep shapes
   verbatim — `apiVersion : v1`, `r . json ( )`,
   `use serde :: { Deserialize , Serialize } ;`, and `( nonstandard )` in PROSE —
   while the plain shell block beside them (`kubectl apply -f pod.yaml`) is
   untouched. That pairing is the kubernetes-docs evidence, now offline and
   reproducible in ~7s. It exists to unglue Bluesky facets, so narrowing it must
   keep `bsky-thread` working.
2. **The `\n`-flattening half is NOT reproduced.** Newlines survive in this
   fixture, so "flattened to one line" is a separate mechanism still needing a
   live case.
3. **Phase 3's CSS suspect is ruled out for casts.** `.clip-body a:has(img) + a`
   / `~ a:nth-of-type(3)` (`globals.css` ~1792) cannot be the grey pill in a
   cast: casts drop inlined images, so `:has(img)` never matches. Reproducing
   the pill still needs one of the 8 affected sites.

**Gate:** PASSED. 3 cast baselines green; all 29 clip baselines green
(run one project at a time — see below); `pnpm test` green (34 ext + 17 web).

> **Run fixture-visuals ONE AT A TIME.** They share the single Next dev server
> on :3000 (`reuseExistingServer`), so a batched run's pass/fail mix measures
> contention, not the code. Measured here: `breitbart-fixture-visual` produced
> 4/4, then 1/3, then 5/8 across interleaved batches and passed cleanly every
> time it was run alone. Do not read a batch failure as a regression.

- [x] **Phase 0 done** (gate passed)

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

**DONE, but it fixed nothing — the stated cause is wrong (measured 2026-09-16).**
The stamp lands: a live tildes capture emits
`<figure><img … width="144" height="144">`, `width` is in `ALLOWED_ATTRS_PER_TAG`
for `img`, `inlineAllImages` preserves it, and Chromium supports
`attr(width px)` (a stamped 144px image renders at exactly 144px in the real
`.clip-body` stylesheet). Every link verified individually.

But the cap was **already engaging**. Measured painted width of the promoted
image, before vs after, in the re-swept clips:

| domain | before | after | column |
|---|---|---|---|
| `tildes` | 209px | 209px | 610px |
| `postgresql-docs` | 471px | 471px | 610px |
| `gitlab-repo` | 429px | 429px | 610px |
| `courtlistener` | 543px | 543px | 609px |

None was ever stretched to 100%. The plan's own figures (~450px, ~350px) say the
same thing in hindsight: these are images that are **too big to be tasteful**,
not images that lost their cap. So the defect is *how large a promoted logo/OG
card should render*, which is promotion **policy** — Phase 5c, not 1a.

The stamp is kept: it is correct, additive, costs one probe only when
`isDeclaredThumbnail()` holds, and makes the cap explicit rather than incidental.
It is simply not the fix for these five domains.

**Do not re-attempt 1a as a stamping change.** Measure the painted width first
(`PIL`, widest inked row in the top 500px — and skip y=0, a full-width rule there
reads as 609px and looks like a 100% stretch when nothing is stretched).

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

- [ ] 1a done — **moved to Phase 5c**; the stamp landed but was never the defect (above)

### 1b. Icon ligature names as text — `kaggle`, `playstore`
Material Icons ligature text (`chevron_right`, `file_download`,
`keyboard_arrow_down`) rendering literally. Both are Google properties; App
Store and Docker Hub use SVG icons and are unaffected. Hide/strip text for known
icon-font class names.

Done via `ICON_LIGATURE_RE` + a leaf-element pass in `removeGenericChrome`.
The shape alone is **not** safe to match: the corpus has `static_cast`,
`serde_json`, `from_str`, `torsten_dev` and wikidata's `zh_min_nan` /
`be_x_old` in the identical leaf form. Keyed on an affordance-word vocabulary
plus a `code`/`pre` ancestor exclusion — 34/34 real ligatures, 0 false
positives over 206 domains. Re-swept: `kaggle` -282px, `playstore` -190px,
`wikidata` byte-identical.

- [x] 1b done

### 1c. Audio narration widgets — `reason`, `smh`, `nbcnews`
"Listen to this article" strips surviving. The existing pass targets
Polly/Amplitude vendor classes; these use different markup. ~~`lefigaro` is
already **fixed** — use it as the working reference.~~

**`lefigaro` is NOT fixed** (measured 2026-09-16) — its "Écouter l'article"
player is still in the capture, so it is not a working reference. The set is
six, not three: `cbc` and `japantimes` too.

Done via `AUDIO_NARRATION_RE` (the label is the only shared hook — each site
ships its own player) + a seed-and-climb that stops at real prose, because
nbcnews puts its player MID-article and an unguarded climb eats the body.
Re-swept: `reason` -87px, `cbc` -111px, `smh` -61px, `nbcnews` -25px,
`japantimes` clean. **`lefigaro` still byte-identical — not fixed.** Its saved
markup is removed correctly offline, so the live page differs from the 08-29
snapshot; needs a live capture to diagnose.

- [x] 1c done — 5 of 6; `lefigaro` outstanding

### 1d. Video transport strips — `cbsnews`, `zdnet`, `nypost`, `tiktok-foryou`
Timecode/control bars (`00:00 04:15`) leaking as body text. `CLAUDE.md` already
documents the apnews transport-bar removal; extend it.

`zdnet` and `tiktok-foryou` have **no transport strip at all** in their
captures, so the real set is two.

This also fixed a **pre-existing bug**: the old pass removed any group of >=2
timecodes with no buttons — exactly the shape of bandcamp's 40 track durations
and spotify-album's tracklist (verified failing against unmodified code). The
two passes are now merged, with a **zeroed** current-position timecode
(`00:00`) as the discriminator: a tracklist never shows one. The button branch
keeps its original 40-char reach; only the timecode branch uses 120.
Re-swept: `nypost` -29px, `cbsnews` clean, `bandcamp` keeps all 30 durations.

- [x] 1d done

### 1e. Newsletter / subscription blocks — `chicagotribune`, `newyorker`, `thenation`, `noahpinion`, `straitstimes`
Widen `NEWSLETTER_RE`. `chicagotribune` is the severe case: the block does not
merely interrupt, it **replaces** the body (17% coverage).

`thenation`'s capture has no newsletter text at all (480 chars total) — its
problem is something else. `wired` and `scientificamerican` are affected and
were not listed.

The strongest hook is the **consent tail** ("By signing up, you agree to…"):
it closes every signup box and never appears in prose — 7 domains, 0 false
positives. The climb gained the same prose guard as 1c (newyorker/noahpinion
put the box mid-article). Re-swept: `chicagotribune` -104px (the severe case:
headline, hero, byline and body now present), `substack-generic` -78px,
`scientificamerican` -64px.

Two caveats: a bare "SIGN UP" button survives on `chicagotribune` (sibling
container, cosmetic), and `wired`'s "Get *The Big Story* in Your Inbox" block
does not match the pattern. `wired`'s 8000→1956px drop is **not** a win — it
is a paywall, and the shorter capture is the faithful one.

- [x] 1e done — 6 of 7; `wired`'s block outstanding

**Gate:** 29 clip baselines + new cast baselines green; `pnpm test` green;
`SWEEP_ONLY=<the ~14 affected domains>` re-sweep reviewed by eye.

**Gate result (2026-09-16):** 32/32 fixture baselines green (29 clip + 3 cast),
`pnpm test` green (286 ext + 173 web), re-sweep of 33 domains (22 affected + 11
counter-examples) all HTTP 200, none blocked, every one compared against a
pre-change copy of its own PNG. 8 of 11 counter-examples byte-identical
(`bandcamp` tracklist, `wikidata` language codes, `stackoverflow-q`,
`crates-io`, `rust-book`, `stripe-docs`, `lesswrong`, `msn-slideshow`) — no
collateral damage. Every affected domain's delta is a small targeted reduction
(-25 to -282px); none shows a body collapse.

**Method note — `--clip.html` dumps are OPT-IN.** `corpus-sweep.spec.ts` writes
them only under `SWEEP_DUMP_HTML=1`; without it a run refreshes the PNGs and
leaves whatever HTML was last dumped (here: 08-29/09-15, months stale) sitting
beside them, with nothing marking it as belonging to an older capture. A textual
before/after against those files therefore measures stale data — it produced two
wrong conclusions in this phase before it was noticed. Either compare the
images, or pass `SWEEP_DUMP_HTML=1` when the markup is what you need (it also
feeds the offline clip-width probe).

- [x] **Phase 1 done** (gate passed)

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

**Cause (identified in Phase 0, reproduced offline):** NOT `applyFlexSeparation`
— that is the CLIP's pass and its marker never reaches the converter. It is
`separateInlineFacets` in `discerned-ext/src/content/html-to-markdown.ts` (~387),
a cast-only re-derivation of the same idea, whose `INLINE_FACET_TAGS` includes
`SPAN` and `CODE`. A syntax highlighter emits one `<span>` per token with no
whitespace between them, so it inserts a space at every boundary.

Iterate against `highlighted-code-cast-fixture-visual` (~7s, offline) rather
than re-sweeping: it carries all four shapes plus the clean plain-block
counter-example in one document. Its four `knownBroken` strings are the
definition of done — when they go, the spec fails telling you to promote them to
`castMustNotContain` and refresh the baseline in the same commit.

`separateInlineFacets` exists to unglue Bluesky facets ("#TRCMP RCMP#TRCMP"), so
**narrowing it risks reintroducing that** — `bsky-thread-fixture-visual` is the
counter-guard, and a cast baseline for bsky is worth adding first.

**Warning:** the bug runs in BOTH directions (`pypi` shows add and strip on one
page). A naive "stop adding spaces" fix will not address the stripping half and
may worsen it.

### What landed (2026-09-16)

**The stated cause was only half of it, and the smaller half.** Narrowing
`separateInlineFacets` alone made the CAST match the CLIP's *already-broken*
reality — kubernetes-docs went from `apiVersion : v1 kind : Pod` to
`apiVersion:v1kind:Podmetadata:`, which is worse, and is exactly the "a naive
'stop adding spaces' fix ... may worsen it" warning above. Three fixes were
needed; the second is the one that mattered.

1. **`separateInlineFacets` narrowed** (`html-to-markdown.ts`) — it inserted a
   space between ANY two adjacent inline elements. Two guards now rule out the
   boundaries the source never rendered as a gap: a `<pre>`/`<code>` ancestor
   (whitespace there is authoritative), and a punctuation-only element on
   either side (the PROSE half — wiktionary's `( nonstandard )`, where no
   preformatted ancestor exists). The separations the pass exists for survive:
   Bluesky facets, BBC's two-span byline, adjacent prose anchors.

2. **`collapseEmpty` was deleting the whitespace** (`capture.ts`) — the real
   cause, and a CLIP bug, not a cast one. `hasVisibleContent` TRIMMED before
   testing, so it judged a whitespace-only element empty and removed it. A
   syntax highlighter wraps every run of whitespace in its own element:
   **Chroma** (kubernetes.io, every Hugo docs site) and **Pygments** (PyPI,
   Sphinx) both emit `<span class="w"> </span>` and `<span class="w">
</span>`
   between tokens. So every space and newline in the block was deleted, and
   `separateInlineFacets` had been *papering over it* by padding each boundary.
   Whitespace inside `<pre>` is now content.

   **This one fix closed BOTH directions of the bug.** The plan treated
   "padded" and "stripped" as separate failure modes needing separate fixes;
   they are the same mechanism seen from two surfaces — pypi's
   `python-mpipinstallrequests` (stripped, clip) and its `r . json ( )`
   (padded, cast) are one defect.

3. **Structural line breaks restored** (`restorePreLineBreaks`) — react.dev
   marks each line with `<div>…<br></div>`. Both the bare-`<pre>` rule and
   turndown's own fenced-code rule read `textContent`, which ignores `<br>` and
   block wrappers, so the block collapsed onto one line. This is the
   `
`-flattening half Phase 0 could not reproduce.

**Diagnosis note — the probe was worth more than the reasoning.** The first two
attempts at the newline half both targeted the wrong mechanism (a
`PRELINE_MARKER` in `applyFlexSeparation`, built and then reverted) because the
markup was reasoned about rather than measured. `tests/e2e/tools/pre-ws-probe.spec.ts`
(`PREWS=1 [PREWS_URL=…]`) settled it in one run: it reports, per `<pre>`, whether
whitespace text nodes exist and how the line wrappers compute. The answer —
"present, but wrapped in elements" — named `collapseEmpty` immediately and was
then reproducible offline in a unit test.

**Two measurement traps hit here, both of which nearly produced a wrong report:**
- **The default pixel tolerance hid the fix.** `highlighted-code-cast-fixture-visual`
  PASSED against the broken baseline after the repair: 1.46% of pixels changed,
  under `maxDiffPixelRatio`'s 0.02 default. Only the string assertions caught
  it. Monospace text of near-identical length is what a ratio gate is worst at,
  so that fixture now gates at 0.002.
- **A cast image could be stale while its clip was fresh — now FIXED in the
  harness.** `github-pr` was re-captured at 15:38 but its `--3-cast.png` was
  still 2026-08-30's, with nothing marking it, and it read as "not fixed".
  `castShotSafe` was right to swallow the failure (the cast is additive and
  must not fail a clip check that already passed) but wrong to leave the
  previous run's PNG behind. It now **deletes** the image and records
  `cast: {ok, reason}` in `--score.json`; `review-queue.mjs` prints
  `(no cast image — <reason>)`, and its dead `!cast` escape hatch (always false
  — `cast` is a `resolve()` path) was replaced with a real `existsSync` test so
  a missing cast can no longer be waved through as reviewed. Re-verified on
  `github-pr`: `{ok: false, reason: "castShot timeout (>90000ms)"}`, no stale
  file. The timeout is itself a finding — that page converts to **476 KB** of
  markdown, over the 400 KB `LONGFORM_MARKDOWN_MAX_CHARS` cap, so the feed
  RENDER is what is slow (the conversion takes 851ms). Cast-size policy for
  such pages is out of Phase 2's scope and not yet addressed.

Guards added: 10 unit tests in `discerned-ext/tests/nostr/cast-markdown.test.ts`
(inline-boundary whitespace + structural line breaks) and 5 in
`discerned-ext/tests/extraction/pre-whitespace.test.ts` (the Chroma/Pygments
shapes, plus the counter-guard that a whitespace-only element OUTSIDE `<pre>`
is still collapsed). The `knownBroken` strings in the cast fixture moved to
`castMustNotContain`, with the repaired text asserted positively, and the
baseline refreshed.

**Gate:** cast baselines green; `SWEEP_ONLY` re-sweep of all ~20 plus the six
clean counter-examples above, every one reviewed by eye.

**Gate result (2026-09-16):** 32/32 fixture baselines green (29 clip + 3 cast),
run one project at a time, re-run after EACH of the three changes — the
`collapseEmpty` fix touches every capture in the corpus. `pnpm test` green
(300 ext + 173 web). Re-swept 25 domains: 20 Phase 2 domains + 5 clean
counter-examples, every one HTTP 200 except `npmjs` (Cloudflare 403, recorded
`blocked`), each compared against a pre-change copy of its own PNG. 19 now
verdict `clean`; the 2 remaining `flaw`s are unrelated defects the whitespace
work does not own (`go-docs` TOC separators, `chosun` recirculation → Phase 4).
Counter-examples byte-identical: `postgresql-docs`, `jvns`, `hackaday`,
`seattletimes`. `stackoverflow-q` changed and was verified an IMPROVEMENT
(`int main()` repaired, Copy label unglued). No domain regressed.

**Phase 3 should be re-checked first, as planned.** These fixes changed the
cast's inline-boundary handling substantially, so some of the 8 grey-pill sites
may already be resolved.

- [x] **Phase 2 done** (gate passed)

---

## Phase 3 — Grey-pill link mangling (8 sites, cast only)

`bbc-news` `theguardian` `theatlantic` `techcrunch` `kotaku` `huffpost`
`theregister` `signalvnoise`

Link text split into two grey pill boxes with an arrow glyph slicing through it:
`Tru`▸`said`, `sat down to tal`▸`th David Senra`. **Selective** — neighbouring
links in the same paragraph render correctly, so a specific link property
triggers it. `signalvnoise` has six on one page.

**Cause — not `htmlToMarkdown` at all; the render side.** The markdown is
correct; `DetailPanel`'s ReactMarkdown `a` renderer
(`discerned-web/components/feed/DetailPanel.tsx`) decided a cast link was a
click-to-play card from the **href alone**:

```ts
const playable = !!href && !!resolveVideoEmbed(href);   // before
```

So every *prose* link to YouTube / X / Vimeo / Instagram / TikTok / Facebook
became one. `.clip-body .tweet-video` is `display: block; width: fit-content;
border-radius: 12px; overflow: hidden`, which lifts the sentence fragment out of
its paragraph as a rounded box, and `.clip-body .tweet-video-play` is `position:
absolute; inset: 0; background: rgba(0,0,0,0.35)` with a 44px white `▶` centred
on it. The "two pills with an arrow between them" is one box with the glyph
sitting over its middle, hiding the characters underneath. That also explains
the selectivity exactly: only links whose href `resolveVideoEmbed()` matches,
which is why neighbours in the same paragraph are fine.

The property the plan was looking for was the **href's host**, not anything
about the surrounding markup.

**Fix.** A play card needs a poster to lay the overlay over, so require both:

```ts
const playable = !!href && wrapsImage(children) && !!resolveVideoEmbed(href);
```

`wrapsImage` compares against the `MdImg` component reference. The old code's
comment said an `img` test was impossible because react-markdown substitutes
`MD_COMPONENTS.img` for the intrinsic tag — true, but the substitute is a known
reference, so hoisting it to a named constant makes the comparison work. The
real poster shape `[![](poster)](watch-url)` is unaffected.

**Ruled out in Phase 0 (and still ruled out):** the CSS pill rules
`.clip-body a:has(img) + a` and `a:has(img) ~ a:nth-of-type(3)`
(`discerned-web/app/globals.css` ~1792) cannot fire in a cast — casts drop
inlined images, so `:has(img)` never matches. Not the cause.

**Regression guards added:**
- `discerned-web/tests/components/CastPlayCard.test.tsx` — prose link to an
  embeddable provider stays a plain link; the poster shape stays playable; a
  prose link to a non-embeddable host is untouched.
- `tests/fixtures/sites/linked-prose-article.html` now carries a prose link to
  a YouTube watch URL, so `linked-prose-cast-fixture-visual` **reproduces** the
  defect rather than merely watching for it. Verified by reverting the fix: the
  cast text gains a bare `▶` line and the pixel baseline fails, rendering
  `sat down to tal`▸`th David Senra` — pixel-identical to the signalvnoise
  corpus slice. `castMustNotContain` now includes `▶`, so the text assertion
  names the bug before the baseline reports "images differ".

**Gate:** cast baselines green; re-sweep the 8.

All three cast baselines green (`linked-prose`, `highlighted-code`,
`substack-essay`), plus `medium-fixture-visual` as a clip-side control, 176 web
unit tests and 301 extension unit tests. All 8 domains re-swept 2026-09-16, all
`ok` / http 200 / cast rendered, and all 8 reviewed clean — every pill gone,
including signalvnoise's six. `techcrunch` has an explicit before/after: the
prior capture rendered `includin`▸`m Sacks`, the new one reads `including from
Sacks` inline. A legitimate poster play card (kotaku's YouTube embed) still
renders correctly, so the fix narrowed the rule rather than disabling it.

- [x] **Phase 3 done** (gate passed 2026-09-16)

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

### What the images actually showed (2026-09-16)

Reading the tail band of each clip (the verdicts describe only the TOP band, so
several were wrong about the tail) narrowed the list from 12 to 5 real Phase-4
targets, and reassigned the rest:

| Domain | Actual state | Disposition |
|---|---|---|
| `economist` | "More from Science & technology" + 6 teaser cards | **Phase 4** |
| `newsweek` | "Read More on News" + ribbon cards mid-article | **Phase 4** |
| `japantimes` | large recirc tail; **its verdict said clean** (top band only) | **Phase 4** |
| `msnbc` | `<h3>More articles</h3>` + card, then more section rails | **Phase 4** |
| `thedailybeast` | "Top Stories" video widget | **Phase 4** (body loss is 5a) |
| `chosun` | Korean "사회 많이 본 뉴스" | out of scope — no English vocabulary can match it |
| `globeandmail` | house promos ("Interact with The Globe"), not article recirc | different shape |
| `time` | clip AND cast now clean — the verdict was stale | not a defect |
| `scmp` | no recirc block at all (stat/separator flaws) | not Phase 4 |
| `genius` | "appears on" album list | `CROSS_SELL_HEADING_RE` path |
| `npr`, `axios` | genuinely clean | not a defect |

### Why the regex alone was never going to be enough

Measured on the real captured markup, not inferred: the module sits **four**
levels above economist's `<h2>` (513 chars, 7 anchors, 6 images) behind
pass-through wrappers, so the 3-level climb cap could never reach it. And on
newsweek/msnbc the teaser is a **following sibling** of the heading — the
nearest common ancestor is the whole article body, which the prose guard
correctly refuses to remove. So three changes, not one:

1. **Vocabulary** — the measured heading forms added to both regexes.
   `read more` stays anchored to the `on <section>` form: a bare prefix hit 26
   corpus domains and **25 were inline expanders** inside real content
   (allrecipes reviews, newscientist mid-article cards) that `hasLongProse`
   would NOT have saved, since it only counts `<p>` and those bodies are bare
   `<div>`s. That measurement is the reason the obvious widening was rejected.
2. **Climb depth 3 → 5 for STRONG headings only.** Weak headings stay at 3 —
   they are gated on a text ratio rather than a vocabulary match, and they are
   the ones that have historically over-removed.
3. **`removeSiblingRecircCards()`** — a new pass for the mid-article inject
   shape. Consumes following siblings only while they stay card-shaped and
   stops at the first holding real prose; **one sibling too many deletes the
   rest of the article**, which is what the fixture's third assertion pins.

A label-only box (a container whose text is just the heading) is no longer
removed by the climb — it would strip the label and strand its cards.

### Measured blast radius

Replaying both passes over **all 189 saved corpus captures**: 7 domains
affected, all genuine recirculation, **182 untouched**. Each mechanism is
load-bearing — with the climb at 3, economist drops out entirely; with the
sibling pass off, newsweek/msnbc/japantimes-"Latest News" do.

Residue deliberately left: japantimes' second tail block is behind the
2500-char cap, and raising that is the "eats real content" risk above.

**Gate:** full 29 clip baselines; re-sweep the 12 **plus** a sample of
long-article domains to confirm no body truncation.

### Gate result (2026-09-16)

All **33** fixture-visual baselines green (29 clip + 3 cast + 1 shared), 301
extension and 176 web unit tests green, `pnpm type-check` clean. Re-swept 12
domains — the 7 the simulation flagged plus 5 long-article controls — all
captured `ok` / http 200 / cast rendered, none blocked, and all 12 reviewed on
both surfaces.

Fixed: **economist** (clip 3441→997px, cast 3895→1135px; the six-teaser module
gone from both), **newsweek** (the "Read More on News" ribbon cards gone, prose
now unbroken from lede to "What Is Cyclospora?"), **msnbc** (mid-body inject
gone, prose continuous), **japantimes** (8000→6468px, the link-ribbon tail
gone — and it no longer hits the screenshot cap), plus nature, myanimelist and
deepmind-blog.

**No body truncation on any control.** `textCoverage` moved by ≤0.015 on all
five (wikipedia-en identical, newyorker −0.003, arstechnica +0.004), and each
was read as an image rather than trusted from the scalar. theatlantic's inline
prose cross-reference ("Read: Chatbots are becoming…") survived, which is the
direct confirmation that anchoring `read more` to the `on <section>` form was
the right call.

Out of scope, recorded rather than chased: msnbc's section-name rails
("Congress", "Supreme Court") cannot be matched by any text vocabulary;
japantimes' KEYWORDS strip and advertorial, and nature's Careers jobs listing,
are different shapes.

- [x] **Phase 4 done** (gate passed 2026-09-16)

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

### What the probe measured (2026-09-16) — it is NOT the layout finder

`finder-diag-probe.spec.ts` gained a generic headline section (where the page
`<h1>` sits relative to the winning block AND to the tier-1 root, plus whether
the headline survived into the capture). Run over the set, it overturned the
premise above: **the layout finder never runs on these pages.** Tier 1
(`findArticleElement`) wins first with an `<article>` that holds the whole body
and no title, because the CMS renders `<header><h1></header>` as its SIBLING.
7 of 7 reported `holdsHeadline=false` **and** `headlinePrecedes=true`.

So no change to root selection was needed — and the plan was right to fear one.
Widening to the nearest common ancestor is what that would take, and the cost is
measured: on cnn that ancestor holds **20,886 chars against the article's 5,910**
(3.5x), which is precisely the "wrong block picked" failure this phase warned
about. Prepending one heading adds the title and nothing else, whatever sits in
the gap.

**Fix:** `withHeadlineFallback` (capture.ts), a guarded additive prepend modelled
on `withThumbnailFallback` and wired into the same three tier call sites. Guards:
the capture must not already LEAD with a heading; the headline must sit outside
the captured root, be visible, be of title-like length, not already appear in the
body, and share ≥60% of its words with the page `<title>` (which is what stops a
"Related stories" rail heading being promoted).

**The guard that mattered was "leads with a heading", not "has one".** The first
version asked whether the body contained any `<h[1-3]>` and fixed only cnn and
gizmodo. 5 of the 7 carry ordinary `<h2>`/`<h3>` **section subheads** (zdnet has
10), so an any-heading test made the recovery a no-op on exactly the pages it was
written for. A title is the first thing in the body or it is not the title.

**Two of the 14 are a different shape and are NOT fixed:** `rottentomatoes` and
`goodreads-author` are **entity** pages whose name sits in a structured hero
handled by a site tagger, not in an `<h1>` outside the root. They need tagger
work, not the generic fallback.

**And the CAST half of these verdicts was never a defect.** Both the clip and the
cast sweep screenshots capture `.clip-body`, while `DetailPanel` renders the
title in `<h2 className="detail-title">` **outside** it — so a cast title cannot
appear in a sweep image by construction. The cast carries the headline in the
NIP-23 `title` tag and `stripLeadingArticleChrome` deliberately removes the
duplicate `# heading`. Every "no headline" recorded on the cast surface was
measuring the screenshot boundary.

### Gate result (2026-09-16)

All **32** fixture baselines green (29 clip + 3 cast), run one project at a time,
re-run after the guard change. 306 extension + 176 web unit tests green,
`pnpm type-check` clean. Re-swept 20 domains — the 14 Phase 5a domains plus 6
long-article controls — 19 captured `ok` / http 200 / cast rendered; only
`sciencemag` was blocked (Cloudflare 403, recorded `blocked`).

Fixed, verified by reading each image: **cnn**, **fortune**, **gizmodo**,
**pcmag**, **zdnet**, **newsweek**, **motherjones**, **msn-slideshow** and
**thedailybeast** all now lead with the headline. `zdnet` keeps its own `<h2>`
subheads, which is the leading-heading guard working.

**No regression on any control.** arstechnica, newyorker, theatlantic and
substack-generic are **pixel-identical in height** to their pre-change captures,
wikipedia-en and huffpost byte-identical, and newyorker is the direct
confirmation that the guard holds: its capture leads with a "New Yorker
Favorites" section label and no duplicate headline was added.

Residue, recorded rather than chased: `zdnet` video transport strip,
`motherjones` TOP STORIES strip, `thedailybeast` body loss (a paywall, severity
6), `ndtv` cast alt-texts — all pre-existing defects other phases own.

- [x] 5a done (gate passed 2026-09-16) — 9 fixed, 2 reassigned (entity pages),
      1 blocked, and the cast half found to be a screenshot artifact

### 5b. Column / ribbon collapse — 7 sites
`msnbc` `myanimelist` `newsweek` `scmp` `steam` `zenodo` `lastfm`

CSS in `globals.css` affecting all 206 clips. `project_dx_stats_flex_collapse`
records `.dx-stats` flex collapsing comment threads — a regression from exactly
this kind of change. Diagnose offline with `tools/clip-width-probe.spec.ts`
(works from a saved HTML file, no live site needed).

### What the probe measured (2026-09-16) — one CSS case, not seven

Two gaps in the probe had to be closed before it could see anything, and both
had been silently reporting "nothing is narrow" for visibly broken clips:

- **It rendered at the 1280px viewport**, while the sweep renders `.clip-body`
  in a **~610px** detail panel. A ribbon or table only collapses when the column
  is too narrow for it. `CLIPW_WIDTH` now constrains the host.
- **Its text filter required `textLen > 60`**, right for Lemmy's paragraphs but
  blind to the squeezed-LABEL shape that is actually in this list: last.fm's
  "Thom Yorke" is 10 chars. The filter now catches any box narrower than its own
  longest word. A table/cell census was added for the same reason — a collapsed
  table's cells are narrow while the table itself is not.

Re-measured at 610px against **fresh** captures (the `--clip.html` dumps were
2.5 weeks stale — `SWEEP_DUMP_HTML=1` is opt-in), the list resolves to:

| Domain | Measured | Disposition |
|---|---|---|
| `lastfm` | `<h3>` at **44px inside a 522px `.dx-header`** | **Phase 5b — fixed** |
| `steam` | **not CSS.** 34 images at a true 116x65, **zero** full-size screenshot URLs in the capture — Steam lazy-loads the large carousel image, so only the thumbnail rail is in the DOM | capture timing, not width |
| `zenodo` | site returned **504** on re-capture; the clip is the error page | can't diagnose; `blocked` |
| `msnbc` `scmp` `myanimelist` | no narrow text, no squeezed cells, lists at 562/610px | not a collapse — their real flaws are rails/stats, other phases |
| `newsweek` | fixed by 5a | not a defect |

**Fix (the one real case).** `.clip-body .dx-header > :is(h1…h6)` gets
`flex: 1 1 auto; min-width: 8em`. The generic tagger stamps `dx-header` on rows
whose heading comes FIRST and whose image comes second; in a `flex-wrap: nowrap`
row the 103px image holds its intrinsic width and the heading is handed
whatever is left. Scoped to a **direct-child heading**, which none of the tuned
avatar/reel/bsky header rules use, so they are untouched.

### Gate result (2026-09-16)

Probe: 2 crushed elements → **0**, measured offline against the real captured
markup. All **32** fixture baselines green — including every header-sensitive
one (bsky, primal, reddit, facebook-reel, youtube), which is the point of the
gate for a shared-CSS change. 176 web unit tests green, `tsc` clean on the web
app. Re-swept the five reachable domains, all `ok` / http 200: `lastfm` now
renders "Thom Yorke" on one line (was "Tho m Yor ke"); `steam`, `msnbc`, `scmp`
and `myanimelist` are unchanged, which is correct — the rule found nothing to do
on them.

- [x] 5b done (gate passed 2026-09-16) — 1 real CSS case fixed; 4 of the 7
      re-diagnosed as other shapes, 1 blocked, 1 already fixed by 5a

### 5c. og:image promotion *policy* (the judgement half of 1a)
Should a site's own logo or a purpose-built 1200x630 OG card be promoted at all?
Distinguishable by intrinsic aspect/size, and often by URL (brittle). Weigh
against the MSN syndication case.

**This is now ALL of 1a, not half of it** (measured 2026-09-16 — see 1a). The
CSS cap was already engaging; the promoted images render at 209-543px in a
610px column, so nothing is stretched. The complaint is that a site logo or an
OG card renders that large *at all*, which is purely a promotion-policy
judgement. `tildes` (144x144 logo painting 209px) is the clearest case;
`courtlistener` (1200x630 OG card at 543px) the widest. A stamping fix cannot
help either — the stamp is already there and already honoured.

### What the measurement found (2026-09-16): aspect separates them cleanly

Measured on the **intrinsic** size `probeImageSize` already fetches (so the
signal costs nothing new), across every corpus domain that currently leads with
a promoted figure — re-swept with `SWEEP_DUMP_HTML=1` first, because the saved
dumps predated 1a's width stamp:

| Kind | Aspect | Domains |
|---|---|---|
| site logo / avatar | **0.97 – 1.00** | `tildes` 144x144, `gitlab-repo` 512x512, `signalvnoise` 300x300, `postgresql-docs` 540x557 |
| OG card / real art | **1.50 – 1.91** | `crates-io`, `meduza`, `overreacted`, `python-docs`, `stripe-docs` 1200x630, `folha` 2400x1600 |

A brand mark is square because that is what a logo is; an OG card is ~1.91:1 by
the spec every site follows. Nothing in the corpus sits between 1.00 and 1.50,
so the band is wide on both sides.

**The refused clip has NO other image — that is the actual trade.** Promotion
only fires when the body has zero images (Guard 0), so by construction every
promoted image is the clip's only one: measured, all 12 domains have **0**
images remaining once the promoted figure is removed, and 15 of 189 corpus
captures (~8%) are in that state. So this rule does not pick a better image, it
chooses an image-LESS clip over a logo one. That is right at hero size — a
300-500px brand mark above a text thread displaces the content and says nothing
about the page — and the decision is made per SURFACE rather than per image:

| Surface | Field | Logo shown | Why |
|---|---|---|---|
| clip body (hero) | `bodyHtml` | **no** | at 450px it displaces the content |
| library row | `capture.thumbnail` | **yes** | at 32px it is a useful "this is a tildes clip" key |
| cast hero | `thumbnailUrl` → `thumbnail` | yes (leak) | not deliberate — see below |

**Fix:** Guard 3 in `withThumbnailFallback` refuses to promote a declared
og:image whose intrinsic aspect is 0.8–1.25. It applies only when the size is
KNOWN (an unmeasurable image keeps the previous behaviour rather than being
guessed at), and it is a **hero-only** rule — `capture.thumbnail`, the library
row's preview, still uses the logo, which is a perfectly good visual key.

**Two of the six are NOT fixed, and cannot be by this rule.** `mayoclinic`
(600x315) and `courtlistener` (1200x630) serve their logo *inside a wide OG
card*, so they are shape-identical to a legitimate one. Rejected alternatives:
a URL vocabulary (`logo|avatar|brand|…`) catches mayoclinic but not
courtlistener's generic `og-image-1200x630.png`, and the plan already calls URL
matching brittle; flat-colour dominance was measured and does **not** separate
them (`python-docs` 0.88 is legitimate, `mayoclinic` 0.53 is a logo). Left as
recorded flaws at severity 3 rather than fixed with a rule that would cost false
positives on real article art — promotion is load-bearing for the MSN
syndication case.

**Also confirmed:** the tried-and-rejected finding from 1a still holds — nothing
was ever stretched, so this was correctly a policy change and not a CSS one.

**The CAST needed a second fix — nulling `thumbnailUrl` was not enough.**
Measured after the clip fix: all four casts byte-identical, still heroing the
logo. `pickImageUrl` (events.ts) falls through `thumbnailUrl` → `thumbnail` →
`imageUrls`, and an UNGRANTED capture stores a plain http URL in `thumbnail`
(the optional `<all_urls>` grant is what would make it a `data:` URI, which
pickImageUrl already skips) — so nulling the first field just moved the search
to the second, which held the same logo.

Two fixes were tried and reverted first, each caught by an existing guard:
skipping the `thumbnail` FIELD for non-bookmarks broke
`tests/fixtures/clips/article.json` (an article can carry its only hero URL
there, so real heroes would vanish from casts), and nulling `thumbnail` itself
removes the library-row preview.

What works is distinguishing the two meanings the field was carrying:
`thumbnailIsLogo`, one optional boolean set from the same `declaredIsLogo` the
clip guard uses, and one line in `pickImageUrl` that skips a FLAGGED thumbnail
rather than the field. Guarded by `tests/nostr/logo-cast.test.ts` (flagged ⇒ no
`image` tag; unflagged ⇒ still cast) plus a flag counter-case in
`og-logo-promotion.test.ts`.

### Gate result (2026-09-16)

All **32** fixture baselines green, 309 extension unit tests green (including the
syndication and feed-og-image guards that protect the promotion path), `tsc`
clean. Re-swept all 12 domains, every one `ok` / http 200:

| | Result |
|---|---|
| 4 square logos, CLIP | **shrank**: `gitlab-repo` −450px, `postgresql-docs` −450px, `signalvnoise` −315px, `tildes` −174px — stable across two runs |
| 4 square logos, CAST | **shrank** once `thumbnailIsLogo` landed: `gitlab-repo` −444px, `postgresql-docs` −444px, `signalvnoise` −324px, `tildes` −168px |
| 8 wide images | **pixel-identical** height on both surfaces: `crates-io`, `meduza`, `overreacted`, `python-docs`, `stripe-docs`, `folha`, plus `courtlistener` and `mayoclinic` (the two the rule cannot see) |

Every one of the eight clip/cast pairs was read as an image, not inferred from
the height delta.

Zero false positives, which is the whole risk of this change.

- [x] 5c done (gate passed 2026-09-16) — 4 of 6 fixed on **both** surfaces;
      `mayoclinic` and `courtlistener` outstanding (logo inside a wide OG card,
      shape-identical to a legitimate one)

**Gate:** each sub-item separately — full 29 clip baselines + cast baselines
green, `pnpm test` green, and a re-sweep of the affected domains **plus** a
sample of unaffected ones (these touch shared code, so the unaffected sample is
the point).

- [x] **Phase 5 done** (2026-09-16 — all three sub-items gated separately)

**Phase 5's premise was wrong on all three counts, and measuring first is what
found that.** 5a was filed against the layout finder, which never runs on those
pages (Tier 1 wins). 5b was filed as a CSS column collapse; one of the seven was,
and the probe could not see even that one until its own viewport and text-length
assumptions were fixed. 5c was the one item whose stated cause held — and it had
already been re-diagnosed once, in Phase 1a. In each case the fix that shipped is
smaller and lower-risk than the one the plan anticipated, because the plan's
feared change (widen the finder, restyle every clip) was not what the evidence
called for.

Common residue, recorded not chased: entity pages (`rottentomatoes`,
`goodreads-author`) need tagger work for their titles; `mayoclinic` and
`courtlistener` serve a logo inside a wide OG card; `steam` lazy-loads its
carousel so only thumbnails are ever in the DOM.

---

## Phase 6 — Low-risk cosmetic defects

Independent of Phases 1-5 and of each other; no shared blast radius. Can be done
in any order, or folded into another phase's batch — but tracked here so each
can be marked done cleanly.

### 6a. Literal markdown leaking — 6 sites
`aws-blog` `time` `smashingmagazine` `simonwillison` `kaggle` `lemmy-thread`

`**bold**` and `![img](url)` rendering as visible text. Cast-side; the markdown
conversion is emitting syntax the renderer then shows literally.

**Two separate mechanisms, both fixed in `html-to-markdown.ts` (2026-09-16).**
Measured by re-running the real converter over the 189 saved corpus captures and
PARSING each result with the web app's own remark: **66 indented code blocks
holding markdown syntax → 0**.

1. **A block-emitting `dx-*` rule inside an `<li>`.** `dx-quote-block`,
   `dx-header-line` and `dx-stats-counts` each return `\n\n…\n\n`. As the whole
   content of a list item that leaves the item's first line EMPTY, and
   CommonMark allows only one blank line there — so the 4-space-indented
   remainder falls out of the list and parses as an **indented code block**,
   which is why the `**bold**` shows literally in a grey box. All three rules now
   emit inline via `inListItem()`. `time` (3 blocks) was the listed site;
   **`letterboxd` was far worse at 63** and is not in the list above.
2. **Emphasis ending in a line break.** `<strong>Heading<br></strong>` converts
   to `**Heading\n**` — the closing delimiter starts a line, so the emphasis
   never closes and the heading merges into the paragraph after it (`aws-blog`).
   `liftTrailingBreaks()` moves the `<br>` outside the emphasis.

`simonwillison`'s `\[MCP\](…)` is **not ours**: the page's own prose contains
literal markdown, and escaping it is correct. Left alone.

- [x] Fixed
- [x] Verified — **no re-sweep needed** (see "Verifying a converter-only change")

### 6b. Unlabelled stat runs — 6 sites
`spotify-album` `producthunt` `imdb` `imdb-name` `tiktok-foryou` `genius`

Structured lists reduced to bare numbers. `spotify-album` is the severe case —
the whole tracklist becomes `1 · 1`, `2 · 2`. Related: the YouTube odometer
rebuild in `discerned-ext/CLAUDE.md` solved the same shape of problem.

**Cause: `dx-stats-counts` firing on a CONTENT row, not a tagger defect.** The
generic tagger stamps `dx-stats` on any short flex row of icon-bearing children
— which a Spotify track row is (track number + play glyph, title, artist,
duration). That mark is harmless for the CLIP, which renders the tracklist
perfectly; it is the converter that reduces the row to its numbers. Confirmed by
reading both PNGs: clip correct, cast `1 · 1`.

**Footprint is 6x what is listed here.** Measured across the 206-domain corpus:
**37 domains, ~6,274 characters of prose discarded** — engadget's pros/cons
lists (1,324 chars), allrecipes' reviews, dockerhub's tag table, appstore's
privacy categories.

**Fix (2026-09-16).** `hasContentLink()` — a link whose own text is neither a
count nor a UI verb (`STATS_CHROME_LINK_RE`) means the row is content the tagger
over-matched. Such a row is emitted as ONE line with its links intact, rather
than collapsed to counts. Text alone does not separate the two cases and was
tried first: word-count and longest-word-run both tie `"Add AP News on Google"`
(chrome) with `"3 On the Run Pink Floyd 3:36"` (content). The count regex also
now matches a timecode first, so `1:04` no longer truncates to `1`.

Verified over the saved corpus: 43 domains changed, **no domain lost a word**
(the negative char deltas are indentation only; tripadvisor gained 76 words).

- [x] Fixed
- [x] Verified — **no re-sweep needed** (see "Verifying a converter-only change")

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

### DIAGNOSED 2026-09-16 — cross-origin response blocking, not expiring URLs

**First, the table above measures a DIFFERENT capture.** Every `--clip.html` was
dated 08-29/30 while the PNGs beside them were 09-14/16 — `SWEEP_DUMP_HTML` had
been off since August (see [memory: project_sweep_dump_html_opt_in]), and **the
backups carry the same stale dumps**, so the markup for the reviewed captures did
not exist anywhere. Re-captured the five domains with the flag on; HTML and PNG
are now same-second, and the reported defect reproduces on all of them.

**The real cause.** The avatars are hotlinked (0 of 5 domains had ANY image
inlined — the sweep profile lacks the optional `<all_urls>` grant), and the
browser refuses to render them:

| domain | broken | browser error |
|---|---|---|
| `instagram-home` | 2 of 3 | `ERR_BLOCKED_BY_RESPONSE.NotSameOrigin` |
| `instagram-reels` | 1 of 2 | `ERR_BLOCKED_BY_RESPONSE.NotSameOrigin` |
| `goodreads-book` | 7 of 114 | `ERR_BLOCKED_BY_RESPONSE.NotSameOrigin` |
| `ndtv` | 0 of 2 in the CLIP, 2 of 2 in the CAST | `ERR_BLOCKED_BY_ORB` — different BROWSER per surface, see below |
| `biorxiv` | 0 of 2 | — (renders clean) |

**`ndtv` is a DIFFERENT case: the two SURFACES render in different browsers.**
Its clip shows both images while its cast shows two broken glyphs — same URLs,
same run, 3 seconds apart. Re-captured 2026-09-16 20:55 on a hand-warmed profile
and it reproduces **identically**, so this is structural, not timing:

| Surface | Renders in | ndtv images |
|---|---|---|
| clip | the sweep's warm branded Chrome (`Profile 3`), extension loaded | **load** |
| cast | `chromium.launch()` + `newContext()` — bare headless, **no profile, no cookies** (`renderCast.ts` 61/138) | `ERR_BLOCKED_BY_ORB` |

NDTV sits behind Akamai Bot Manager, which 403s the cold client and returns
`Content-Type: text/html` — a non-image response to an image request, which is
exactly what ORB blocks. Reproduced directly: a `renderCast`-equivalent browser
fails on that URL right now while the warm profile loads it at 1015px. The cast
browser cannot rescue itself either — visiting `ndtv.com` first still yields
`ak_bmsc=false` and a 403, so Akamai refuses to issue the cookie at all.

**Why the cast does not just use the warm browser.** `renderCast`'s own comment
gives three reasons, and all three are about the EXTENSION, not the profile: on
`localhost:3000` the extension's `web-bridge.ts` injects the user's real clips
into the feed, the first-run onboarding redirect navigates the tab away, and the
content scripts fight `page.routeWebSocket`, which must own the mocked relay's
data. Launching bare is how it gets an extension-free page.

That conflates two separable properties. The warm `Profile 3` carries the
extension AND carries bot-manager clearance; the code drops both to shed the
first. So this is a gap rather than a considered trade — the cast render wants
"no extension", not "no reputation".

**The fix is to publish the cast to the LOCAL RELAY and drop the mock entirely
(PROVEN 2026-09-16).** The mocked WebSocket is the only reason the cast needs its
own browser — remove it and the whole conflict dissolves. The repo already has
every piece: a real relay at `ws://localhost:7777` (`pnpm relay:local`), and
`castFromCapture.ts` already produces a REAL signed event
(`finalizeEvent(template, generateSecretKey())`), which it currently hands to a
fake socket instead of a real relay.

Measured end to end on ndtv, in the warm `Profile 3` with the extension loaded:
capture (http 200, 10,303 chars) → build the real long-form cast → `EVENT` to the
local relay (`["OK",…,true,""]`) → open `/discerns` in the SAME browser → the feed
subscribes normally and renders it. The hero image reports **`naturalWidth`
1010** and is visibly present, against **0** and a broken glyph in the current
harness. No `routeWebSocket`, no second browser.

Why the extension stops mattering once the mock is gone: it injects clips over
`postMessage` (a different data path from the cast feed, and the CLIP render
already coexists with it by selecting its own row via a per-run marker), and its
`DISCERNED_BRIDGE_RELAYS` message early-returns in `applyRelayMode` when the
mode already matches — which it does, since both sides are `local`.

This is also more faithful than the mock: it exercises the real subscribe path
against a real relay rather than a fabricated socket conversation. Open
questions before adopting it in the harness: the sweep would need the local relay
running (it is started by hand today), and events would need clearing between
domains so one cast cannot be screenshotted for the next.

**A cookie transplant is NOT the fix (measured).** Exporting the warm profile's
38 ndtv cookies (`ak_bmsc` included) into a bare `chromium.launch()` context
still gives `ERR_BLOCKED_BY_ORB`. Akamai is fingerprinting the CLIENT — headless
Chromium's TLS/HTTP2 signature — not merely checking for a token. In the same
run the warm profile itself loaded ndtv and the image correctly, so a warm
renderer works; it just has to be the real profile, not a headless context
wearing its cookies. Any fix therefore means running the cast render in branded
headed Chrome with the extension suppressed some other way (a separate profile
directory without it, or `chrome://extensions` disable), which is a real piece of
work, not a config flag.

**This is a HARNESS artifact, not a capture defect.** A real reader opens the
cast in their own browser, which is not a fresh automation context. The sweep's
cast image is a faithful picture only of what a cold headless client sees — so
on a bot-defended domain, "the cast lost its images" should be checked against
the clip before it is believed.

**Two corrections to earlier readings of this domain, both recorded because the
method matters more than the result.** (1) An initial "NDTV rate-limited us in
the 3-second gap" reading was wrong — it fitted the timestamps but did not
survive a re-capture. (2) A follow-up 2x2 that appeared to show "headless is the
only variable" was measured AFTER the site had been warmed by hand in that
profile; `ak_bmsc` in the test profile's cookie jar is stamped 03:51:43 UTC,
between the failing and passing measurements. Check `creation_utc` against the
run's `ranAt` before crediting any code-level cause — see
[memory: project_cf_clearance_manual_warmup].

Instagram serves **profile pictures** (`t51.2885-19`) with
`Cross-Origin-Resource-Policy: same-origin` and **post photos** (`t51.82787-15`)
with `cross-origin` — which is exactly why the avatar breaks while the post photo
beside it, on the same CDN host, loads. No referer, CORS mode or URL variation
changes this; CORP is enforced by the browser against the *embedding* origin.

**This is why a plain fetch says the URLs are fine.** `curl`/Python get `200` on
every one of them, because CORP and ORB are browser-side policies the server
reports but does not enforce. Diagnosing this needs a real browser render — the
measurement that produced the plan's original (wrong) "CDN URLs expiring" note,
and the one that nearly produced a second wrong answer here.

Both of the plan's candidate explanations are disproved:
1. **Review artifact** — no. The failure is not "no network"; it is a policy
   header, so it fails identically with full network and would fail for a real
   user viewing the clip.
2. **Squashed avatar** — no. It is an actual broken-image glyph with its alt
   text spilling beside it, not a distorted circle.

**The grant is the fix, and it already exists.** The background's privileged
fetch is not subject to CORP/ORB (it runs as the extension, not as the page), so
with the optional `<all_urls>` permission these images inline as base64 and
render. That is precisely why the AUGUST captures — 7 of 7 inlined — showed no
broken images and the September ones, 0 of 5 inlined, do. **No capture-code
change is warranted**; what the sweep measured is an ungranted profile, which is
a faithful picture of the ungranted user experience.

Two things follow that are worth recording rather than fixing blind:
- The sweep profile should hold the grant if its clips are to represent a
  granted install; otherwise every CORP-protected avatar will keep being
  re-reported as a capture defect each run.
- `biorxiv`'s logo is a genuine durability gap (one hotlinked image, one site),
  unchanged from the plan's original read. Its 429 under a bare fetch is
  rate-limiting, not a render failure — it renders fine in the browser.

`sciencemag` is not a member of this set at all: its verdict is **`blocked`**
(Cloudflare 403, nothing captured).

- [x] Reproduced — cause is CORP/ORB on hotlinked images, NOT expiring URLs
- [x] Verdicts to correct: this is ungranted-profile behaviour, not a capture bug
- [x] Fixed — **N/A by diagnosis**: no capture-code change is warranted (the
      grant already resolves it; the open item is the sweep profile, not the
      pipeline). `biorxiv`'s single hotlinked logo remains the one real gap.
- [x] Re-swept — the five domains were re-captured 2026-09-16 with
      `SWEEP_DUMP_HTML=1` and each reproduces with a named browser error

### Verifying a converter-only change

**6a and 6b need no re-sweep, and the generic gate below is the wrong test for
them.** They changed `html-to-markdown.ts` only — no capture-path file — so a
clip cannot move, and the cast output is a pure function of the saved
`--clip.html`. Running the real converter over ALL 189 saved captures and
PARSING each result with the web app's own remark is therefore strictly stronger
evidence than re-sweeping six named domains: 189 domains instead of 6,
deterministic, and free of bot walls and live-page drift.

What that pass measured:
- literal-markdown code blocks: **66 → 0** (parsed, not grepped — an ordinary
  multi-block list item is legitimately 4-space indented, so a grep reports ~16
  false positives)
- 43 domains changed, **no domain lost a word**; the negative char deltas are
  indentation only, and tripadvisor gained 76 words
- the 3 cast pixel baselines — the automated cast guard Phase 0 exists to
  provide — stayed green, as did the clip baselines spot-checked individually

There is also a live confirmation already on disk: the 6c re-capture ran with
these fixes in the build, so `ndtv`'s fresh `--3-cast.png` is a real sweep cast
built by the fixed converter.

**Reach for a re-sweep when the CAPTURE changed.** A phase that touches
`capture.ts`, a tagger or the layout finder has no offline equivalent, because
the input itself moves. A converter-only phase does.

**Gate:** clip + cast baselines green; `pnpm test` green; corpus-wide converter
re-run parsed and diffed (in place of a re-sweep, per the above).

- [x] **Phase 6 done** (gate passed 2026-09-16)

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
7. **Run fixture-visual baselines ONE PROJECT AT A TIME.** They all render
   through the single shared Next dev server on :3000, so a batched run's
   pass/fail mix measures contention rather than the code. A failure seen during
   a batch is not evidence until reproduced alone. Measured 2026-09-15 on
   `breitbart-fixture-visual`: 4/4, then 1/3, then 5/8 across interleaved
   batches; green every time it ran by itself.
   (`feedback_dont_run_fixtures_concurrently`)
8. **Review for PROPORTION, not just presence.** Two independent model reviews
   both rated `postgresql-docs` and `tildes` clean because the content was all
   there — neither asked whether an element was the right *size*. A human caught
   it by eye.
9. **Match the verification to what actually changed.** A re-sweep is the only
   way to see a CAPTURE change, because the input itself moves. For a
   converter-only change (`html-to-markdown.ts` and nothing else) the cast is a
   pure function of the saved `--clip.html`, so re-running the real converter
   over every saved capture and PARSING the result covers 189 domains
   deterministically — strictly more than re-sweeping the handful of domains a
   sweep happened to name, and immune to bot walls and live-page drift. Phase 6
   carried a "re-swept + reviewed" checkbox from the template and nearly paid for
   a live run that could only have told it less.
