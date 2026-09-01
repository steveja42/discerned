# Discerned test suite

The project has three layers of tests. Each layer catches a different class of bug.

```
discerned-ext/tests/   ← Vitest unit tests (jsdom, no browser)
discerned-web/tests/   ← Vitest unit tests for the web app
tests/e2e/             ← Playwright e2e tests (real Chromium + extension)
tests/fixtures/        ← shared HTML fixtures and JSON sidecars
```

`tests/e2e/` holds ~70 spec files. Only a handful run by default — the rest are gated behind env vars (listed below) so a normal run stays fast and offline.

---

## Layer 1 — Vitest unit tests

**Location:** `discerned-ext/tests/`  
**Runner:** Vitest + jsdom. No browser, no build step.

```bash
# From the monorepo root:
pnpm test

# From discerned-ext/:
pnpm test
pnpm test --watch
```

The `chrome.*` APIs the capture pipeline calls are shimmed in `tests/setup.ts`. `INLINE_IMAGE` messages return a 1×1 transparent PNG so image inlining completes without a real fetch.

### What is tested

#### Extraction (`tests/extraction/`)

| File | What it covers |
|---|---|
| `article.test.ts` | **Parametric corpus** — one test per `*.html` fixture in `tests/fixtures/sites/`. Each fixture has a `*.expected.json` sidecar specifying format, URL, body-text requirements, and HTML invariants. New fixtures are picked up automatically — add an HTML file + sidecar and a test appears. |
| `bookmark.test.ts` | `captureContext('bookmark')` on several fixtures — title extraction, `og:image` thumbnail, and that `bodyHtml`/`bodyText`/`selectionText` are absent from a bookmark. |
| `selection.test.ts` | Programmatically creates a `Range` with `window.getSelection()`, checks the fragment text, sanitization invariants, `[...]` context separator, and that an empty selection falls back to `'bookmark'` format. |
| `full-page.test.ts` | `captureContext('full-page')` — body present and sanitized, XSS fixture fully stripped. |
| `sanitization.test.ts` | Drives the XSS fixture through `captureContext('article')`. Asserts every injection vector (`<script>`, `<iframe>`, `<form>`, `on*` handlers, `javascript:` URLs) is absent and benign text survives. |
| `shadow-dom.test.ts` | Builds pages with `attachShadow({ mode: 'open' })` in-test. Verifies the capture pipeline descends into open shadow roots, ignores light-DOM chrome (nav/footer), and that `collapseEmpty` + the `dx-header` author-block detector work correctly. |
| `chrome-patterns.test.ts` | The generic chrome strippers in `sanitiseTreeInPlace` — skip-links, share/follow verbs, related-content boxes, newsletter blocks, `dx-stats` dedup. |
| `comment-widget.test.ts` | Viafoura/Disqus-style comment widgets must never win the layout finder or `findArticleElement` (the AP News defect), in both `smartArticleDetection` modes. |
| `tagger-anchors.test.ts` | `checkTaggerAnchors` — each site tagger's selector manifest, and graceful degradation when every anchor is dead. |
| `video-embeds.test.ts` | YouTube/Rumble/Twitch/Facebook iframe embeds → `dx-video-link` cards. |
| `tweet-media.test.ts` | Tweet photo/video extraction and poster substitution. |
| `entity-product.test.ts` | Product/entity pages (Amazon-shaped) — reviews and cross-sell chrome removed without gutting the product block. |
| `feed-narrowing.test.ts` | Narrowing a social feed to the single visible post card. |
| `media-hoist.test.ts`, `blurup-images.test.ts`, `preloaded-next-article.test.ts`, `thumbnail-fallback.test.ts` | Image-selection edge cases: hoisting real media, rejecting blur-up placeholders and preloaded next-article art, thumbnail fallback order. |
| `card-article-and-sponsored.test.ts` | `looksLikeArticleCard` (a "tout" card must not be mistaken for the article) + sponsored-widget removal. |
| `player-controls.test.ts`, `reaction-icons.test.ts`, `zero-width-chars.test.ts`, `htg-md-dump.test.ts` | Assorted regressions: player-widget chrome, reaction sprite sheets, zero-width character stripping, markdown output for a gallery article. |

