# Cast-render fix plan

*Generated 2026-07-14 from the first run of the new three-image visual verification
(source / clip / cast) across all 11 live `*-visual.spec.ts`. Evidence: the 33 PNGs in
`test-output/live-visual-run/` (`{site}--1-source.png`, `--2-clip.png`, `--3-cast.png`).*

## Context — why these are cast-only

The **clip** render (`DetailPanel` → `dangerouslySetInnerHTML` of the rich `bodyHtml`) looks
correct on every site: it keeps the `dx-*` classes + `width`/`height` attrs, and
`globals.css` uses them to pin avatars to 44px circles, lay out bylines, grid photos, etc.

The **cast** render is what the public feed shows: a **kind-30023 markdown body** produced by
`discerned-ext/src/content/html-to-markdown.ts` (`htmlToMarkdown`, turndown), rendered by
`DetailPanel` via `ReactMarkdown` + `remarkGfm`. Markdown carries **no classes and no width**,
so every layout hint the clip relies on is gone. The markdown converter is therefore the *only*
gatekeeper for cast fidelity, and it is coarser than the clip's CSS. Every defect below lives in
`html-to-markdown.ts` (converter) or `discerned-ext/src/shared/nostr/events.ts` (tag/image
selection) or `discerned-web/components/feed/DetailPanel.tsx` (hero suppression) — **not** in the
capture pipeline (the clip proves the capture is good).

All fixes belong to the extension/web packages. After any converter change, regenerate the
`card-*` event fixtures (`pnpm test` in `discerned-ext` → `event-fixture-generation.test.ts`) and
re-run `web-cast-render.spec.ts` (always-on) plus `cast-markdown.test.ts`.

---

## Findings, ranked by severity

### 1. Bluesky post text collapses into a hashtag run-on wall  — **worst**
*Evidence: `bsky--3-cast.png` (a solid wall of `…#TRCMP RCMP #TRCMP…` glued tokens) vs
`bsky--2-clip.png` (clean per-post structure, hashtags on their own line).*

Bluesky renders body text with **facets** — hashtags/mentions/links are separate inline `<a>`/
`<span>` nodes with no whitespace between them and between paragraphs. The clip's flex-separation
(`applyFlexSeparation`, `FLEXSEP_MARKER`) inserts spaces; the markdown converter does **not** see
that marker, so turndown concatenates every facet + paragraph into one line, and repeated hashtag
facets duplicate.

**Fix:** in `html-to-markdown.ts`, before turndown runs, apply the same flex/inline separation the
clip gets — either (a) honor the `FLEXSEP_MARKER` the live page already stamped (carry it through to
markdown), or (b) add a turndown pre-pass that inserts a space/newline between adjacent inline
element siblings inside `dx-post`/`dx-body`. Also collapse duplicate adjacent hashtag links.
**Verify:** add a `bsky`-shaped card to `cast-markdown.test.ts` (facet soup → separated hashtags,
no `#TRCMP#TRCMP`).

### 2. Byline glue — name/handle/time/counts concatenate without separators
*Evidence: `youtube--3-cast.png` "jawed6.3M subscribers"; `primal--3-cast.png`
"Gigidergigi.com", "Vitor Pamplonavitorpamplona.com", "Akashi Hyogo1 mo."; `breitbart--3-cast.png`
"Ildefonso Ortiz and Brandon Darby 2 Jun 2026 299".*

The `dx-header-line` / `tweet-header-line` rules in `html-to-markdown.ts` do
`textContent.replace(/\s+/g,' ')` — but the source name/handle/time leaf nodes have **no whitespace
between them**, so `textContent` is already glued ("Gigi"+"dergigi.com"). The tweet path fixes this
by reading `.tweet-name`/`.tweet-handle` separately; the generic `dx-header`/`dx-byline`/
`dx-byline-col` path does not.

**Fix:** in the `dx-header-line` rule, collect each **leaf** child's own text and join with a
separator (mirror the `dx-stats-counts` leaf-walk), instead of flattening `textContent`. Same for
YouTube's channel-name/subscriber row (`dx-byline-col` / `dx-byline-row --sub|--author`) — join rows
with " · ". **Verify:** extend `cast-markdown.test.ts` primal card to assert
`**Gigi · dergigi.com · 1 mo.**` (or similar), never `Gigidergigi.com`.

