# Discerned test suite

The project has three layers of tests. Each layer catches a different class of bug.

```
discerned-ext/tests/   ← Vitest unit tests (jsdom, no browser)
tests/e2e/             ← Playwright e2e tests (real Chromium + extension)
tests/fixtures/        ← shared HTML fixtures and JSON sidecars
```

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

#### Nostr (`tests/nostr/`)

| File | What it covers |
|---|---|
| `events.test.ts` | **Parametric** over `tests/fixtures/clips/*.json`. Signs each clip with a deterministic key, validates the signature, checks all required tags (`r`, `t`, `client`, `format`, three `L`/`l` label namespaces), format-specific tags (`quote`/`context` for selections; `title`/`image`/`body` for resources), and `created_at` timestamp. Also asserts the factory functions throw when called with the wrong capture format. |
| `round-trip.test.ts` | Serializes each clip fixture twice and asserts tag sets and content are bit-for-bit identical — guards against non-determinism in event construction. |

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

### Core specs (run as part of `pnpm test:e2e`)

| Spec | Project | What it covers |
|---|---|---|
| `extension.spec.ts` | `extension` | Drives each fixture through the real content script via `__DISCERNED_TEST_CAPTURE` postMessage. Asserts the result matches the `.expected.json` sidecar. The main integration test for the capture pipeline end-to-end. |
| `end-to-end.spec.ts` | `extension` | Full pipeline: capture → CLIP handler → IndexedDB → web bridge → `/library` rendering. |
| `web-rendering.spec.ts` | `web` | Injects fixture clips through the real `postMessage` bridge into `/library` and asserts `<ClipRow>` renders correctly. |
| `web-feed.spec.ts` | `web` | Uses `page.routeWebSocket` to mock the Nostr relay and verifies the public feed renders. |

### Fixture-visual specs — pixel baseline regression tests

These specs capture a fixture HTML page through the real extension, render the resulting clip through `/library`, and assert the rendered `.clip-body` matches a committed PNG baseline. A test fails when pixels change unexpectedly — catching CSS regressions, sanitizer changes that drop content, or layout bugs in the `dx-*` class system.

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

#### Site-tagger activated (uses `hostOverride` to fire the per-site tagger)

| Env var | Project | Fixture | hostOverride |
|---|---|---|---|
| `PRIMAL_FIX=1` | `primal-thread-fixture-visual` | `primal-thread.html` | `primal.net` |
| `BSKY_FIX=1` | `bsky-thread-fixture-visual` | `bsky-thread.html` | `bsky.app` |
| `REDDIT_FIX=1` | `reddit-thread-fixture-visual` | `reddit-thread.html` | `www.reddit.com` |
| `YOUTUBE_FIX=1` | `youtube-watch-fixture-visual` | `youtube-watch.html` | `www.youtube.com` |
| `GR_FIX=1` | `goodreads-book-fixture-visual` | `goodreads-book.html` | `www.goodreads.com` |
| `SO_FIX=1` | `stackoverflow-question-fixture-visual` | `stackoverflow-question.html` | `stackoverflow.com` |

**`hostOverride` explained:** site taggers gate on `window.location.hostname`. Fixtures are served from `127.0.0.1`, so taggers don't fire by default. Passing `hostOverride: 'www.reddit.com'` to `runFixtureVisual()` causes the test build's `__setTestHostOverride()` to swap the hostname before capture runs, activating the matching tagger. This is tree-shaken out of production builds.

#### How the fixture-visual pipeline works

1. The spec calls `runFixtureVisual({ site, hostOverride?, ... })` from `helpers/fixtureVisual.ts`.
2. Playwright launches Chromium with the extension loaded, navigates to the fixture URL on the local fixture server (`127.0.0.1:4173`).
3. A `__DISCERNED_TEST_CAPTURE` postMessage drives `captureContext('article')` inside the content script, with optional `hostOverride`. The resulting `Capture` object is returned to the test.
4. A second tab opens `/library` on the Next.js dev server (`localhost:3000`) and the clip is injected via `DISCERNED_BRIDGE_CLIPS` postMessage.
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

```bash
PRIMAL=1 PWDEBUG_HEADLESS_NEW=1 pnpm exec playwright test \
  -c tests/e2e/playwright.config.ts --project=primal-visual
```

Add `PWDEBUG_HEADED=1` instead to watch in a real browser window.

### Probe specs (one-off diagnostics)

Probe specs dump DOM structure, frame lists, or extractor output to `test-output/` for debugging. They don't assert anything visually.

`embedded-tweet-probe`, `breitbart-probe`, `medium-probe`, `tweet-video-probe`, `extractor-frame0-probe`, `extractor-full-probe`, `zh-counters-probe`

### Snapshot / gallery tools (`tests/e2e/tools/`)

| Tool | Purpose |
|---|---|
| `snapshot-fixtures.spec.ts` | `SNAP=1` — Launches Brave with the `test` profile + anti-detection flags, navigates to reddit/youtube/goodreads/stackoverflow, waits for site-specific render anchors, and saves the fully-rendered HTML to `tests/fixtures/sites/`. Run after a site redesign breaks the saved selectors. |
| `snapshot-primal-note.spec.ts` | `PRIMAL_NOTE=1 PWDEBUG_HEADED=1` — Loads a real primal.net note in headed Brave, inlines all images as data URIs (via `page.request.fetch` to bypass CORS), bakes video poster frames, strips scripts, and saves to `tests/fixtures/sites/primal-thread.html`. |
| `snapshot-bsky-post.spec.ts` | `BSKY_POST=1 PWDEBUG_HEADED=1` — Same approach for a Bluesky post thread. Uses `page.request.fetch` (Node.js side) to bypass `cdn.bsky.app`'s CORS restrictions. Saves to `tests/fixtures/sites/bsky-thread.html`. |
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

Covers the Nostr event parser (`parse.test.ts`), the postMessage bridge contract (`bridge.test.ts`), and `<ClipRow>` component rendering (`components/ClipRow.test.tsx`).

---

## Fixtures

```
tests/fixtures/
  sites/    *.html + *.expected.json    — HTML pages used by unit + e2e tests
  clips/    *.json                      — Capture+Evaluation pairs for Nostr tests
```

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