#### Nostr (`tests/nostr/`)

| File | What it covers |
|---|---|
| `events.test.ts` | **Parametric** over `tests/fixtures/clips/*.json`. Signs each clip with a deterministic key, validates the signature, checks all required tags (`r`, `t`, `client`, `format`, three `L`/`l` label namespaces), format-specific tags (`quote`/`context` for selections; `title`/`image`/`body` for resources), and `created_at` timestamp. Also asserts the factory functions throw when called with the wrong capture format. |
| `round-trip.test.ts` | Serializes each clip fixture twice and asserts tag sets and content are bit-for-bit identical — guards against non-determinism in event construction. |
| `long-form.test.ts` | The companion kind-30023 event — `d`/`title`/`published_at` tags and the `a`-tag coordinate the kind-1 references it by. |
| `cast-markdown.test.ts` | `htmlToMarkdown` — including the rule that publishes an image's real URL and drops `data:` URIs (casts never carry inlined images). |
| `follow-list.test.ts` | kind-3 follow-list construction. |
| `event-fixture-generation.test.ts` | Regenerates the golden event fixtures and asserts they match what's committed — fails if the factory's output drifts. |

#### Background + shared (`tests/background/`, `tests/shared/`)

| File | What it covers |
|---|---|
| `relay-manager.test.ts` | SimplePool wrapper — ACK threshold, timeout handling. |
| `relay-list-fetcher.test.ts` | NIP-65 kind-10002 discovery + the 24 h per-pubkey cache. |
| `relays.test.ts` | `getEffectiveRelays()` — `(mode defaults ∪ user) − removed`, local-mode exclusivity, and the never-empty guarantee. |

### How fixtures are loaded

`tests/helpers/loadFixture.ts` writes the HTML into `document` via `document.open/write/close` and overrides `window.location` with a URL matching the sidecar's `url` field. `tests/helpers/matchExpected.ts` provides the fuzzy assertion helper used by the parametric article test and by Playwright specs.

> **Site taggers** (tagBsky, tagPrimal, tagReddit, …) gate on `window.location.hostname`. Fixtures loaded from `127.0.0.1` do **not** activate them. Tagger testing is handled by the Playwright fixture-visual specs via `hostOverride` (see Layer 2).

---

## Layer 2 — Playwright e2e tests

**Location:** `tests/e2e/`  
**Runner:** Playwright. Launches Chromium with the real extension loaded from `discerned-ext/dist-test/`.

Build the test extension first (only needed once, or after source changes):

```bash
cd discerned-ext && pnpm build:test
```

Then run any spec from the monorepo root:

```bash
pnpm test:e2e
# or target one project:
pnpm exec playwright test -c tests/e2e/playwright.config.ts --project=<project-name>
```

> **Every spec must activate the extension before driving the test bridge.** There is no test-only manifest — specs run against the shipped one, which has no broad host permission, so content scripts are injected per tab on a user gesture. A spec that does `page.goto(...)` and then posts `__DISCERNED_TEST_CAPTURE` fails with **"capture timeout"** because no content script is bound yet.
>
> ```ts
> import { activateExtensionOnTab } from './helpers/activateExtension';
> await page.goto(url, ...);
> await activateExtensionOnTab(ctx, url);   // ← before any postMessage
> ```
>
> Playwright can't click the toolbar icon (browser chrome, not page DOM), so the helper presses the extension's keyboard command (`discerned-activate`, Alt+Shift+Y) over CDP — Chrome treats that as a trusted gesture and grants `activeTab` identically. `runFixtureVisual` already does this for every spec that shares it.

### Core specs (run as part of `pnpm test:e2e`)