### 3. Duplicate hero image (image-tag hero + inline body image both render)
*Evidence: `bbc--3-cast.png`, `youtube--3-cast.png`, `breitbart--3-cast.png` all show the hero
photo twice at the top.*

`DetailPanel` renders `<img class="longform-hero" src={thumbnail}>` when
`!capture.markdown.includes(thumbnail)`, and `stripLeadingArticleChrome` (events.ts) only strips a
leading hero whose URL **base path** matches the `image` tag. When the inline body image URL differs
from the `image`-tag URL by CDN query params / a different size variant, both checks miss and the
image shows twice. YouTube: the video poster is both the `image` tag and inline.

**Fix (two-sided):** (a) in `events.ts` `pickImageUrl` / `stripLeadingArticleChrome`, compare by
`urlBase()` consistently AND, when the hero also appears inline anywhere in the body (not just
leading), prefer dropping the top hero — the body position is the authored one; (b) in
`DetailPanel`, change `heroInBody` to a `urlBase`-insensitive check (strip query strings on both
sides) so a query-param delta doesn't defeat suppression. **Verify:** `web-cast-render.spec.ts`
already asserts "hero once" for the article card — add a variant where the inline URL has extra query
params, and add a tweet-video variant (poster once).

### 4. Large avatars / logos survive the converter's size filter → full-width
*Evidence: `wikipedia--3-cast.png` (two giant Bitcoin logos stacked at top); `primal--3-cast.png`
(pixelated avatar block at top); `reddit--3-cast.png` (subreddit icon as an image); `bsky--3-cast.png`
(two large avatars).*

The image rule drops `alt="avatar"`, `.dx-avatar`, and images with **both** `width`&`height` ≤72.
Avatars/logos that are rendered larger than 72px on the page (Wikipedia infobox logo, primal's
higher-DPI avatar, a subreddit icon without width attrs) slip through and, lacking any class/size in
markdown, hit the generic `.clip-body img` rule (max-height 420px, block) → full-width.

**Fix:** broaden the drop heuristic in the image rule: also drop images inside a `dx-header` /
`dx-avatar` ancestor regardless of size, drop images whose `data-dx-src`/`src` filename or alt marks
them as an avatar/logo/icon, and raise the bare-size threshold or use the *rendered* size the capture
annotated (the live page's box, already available as width/height attrs on most). Keep real content
images. **Verify:** `cast-markdown.test.ts` — a `dx-header` with a 100px avatar emits no image; a
wikipedia-infobox-logo card emits no top logo.

### 5. Wikipedia infobox (and any `<table>`) flattens to a bare line list
*Evidence: `wikipedia--3-cast.png` — the infobox renders as a long single column of bare terms
("Denominations / Plural / bitcoin / Symbol / ₿ …") instead of a table.*

`html-to-markdown.ts` uses **base turndown with no GFM table plugin**, so `<table>` has no rule and
its cells flatten. The web renderer already loads `remarkGfm`, so a GFM table in the markdown *would*
render — the gap is purely converter-side.

**Fix:** add `turndown-plugin-gfm`'s `tables` (and `strikethrough`) rule to the turndown service in
`html-to-markdown.ts` (add `turndown-plugin-gfm` to `discerned-ext` deps). For infobox-style 2-col
key/value tables consider emitting a definition-style list if GFM tables read poorly. **Verify:** a
table card in `cast-markdown.test.ts` → a `| … | … |` GFM table; `web-cast-render.spec.ts` renders it
as `<table>`.

### 6. Page-chrome leaks into the cast (related/recirculation/tag strips)
*Evidence: `embedded-tweet--3-cast.png` ("More geopolitical stories on ZeroHedge" recirculation with
3 story cards); `breitbart--3-cast.png` (bottom tag/category link list); `reddit--3-cast.png`
("Continue this thread" chrome links per comment).*

`removeGenericChrome()` runs in the capture sanitiser and the **clip** benefits, but the markdown is
converted from the sanitised HTML that still contains some link-dominant recirculation blocks the
clip hides via CSS or that slipped the chrome regexes. The cast has no CSS fallback, so it shows.

**Fix:** strengthen `removeGenericChrome` for the specific patterns seen — "More <topic> stories on
<site>" recirculation headings, trailing tag/category link lists (a `ul`/`nav` of ≥4 short category
links at article end), and Reddit "Continue this thread" / "Continue reading" links (add to
`CHROME_LINK_TEXT_RE`). Prefer general heuristics (link-dominant trailing block) over per-site.
**Verify:** extend `chrome-patterns.html` + `chrome-patterns.test.ts` with a recirculation card + a
trailing tag-list; assert both are removed.