| Spec | Project | What it covers |
|---|---|---|
| `extension.spec.ts` | `extension` | Drives each fixture through the real content script via `__DISCERNED_TEST_CAPTURE` postMessage. Asserts the result matches the `.expected.json` sidecar. The main integration test for the capture pipeline end-to-end. |
| `end-to-end.spec.ts` | `extension` | Full pipeline: capture → CLIP handler → IndexedDB → web bridge → `/clips` rendering. |
| `relay-prefs-e2e.spec.ts` | `extension` | A relay edit in the web Settings UI must reach `chrome.storage.local` and change the effective publish set — the round-trip the web-only spec can't cover. |
| `clickjack-guard.spec.ts` | `extension` | `nip07-bridge.ts` must be injected **before** `content.ts`, so the `window.open` guard is armed before the overlay is clickable. Fails if the order is reversed. |
| `web-rendering.spec.ts` | `web` | Injects fixture clips through the real `postMessage` bridge into `/clips` and asserts `<ClipRow>` renders correctly. |
| `web-feed.spec.ts` | `web` | Uses `page.routeWebSocket` to mock the Nostr relay and verifies the public feed renders. |
| `web-cast-render.spec.ts` | `web` | Renders a published cast through `/discerns` against a mocked relay. |
| `web-feedback.spec.ts` | `web` | Drives the `/feedback` form. Stubs both externals — the API route is route-fulfilled and Turnstile is replaced by a token-returning shim — so it never reaches GitHub or Cloudflare. |
| `web-relay-settings.spec.ts` | `web` | Settings → Relays: add/normalise/reject a URL, remove a default, block removing the last one. Forces `relayMode=production` via `addInitScript`, since the dev server otherwise boots in local mode where the list is fixed. |

### Fixture-visual specs — pixel baseline regression tests

These specs capture a fixture HTML page through the real extension, render the resulting clip through `/clips`, and assert the rendered `.clip-body` matches a committed PNG baseline. A test fails when pixels change unexpectedly — catching CSS regressions, sanitizer changes that drop content, or layout bugs in the `dx-*` class system.

Each spec is gated behind an env var so it doesn't run in normal CI but can be run on-demand.

#### Generic pipeline (no site tagger, tests shared CSS + heuristics)

| Env var | Project | Fixture |
|---|---|---|
| `WIKI_FIX=1` | `wikipedia-fixture-visual` | `wikipedia.html` |
| `HN_FIX=1` | `hn-thread-fixture-visual` | `hn-thread.html` |
| `NEWS_FIX=1` | `news-article-fixture-visual` | `news-article.html` |
| `BLOG_FIX=1` | `blog-post-fixture-visual` | `blog-post.html` |
| `SUB_FIX=1` | `substack-essay-fixture-visual` | `substack-essay.html` |
| `GH_FIX=1` | `github-readme-fixture-visual` | `github-readme.html` |
| `TW_FIX=1` | `twitter-thread-fixture-visual` | `twitter-thread.html` |
| `EMBED_FIX=1` | `article-with-embedded-tweet-fixture-visual` | `article-with-embedded-tweet.html` |
| `SHOW_FIX=1` | `tweet-with-show-more-fixture-visual` | `tweet-with-show-more.html` |
| `MED_FIX=1` | `medium-fixture-visual` | `medium-article.html` |
| `BREIT_FIX=1` | `breitbart-fixture-visual` | `breitbart-article.html` |
| `PHPBB=1` | `phpbb-thread-fixture-visual` | `phpbb-thread.html` — the phpBB **engine** tagger matches on markup, not hostname, so it fires with no override |

#### Site-tagger activated (uses `hostOverride` to fire the per-site tagger)