### 7. Image grids/carousels stack as full-width images
*Evidence: `goodreads--3-cast.png` ("Readers also enjoyed" — ~12 covers each full-width);
`youtube--3-cast.png` (poster large twice).*

The clip lays multi-image rails out via `cast-photos` grid / `dx-*` CSS; markdown emits each as a
standalone `![](url)` → the generic img rule stacks them. Lower priority (readable, just long).

**Fix (optional):** drop redundant recommendation-rail images in the converter (they're chrome, per
finding 6 — "Readers also enjoyed" is a recirculation block), or cap the count. Simplest is to treat
the whole "Readers also enjoyed" section as chrome and remove it (finding 6). **Verify:** goodreads
card in `cast-markdown.test.ts` drops the rail.

---

## Cross-cutting recommendation

Findings 1, 2, and 4 share one root cause: **the markdown converter throws away the layout/spacing
signals the clip pipeline computed** (flex separation, dx-avatar/header roles, leaf-level text
boundaries). Rather than re-deriving each heuristic in turndown rules, consider having the converter
consume the **already-annotated** live-DOM markers (`FLEXSEP_MARKER`, `dx-*`, rendered width/height)
that the clip render trusts. That single change (carry markers into the HTML `htmlToMarkdown`
receives, and honor them in the rules) would fix the spacing/avatar/byline classes together and keep
clip and cast in sync as the taggers evolve.

## Run-quality note (not a code bug)

- **medium & stackoverflow could NOT be captured live this session.** Cloudflare's interactive
  Turnstile re-challenges the Playwright-launched Chromium endlessly — clicking the checkbox re-arms
  it (CF fingerprints the automation context regardless of the anti-detection flags). The one profile
  with real `cf_clearance` is the daily Brave `User Data`, which is single-instance-locked while Brave
  runs. Options for a future session: (a) fully quit Brave, then launch Playwright with `brave.exe`
  (`executablePath`) against the warm profile; or (b) **use the offline fixtures** —
  `medium-fixture-visual` / `stackoverflow-question-fixture-visual` run the real capture pipeline
  against committed snapshots with **no Cloudflare**, and could be extended with the same `castShot`
  call to produce a real clip+cast trio (the "source" would be the fixture, not a live fetch).
- **breitbart** DID clear via a headed retry against the warm `test` profile (`PWDEBUG_HEADED=1`).
- Fixture staleness (for the offline-fixture option): `medium-article.html` last touched **2026-06-02**,
  `stackoverflow-question.html` **2026-06-05**. Both are trimmed DOM snapshots (~7–8 KB); the SO one is
  **hand-crafted** (real SO snapshots hit a Cloudflare hard-deny — see `discerned-ext/CLAUDE.md`). They
  exercise the extraction pipeline + `tagStackOverflow`/Medium byline paths but won't reflect a very
  recent site redesign. Refresh via `SNAP=1 --project=snapshot-fixtures` (works for non-hard-denied
  sites) or by hand.

## How to regenerate the evidence

```bash
# One site (swap env var + project per the table in tests/e2e/*-visual.spec.ts headers):
BBC=1 PROFILE=test pnpm exec playwright test -c tests/e2e/playwright.config.ts --project=bbc-visual
# Cloudflare-gated (breitbart, medium, stackoverflow): add PWDEBUG_HEADED=1
# Artifacts land in test-output/{site}-source.png / -rendered*.png / -cast.png
```

## Suggested fix order

1. **Finding 5** (GFM tables) — smallest, self-contained, add a plugin + one test.
2. **Finding 3** (duplicate hero) — 2 small edits (events.ts + DetailPanel), existing spec extended.
3. **Finding 2** (byline glue) — leaf-walk in one converter rule.
4. **Finding 4** (large avatars) — broaden one converter rule.
5. **Finding 6** (chrome leak) — strengthen `removeGenericChrome`, guarded by chrome-patterns.
6. **Finding 1** (bsky facet wall) — the cross-cutting marker-consumption change; do last as it may
   subsume parts of 2 & 4.
7. **Finding 7** — falls out of 6 if "Readers also enjoyed" is treated as recirculation.