| Env var | Project | Fixture | hostOverride |
|---|---|---|---|
| `PRIMAL_FIX=1` | `primal-thread-fixture-visual` | `primal-thread.html` | `primal.net` |
| `BSKY_FIX=1` | `bsky-thread-fixture-visual` | `bsky-thread.html` | `bsky.app` |
| `REDDIT_FIX=1` | `reddit-thread-fixture-visual` | `reddit-thread.html` | `www.reddit.com` |
| `YOUTUBE_FIX=1` | `youtube-watch-fixture-visual` | `youtube-watch.html` | `www.youtube.com` |
| `GR_FIX=1` | `goodreads-book-fixture-visual` | `goodreads-book.html` | `www.goodreads.com` |
| `SO_FIX=1` | `stackoverflow-question-fixture-visual` | `stackoverflow-question.html` | `stackoverflow.com` |
| `HN_TAG=1` | `hackernews-thread-fixture-visual` | `hackernews-thread.html` | `news.ycombinator.com` |
| `BCT=1` | `bitcointalk-thread-fixture-visual` | `bitcointalk-thread.html` | `bitcointalk.org` |
| `XNEW_FIX=1` | `x-status-newshape-fixture-visual` | `x-status-newshape.html` | `x.com` (Tier 0, not a `SITE_TAGGERS` entry) |
| `YT_VC=1` | `youtube-viewcount-fixture-visual` | `youtube-viewcount.html` | `www.youtube.com` |
| `FB_FIX=1` | `facebook-feed-fixture-visual` | `facebook-feed.html` | `www.facebook.com` |
| `FB_REEL=1` | `facebook-reel-fixture-visual` | `facebook-reel.html` | + `pathOverride` |
| `FB_PHOTO=1` | `facebook-photo-fixture-visual` | `facebook-photo.html` | + `pathOverride` |
| `FB_SHARE=1` | `facebook-share-fixture-visual` | `facebook-share.html` | + `pathOverride` |
| `FB_GROUP=1` | `facebook-group-fixture-visual` | `facebook-group.html` | `www.facebook.com` |
| `FB_FULL=1` | `facebook-fullpage-fixture-visual` | `facebook-feed.html` (full-page format) | `www.facebook.com` |

**`pathOverride`** is the companion to `hostOverride`, needed only by Facebook: `isFacebookPostUrl()` branches on URL *path shape* (`/reel/` vs `/photo/` vs feed), which a fixture served from `127.0.0.1/<name>.html` can't reproduce. Same tree-shaking, same bridge.

**`hostOverride` explained:** site taggers gate on `window.location.hostname`. Fixtures are served from `127.0.0.1`, so taggers don't fire by default. Passing `hostOverride: 'www.reddit.com'` to `runFixtureVisual()` causes the test build's `__setTestHostOverride()` to swap the hostname before capture runs, activating the matching tagger. This is tree-shaken out of production builds.

#### How the fixture-visual pipeline works

1. The spec calls `runFixtureVisual({ site, hostOverride?, ... })` from `helpers/fixtureVisual.ts`.
2. Playwright launches Chromium with the extension loaded, navigates to the fixture URL on the local fixture server (`127.0.0.1:4173`).
3. A `__DISCERNED_TEST_CAPTURE` postMessage drives `captureContext('article')` inside the content script, with optional `hostOverride`. The resulting `Capture` object is returned to the test.
4. A second tab opens `/clips` on the Next.js dev server (`localhost:3000`) and the clip is injected via `DISCERNED_BRIDGE_CLIPS` postMessage.
5. The test clicks the clip row to open the detail panel, waits for `.clip-body` to appear, waits for all `<img>` elements to decode (via `img.decode()`), and pins their dimensions to prevent layout shifts.
6. `toHaveScreenshot()` takes a screenshot of `.clip-body` and compares it against the committed baseline PNG in `tests/e2e/<site>-fixture-visual.spec.ts-snapshots/`.

**Regenerating baselines** after an intentional visual change:

```bash
WIKI_FIX=1 pnpm exec playwright test -c tests/e2e/playwright.config.ts \
  --project=wikipedia-fixture-visual --update-snapshots
```

**Debug artifacts** are written to `test-output/` (gitignored) on every run:
- `<site>-fixture-capture.json` — the captured `Capture` object (with image data replaced by `IMG_INLINED`)
- `<site>-fixture-rendered.png` — a viewport-width screenshot of the rendered clip

### Live visual specs (opt-in, require network)

These load real production URLs, capture through the real extension, and screenshot the result. No pixel baseline — intended for human review while iterating on a tagger.

| Env var | Project | Site |
|---|---|---|
| `PRIMAL=1` | `primal-visual` | primal.net |
| `BSKY=1` | `bsky-visual` | bsky.app |
| `GOODREADS=1` | `goodreads-visual` | goodreads.com |
| `MEDIUM_VISUAL=1` | `medium-visual` | medium.com |
| `BREIT_LIVE=1` | `breitbart-visual` | breitbart.com |
| `TWITTER=1` | `twitter-clip-modes` | twitter.com / x.com |
| `EMBED=1` | `embedded-tweet-visual` | ZeroHedge (blockquote + iframe embeds) |
| `REDDIT=1` | `reddit-visual` | reddit.com |
| `WIKI=1` | `wikipedia-visual` | wikipedia.org |
| `BBC=1` | `bbc-visual` | bbc.com |
| `SO=1` | `stackoverflow-visual` | stackoverflow.com |
| `YT=1` | `youtube-visual` | youtube.com |
| `FB_LIVE=1` | `facebook-visual` | facebook.com (warm profile) |

Every live `*-visual` spec writes **three** screenshots per site to `test-output/`: `{site}-source.png` (the live site), `{site}-rendered.png` (the private **clip**), and `{site}-cast.png` (the public **cast** — the kind-30023 markdown everyone else sees). The cast is built by the extension's own code via the test-only `BUILD_CAST` bridge, then rendered through `/discerns` in a fresh extension-free browser with a mocked relay. This catches cast-only defects that the clip render hides, since the cast body is a lossy markdown conversion. The clip assertions remain the pass/fail gate; the cast render is additive.

```bash
PRIMAL=1 PWDEBUG_HEADLESS_NEW=1 pnpm exec playwright test \
  -c tests/e2e/playwright.config.ts --project=primal-visual
```

Add `PWDEBUG_HEADED=1` instead to watch in a real browser window.

### Corpus sweep (`corpus-sweep.spec.ts`)

`SWEEP=1` drives the whole corpus in `tests/fixtures/corpus-domains.json` through a real capture and scores each rendered clip, writing screenshots + a verdict file to `test-output/corpus-sweep-run/`. It's a **survey**, not a gate — the pixel baselines are the regression floor.

| Env var | Effect |
|---|---|
| `SWEEP_ONLY=a,b` | Only these domains |
| `SWEEP_SKIP=a,b` | Skip these |
| `SWEEP_LIMIT=N` | Cap the domain count |
| `SWEEP_GAP=N` | Seconds between domains (default 20; `0` disables) |
| `SWEEP_UNATTENDED=1` | No prompts for manual gate-clearing |

Two traps worth knowing before reading a sweep result:

- **`SWEEP_GAP` defaults ON for a reason.** Hitting ~10 domains back-to-back from one IP is itself a bot signal, and a block is not recoverable in-run — a Cloudflare "ray id" page is a hard signature the headed retry deliberately won't retry, so the domain is lost. Walls are also **cumulative**: the same URLs that gate at the end of a 189-domain run capture fine in a 1–5 domain run.
- **A low score usually doesn't mean what it looks like.** Reach for the triage probes below before writing a capture fix — guessing the mechanism has produced wrong fixes more than once.

#### Sweep-triage probes

| Probe | Answers | Run |
|---|---|---|
| `tools/finder-diag-probe.spec.ts` | *finder* mode: which content block the layout finder picked and why (per-candidate tag/class/textLen/area/linkRatio). *picker* mode (`DIAG_MODE=picker`): why a discovery seed matched no link — domain rebrand, changed article-ID scheme, wrong hub URL, or a self-inflicted bot wall. | `DIAG=1 --project=finder-diag-probe` |
| `tools/hidden-prose-probe.spec.ts` | Is low text coverage a **paywall** (prose in the DOM but hidden — capture is faithful, don't "fix" it) or a **finder mis-pick** (prose visible, wrong block won)? | `HIDDEN=1 --project=hidden-prose-probe` |
| `tools/clip-width-probe.spec.ts` | Why a rendered clip collapses into narrow columns. Works **offline from a saved HTML file**, so a fix can be iterated without re-hitting a gated site. | `CLIPW=1 CLIPW_DOMAIN=<d> --project=clip-width-probe` |

Chrome must be **fully closed** before these run — they use the warm `Profile 3`, and a live Chrome holds the profile lock.

### Tagger canary (`tagger-canary.spec.ts`)

Site taggers depend on live-DOM selectors a redesign can remove with no warning; capture then silently degrades to the generic pipeline. `CANARY=1 --project=tagger-canary` runs each tagger's selector-anchor manifest against the **live** site and fails naming the exact dead selector. A page that won't load is a SKIP, not a fail, so it never flakes on infra. Report → `test-output/tagger-canary.txt`.

- **Local (full coverage):** `pwsh -File scripts/tagger-canary-local.ps1` uses the warm branded-Chrome `test` profile — the only setup that gets Reddit/YouTube/StackOverflow to load.
- **CI:** `.github/workflows/tagger-canary.yml`, Mondays 08:00 UTC. Covers only the sites that load headless-unauthenticated; the warm profile is gitignored, so CI silently gets an empty one and SKIPs the walled sites.

> A "DEAD anchor" is not always a redesign. A selector that exists on only one of a site's page shapes (primal's thread-only `_primaryNote_` on a profile feed) reports dead on a perfectly healthy site — which is why mutually-exclusive variants are grouped into one comma-separated anchor and each page shape gets its own canary target.

### Probe specs (one-off diagnostics)

Probe specs dump DOM structure, frame lists, or extractor output to `test-output/` for debugging. They don't assert anything visually.

`embedded-tweet-probe`, `breitbart-probe`, `medium-probe`, `tweet-video-probe`, `extractor-frame0-probe`, `extractor-full-probe`, `zh-counters-probe`, `fb-card-probe`, `reel-tree-probe`, `social-tagger-probe`, `feed-post-probe`, `instagram-probe`, `primal-video-probe`, `video-card-geom-probe`

### Snapshot / gallery tools (`tests/e2e/tools/`)

| Tool | Purpose |
|---|---|
| `snapshot-fixtures.spec.ts` | `SNAP=1` — Launches Brave with the `test` profile + anti-detection flags, navigates to reddit/youtube/goodreads/stackoverflow, waits for site-specific render anchors, and saves the fully-rendered HTML to `tests/fixtures/sites/`. Run after a site redesign breaks the saved selectors. |
| `snapshot-primal-note.spec.ts` | `PRIMAL_NOTE=1 PWDEBUG_HEADED=1` — Loads a real primal.net note in headed Brave, inlines all images as data URIs (via `page.request.fetch` to bypass CORS), bakes video poster frames, strips scripts, and saves to `tests/fixtures/sites/primal-thread.html`. |
| `snapshot-bsky-post.spec.ts` | `BSKY_POST=1 PWDEBUG_HEADED=1` — Same approach for a Bluesky post thread. Uses `page.request.fetch` (Node.js side) to bypass `cdn.bsky.app`'s CORS restrictions. Saves to `tests/fixtures/sites/bsky-thread.html`. |
| `snapshot-facebook-post.spec.ts` / `snapshot-facebook-feed.spec.ts` | Snapshot a Facebook permalink or the home feed. fbcdn URLs carry expiring signed tokens (they 403 within days), so every image is baked to a data URI — and the fetch **must** run Node-side via `page.request.fetch()`: an in-page fetch is cross-origin with no CORS header and silently saves 4×3 lazy-load stubs instead. |
| `discover-article-urls.spec.ts` | `DISCOVER=1` — finds a live article URL per corpus domain, using the warm profile so discovered URLs actually load. Also the seed source for the picker-mode probe. |
| `sweep-gallery.mjs` / `live-gallery.mjs` | Build browsable HTML galleries from a sweep or live-visual run. Regenerate after writing any new screenshot, or the gallery shows the stale one. |
| `diff-sweep-run.mjs` / `backup-sweep-run.mjs` / `watch-sweep-run.mjs` | Compare, archive, and live-watch sweep runs. |
| `fetch-avatars.spec.ts` | Utility for refreshing placeholder avatar images in fixtures. |
| `refresh-gallery.py` | Python (Pillow required: `pip install pillow`). Copies all committed pixel baselines to `test-output/baselines-gallery/<site>.png` and crops the top 1200 px of each `<site>-fixture-rendered.png` to `<site>-top.png`. Run after regenerating baselines to get a side-by-side gallery in File Explorer. |

```bash
python tests/e2e/tools/refresh-gallery.py
```

---

## Layer 3 — web app unit tests

**Location:** `discerned-web/tests/`  
**Runner:** Vitest + jsdom

```bash
cd discerned-web && pnpm test
```

| File | What it covers |
|---|---|
| `parse.test.ts` | Nostr event → `ClipData`. Must match the extension's tag conventions exactly. |
| `long-form-parse.test.ts` | kind-30023 parsing and its pairing with the kind-1 note. |
| `bridge.test.ts` | The origin-pinned `postMessage` contract. |
| `filters.test.ts`, `dedup.test.ts`, `authorLabel.test.ts` | Feed filtering, duplicate-cast collapsing, author display-name resolution. |
| `export-utils.test.ts`, `enex-parser.test.ts` | Clip JSON export/import round-trip and Evernote `.enex` parsing. |
| `relay-list.test.ts` | Relay settings logic mirrored from the extension. |
| `useNostrAuth.test.tsx` | Auth state machine — guest / readonly / NIP-07 transitions. |
| `feedback-format.test.ts` | The pure feedback helpers, incl. `@`/`#` neutering that must not mangle emails. |
| `feedback-function.test.ts` | The **real** Netlify function with `fetch` stubbed: honeypot, never-fail-open on a missing Turnstile secret, 400-vs-502 outcomes, GitHub 422 mapping, rate limiting. Used instead of `netlify dev`, which would fight the dev server for port 3000. |
| `support-submit.test.ts` | Submit-path behaviour for the support/donate flow. |
| `components/ClipRow.test.tsx`, `components/PendingSignModal.test.tsx` | Component rendering, incl. the modal that signs casts routed from the extension. |

---

## Fixtures

```
tests/fixtures/
  sites/               *.html + *.expected.json  — 42 HTML pages used by unit + e2e tests
  clips/               *.json                    — Capture+Evaluation pairs for Nostr tests
  events/              *.json                    — golden signed events (see below)
  live-urls.json                                 — targets for the opt-in live suite
  corpus-domains.json                            — the corpus-sweep domain list
```

**Golden event fixtures** carry the stable `DEFAULT_CLIENT_VERSION` placeholder (`0.0.0-dev`), not the real manifest version — the event factory takes the version by injection precisely so a version bump doesn't rewrite all ~20 committed fixtures. `event-fixture-generation.test.ts` fails if the factory's output drifts from what's committed.

The `*.expected.json` sidecars drive the parametric `article.test.ts` and `extension.spec.ts`. Fields:

```jsonc
{
  "format": "article",
  "url": "http://127.0.0.1:4173/my-page.html",
  "title": { "contains": "Some Title" },
  "bodyText": { "minLength": 200, "contains": ["keyword1", "keyword2"] },
  "bodyHtml": { "noScripts": true, "hasImgs": true, "containsClasses": ["dx-header", "dx-stats"] },
  "thumbnail": "present"
}
```

To add a new fixture: drop the HTML + sidecar in `tests/fixtures/sites/` and both the Vitest `article.test.ts` and the Playwright `extension.spec.ts` will pick it up automatically.
