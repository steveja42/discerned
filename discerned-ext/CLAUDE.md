# CLAUDE.md — Discerned 

## Project Overview

Discerned is a Chrome Extension (Manifest V3) that acts as a value attribution layer for the web. Users capture content (selected text or page metadata), evaluate it (a 5-level Signal rating, multi-select Qualifier tags, and a Category), and publish cryptographically-signed signals to the [Nostr](https://nostr.com/) network.

## Tech Stack

| Tool | Version | Role |
|---|---|---|
| TypeScript | 5.3.3 (strict) | Primary language |
| Vite | 5.1.3 | Bundler |
| pnpm | ≥ 8 | Package manager |
| nostr-tools | 2.7.2 | Nostr protocol |
| Vitest | 1.2.2 | Test runner |
| ESLint | 10.0.1 | Linting |

## Commands

```bash
pnpm dev          # Vite watch mode
pnpm build        # tsc + Vite production build
pnpm build:test   # development-mode build → dist-test/ (for Playwright)
pnpm pack:ext     # prod build → dist-pack/, zipped to the web app's public/ for download
pnpm type-check   # tsc --noEmit (strict)
pnpm lint         # ESLint on src/**/*.ts
```

## Dev environment — IMPORTANT for AI assistants

**Assume `pnpm dev` is already running in `discerned-ext/` and `discerned-web/`.** The user keeps both watchers up; they hot-reload `dist/` and the Next.js app on every save. This has two consequences for any work in this repo:

- **Never run `pnpm build`.** It writes production-minified chunks with different hashes into the same `dist/` that `pnpm dev` is watching, leaving the user's loaded Chrome extension with a mismatched `manifest.json` + content-script set. The overlay silently fails to launch until the user kills/restarts `pnpm dev`. To verify TypeScript compiles, use `pnpm type-check`. To pick up your source edits in the user's loaded extension, do nothing — `pnpm dev` writes `dist/` on save, the user reloads the extension + page.
- **Playwright reads `dist-test/`, NOT `dist/`.** When you need to validate via a Playwright spec, run `pnpm build:test` first (it writes only to `dist-test/`, doesn't touch the dev `dist/`). The `tests/e2e/*` specs all load `dist-test/`.

If you ever see an "extension is broken" symptom (overlay missing, bookmark-style 2-line clips when full content was expected), the user accidentally has stale `dist/` — the fix is to **restart `pnpm dev`**, NOT another `pnpm build`. Do not try to "fix" it with a production build.

## Packing the extension for download (`pnpm pack:ext`)

The web app's `/get-extension` page hands users a downloadable **unpacked** extension zip they side-load via `chrome://extensions` → Load unpacked. That zip is produced by `scripts/pack-extension.mjs` (run it as `pnpm pack:ext` from `discerned-ext/`).

What it does:

1. Runs `tsc`, then `vite build --outDir dist-pack --emptyOutDir` — a **production** build into a throwaway `dist-pack/` dir. It builds into `dist-pack/`, **not** the dev `dist/`, precisely so packing never disturbs the extension the user has loaded from `dist/` (same isolation rationale as `dist-test/` — see Dev environment above). `dist-pack/` is gitignored and deleted at the end of the run.
2. Zips the build with `manifest.json` at the **zip root** (not nested in a subfolder) so users select the unzipped folder directly in Load unpacked. Zipping uses the OS-native tool — PowerShell `Compress-Archive` on Windows, `zip` elsewhere — so there's **no extra npm dependency**.
3. Writes the result to `../discerned-web/public/discerned-extension.zip`.

Because the web app is a **static export** deployed by Netlify (which only builds `discerned-web/`, never runs this script), the zip is **committed to git** so Netlify serves it. It does **not** auto-update: after shipping extension changes, re-run `pnpm pack:ext` and commit the refreshed zip. The manifest `version` is read only for the build log line — bump `manifest.json` yourself when cutting a new download.

## Architecture

Three isolated components communicate via `chrome.runtime.sendMessage`:

```
Content Script (src/content/)
  → capture.ts     Smart capture: selected text (quote) or page metadata (resource)
  → overlay.ts     Shadow DOM evaluation UI (DiscernedOverlay custom element)
  → content.ts     Entry; listens for ACTIVATE_DISCERNED messages
  → web-bridge.ts  Runs on discerned.online/* — bridges extension data to the web app

Background Worker (src/background/)
  → background.ts  Handles context menus, signing, relay publishing, IndexedDB
  → relay-manager.ts  SimplePool wrapper; requires ≥ 2 relay ACKs; 10s timeout

Popup (src/popup/)
  → popup.html / popup.ts   Auth status, usage stats, login/export
```

Path alias: `@/*` → `src/*`

## Web-bridge protocol (`src/content/web-bridge.ts`)

Runs exclusively on `discerned.online/*` and `localhost:3000/*`. Bridges the extension's IndexedDB and auth state to the companion web app via `window.postMessage`.

**Size constraint:** `chrome.runtime.sendMessage` has a hard 64 MiB limit. Article clips store large base64 images in `bodyHtml` — sending all clips at once can exceed this. The protocol therefore splits clip data into two phases:

**Phase 1 — clip list (on page load):**
- `GET_CLIPS` response strips `bodyHtml` and `thumbnail` before sending. The web app receives lightweight metadata-only clip objects and can render the clip list, filters, and categories immediately.
- `PUSH_NEW_CLIP` (background → web bridge) also strips those fields for the same reason.

**Phase 2 — body on demand:**
- When the user selects a clip in the library, `DetailPanel` posts `DISCERNED_REQUEST_CLIP_BODY` (with the clip `id`) via `window.postMessage`.
- `web-bridge.ts` forwards this to `background.ts` as `GET_CLIP_BODY`, which reads just that one clip from IndexedDB and returns `{ bodyHtml, thumbnail }`.
- The result is posted back as `DISCERNED_BRIDGE_CLIP_BODY` and stored in `ClipStoreContext.bodies` — a `Map<id, ClipBody>` that acts as a session-level cache. Subsequent selections of the same clip use the cache; no second fetch.

**Content script origin isolation:** `web-bridge.ts` runs in the web page's isolated world (`localhost:3000` or `discerned.online`), NOT the extension's `chrome-extension://` origin. It cannot directly access the extension's IndexedDB. All IndexedDB access must go through `chrome.runtime.sendMessage` to the background worker.

## Key Domain Concepts

- **Quote Capture**: Selected text + 100-char context window, published as Nostr kind 9802
- **Resource Capture**: Page title, URL, OG image, published as Nostr kind 1
- **Clip (🔒)**: Private; stored in IndexedDB (kind 30078 planned)
- **Cast (📡)**: Public; published to Nostr relays
- **Evaluation**: Signal (5 levels, Toxic→Masterpiece, optional — absent = unrated) · Qualifiers (multi-select tags, built-in + custom) · Category (7 built-in options + custom)
- **Auth modes**: NIP-07 (browser extension wallet), Local (no cast), NIP-46

## NIP-07 signing architecture

**Kind-1 (cast) must always be signed via the discerned web app**, not from the current tab's origin. The reason: NIP-07 wallets (Alby, nos2x) maintain per-origin approval lists. If a cast is signed on `example.com`, the wallet prompts the user to approve `example.com` — a different approval from `discerned.online`. By routing kind-1 through the web app, the user only ever approves `discerned.online` once and all subsequent casts from any site sign without additional prompts.

**Kind-0 (NIP-05 profile)** can be signed directly via `signWithSigningTab` — it's triggered post-cast when a discerned tab is already open and the wallet has just approved it.

**Implementation**: `handleCast` in `background.ts` calls `signEventViaWebApp()` for NIP-07 (pro) casts. This opens/focuses a discerned tab, posts a `DISCERNED_BRIDGE_PENDING_SIGN` message through the web-bridge, and waits for the user to click Confirm in `PendingSignModal` (mounted in `discerned-web/app/layout.tsx`). `signEvent()` is used for kind-0 and for nip46/nsec casts.

**Do not remove the web-app routing for kind-1 casts.** The `sendToBackground` timeout for CAST in `content.ts` is 150s (not 30s) so the user has time to confirm the modal.

## Capture pipeline (`src/content/capture.ts`)

`captureContext(format)` branches by `ClipFormat`. For `'article'` (the rich-content path), extraction runs in tiers, first match wins:

- **Tier 0 — Twitter/X**: `extractTweet()` builds a clean tweet card. The same function is reused by `full-page` and `selection` formats on twitter.com / x.com (a `format` parameter controls how the resulting card is plumbed into the Capture shape — `bodyHtml` for article/full-page, `selectionText` for selection). `extractTweetBlock()` and `extractTweet()` each try `data-testid` selectors first (legacy X DOM), then fall back to newer-shape equivalents (`article[data-tweet-id]`, plain `<a href="https://x.com/<handle>">` links for name/handle/avatar, `button[aria-label="Reply"|"Repost"|"Like"|"Bookmark"]` + sibling count buttons for stats, `div[dir="auto"]` for body text) — X has redesigned this markup before with no warning, dropping every `data-testid` hook at once, which silently degrades Tier 0 to the generic layout finder (avatar/date/stats end up beside the content instead of in a proper header/footer). `isTweetHost()` gates Tier 0 on the real page URL (`testHostOverride` can also satisfy it, for fixture-visual specs — unlike `SITE_TAGGERS`, which only need a hostname override).
- **Site taggers** (`applySiteTagger()`): before the tiers below, a per-site live-DOM tagger (if one matches the hostname) stamps `dx-*` class markers on the page so the captured HTML carries layout hints across sanitisation. When a site tagger runs, the generic semantic tagger is skipped (`siteTaggerActive`).
- **Tier 1 — semantic element**: `findArticleElement()` picks `<article>`/`<main>`/`[role=...]` when present.
- **Tier 1.5 — layout finder**: `findContentBlockByLayout()` scores every block by visual area + text density − link/button density, then `maybeExpandToFeed()` widens to a feed/thread parent. This is what makes div-soup SPAs (Nostr clients, Mastodon, Bluesky, Reddit) capture the right content.
- **Tier 2 — Readability**: Mozilla Readability for blog/news pages.
- **Tier 3 — full body**: last resort.

All tiers clone the live DOM, run `tagSemanticStructure()` (generic) or rely on the site tagger's markers, then `sanitiseTreeInPlace()`, then `inlineAllImages()` (round-trips images through the background's privileged fetch → base64).

### Capture quality philosophy

**The captured clip should visually match what the user saw on the source site** — not a generic reformatted version. Title, byline, avatar, hero image, body paragraphs, engagement counts should land in roughly the same positions and proportions as on the live page. Pixel-perfect isn't the goal; **recognisable shape** is.

When working on capture quality:

1. **General solutions take precedence over per-site ones.** A new heuristic in `tagSemanticStructure()` or the pipeline (e.g. `dedupAdjacentImages`, `stripPageChrome`, the avatar-min-px guard) that fixes class N sites is worth more than a single tagger that fixes one. Before reaching for a per-site tagger, ask: is the problem a *pattern* (gallery-looks-like-avatar, blur-up-preview-image triplet, sidebar-without-aside) or *truly* unique to one site? Generic fixes go in `capture.ts` outside `SITE_TAGGERS`. Per-site taggers exist for irreducibly bespoke layouts (Reddit's `shreddit-comment` slot model, YouTube's player widget).
2. **Don't break previously-working sites.** Run the pixel-baseline fixture specs (`medium-fixture-visual`, `breitbart-fixture-visual`) after any change to shared CSS, sanitiser logic, or generic taggers. They live in `tests/e2e/*-fixture-visual.spec.ts-snapshots/` and fail on visual diff. Update baselines (`--update-snapshots`) only when the change is *intentionally* visual. Also re-run the live visual specs for any site you've previously optimized (table below) and human-eyeball the screenshot.
3. **Always visually verify after structural changes.** Type-check + unit tests catch syntax / behaviour bugs but miss "wrong selector picked the avatar-wrapping anchor instead of the channel-name anchor" and "element got dropped before postClone could see it." After any pipeline change, run the relevant `*-visual` Playwright spec and `Read` the rendered PNG before reporting done. See [memory: feedback_visually_verify_after_refactor].

### Optimized sites — visual reference points

The clip should approximate the **content** column of the source site (title, byline, hero, body, comments). Side rails, action toolbars, sponsored chrome, and engagement panels are dropped.

| Site | Tagger | postClone | Visual target | Test spec |
|---|---|---|---|---|
| **primal.net** | `tagPrimal` | — | Single note OR thread with avatar + author header + zaps + stats per post. Quote-notes render as bordered cards. | `primal-visual` (live), `primal-thread-fixture-visual` (fixture, **pixel baseline** — runs `tagPrimal` via `hostOverride`; fixture is a real snapshotted note with all avatars + video poster baked in as data URIs) |
| **bsky.app** | `tagBsky` | — | Profile feed or thread with 44px round avatar pin + name/handle row + body + reply/repost/like row per post. | `bsky-visual` (live), `bsky-thread-fixture-visual` (fixture, **pixel baseline** — runs `tagBsky` via `hostOverride`; fixture is a real snapshotted thread with all avatars baked in as data URIs via Node.js-side fetching to bypass CORS) |
| **goodreads.com** | `tagGoodreads` / `tagGoodreadsList` | — | Book hero (cover + title + author + 5-star rating + genres pills + "About the author" card). List pages render as a 2-col grid. | `goodreads-visual` (live), `goodreads-book-fixture-visual` (fixture, **pixel baseline** — runs `tagGoodreads` via `hostOverride`) |
| **twitter.com / x.com** | (Tier 0 `extractTweet`) | — | Single tweet card with avatar + author + body + photos/video poster + footer (date/views/stats). Embedded tweets on news pages also use this. | `twitter-clip-modes` (live), `embedded-tweet-visual` (live), `twitter-thread-fixture-visual` + `tweet-with-show-more-fixture-visual` (fixtures, **pixel baselines** — generic pipeline only, legacy-shape markup), `x-status-newshape-fixture-visual` (fixture, **pixel baseline** — real Tier 0 path via `hostOverride: 'x.com'`, redesigned/newer DOM shape, `article.test.ts` corpus also covers it in Vitest) |
| **medium.com** | (generic byline) | — | Title + author avatar header + "N min read · date" meta + body. Engagement glyph rows preserved. | `medium-fixture-visual` (fixture, **pixel baseline**), `medium-visual` (live, behind Cloudflare) |
| **breitbart.com** | (generic byline + chrome strip) | — | Title + byline + hero image + body + embedded tweets rendered as tweet-cards (wrapper-iframe pattern). | `breitbart-fixture-visual` (fixture, **pixel baseline**), `breitbart-visual` (live), `article-with-embedded-tweet-fixture-visual` (fixture, **pixel baseline** — blockquote-fallback embed path) |
| **zerohedge.com** | (generic byline + engagement-row tagger) | — | Title + byline + body + right-aligned footer engagement counters. Embedded tweet iframes harvested into tweet-cards. | `embedded-tweet-visual` (live) |
| **stansberryresearch.com** | (generic, with shadow DOM piercing) | — | Author block (avatar + name) + article body, captured across declarative open shadow roots. | covered by `shadow-dom.test.ts` unit tests |
| **wikipedia.org** | (generic + `stripPageChrome`) | — | Article title + `<p>` body + infobox table + section headings. TOC sidebar and references-box pruned via `stripPageChrome`. | `wikipedia-visual` (live), `wikipedia-fixture-visual` (fixture, **pixel baseline**) |
| **bbc.com/news** | (Tier 1 `<article>`) | — | Title + byline + date + hero image + body paragraphs. No tagger needed; `<article>` semantics suffice. | `bbc-visual` (live), `news-article-fixture-visual` (fixture, **pixel baseline** — generic `<article>` Tier 1 path) |
| **reddit.com** | `tagReddit` | `postCloneReddit` | Subreddit avatar (round, left) + 2-row column right of it (subreddit · time on row 1, author on row 2) + title + post body or image + comments with avatar / dx-byline / action row each. Sidebar rails, "Back" button, ads dropped. | `reddit-visual` (live), `reddit-thread-fixture-visual` (fixture, **pixel baseline** — runs `tagReddit` + `postCloneReddit` via `hostOverride`) |
| **youtube.com** | `tagYoutube` | `postCloneYoutube` | Channel avatar (round, left) + 2-row column right of it (channel name on row 1, "N subscribers" on row 2) + poster image (from `i.ytimg.com/.../hqdefault.jpg` or live `<video poster>`) + title + views/date + description + comments. Up-Next sidebar, action strip, chapter shelves dropped. | `youtube-visual` (live), `youtube-watch-fixture-visual` (fixture, **pixel baseline** — runs `tagYoutube` + `postCloneYoutube` via `hostOverride`) |
| **stackoverflow.com** | `tagStackOverflow` | — | Question + each answer as separate dx-post, code blocks preserved, user-info cards as dx-byline, post-menu as dx-stats. Cloudflare-walled — use the `test` persistent profile. | `stackoverflow-visual` (live, persistent profile), `stackoverflow-question-fixture-visual` (fixture, **pixel baseline** — runs `tagStackOverflow` via `hostOverride`; fixture is hand-crafted because real SO snapshots hit a Cloudflare hard-deny) |
| **Hacker News** (generic) | (none — `<article>` Tier 1) | — | Title + body. | `hn-thread-fixture-visual` (fixture, **pixel baseline**) |
| **Substack** (generic) | (none — `<article>` Tier 1) | — | Title + body + thumbnail. | `substack-essay-fixture-visual` (fixture, **pixel baseline**) |
| **GitHub README** (generic) | (none — `<article>` Tier 1) | — | Title + headings + code blocks. | `github-readme-fixture-visual` (fixture, **pixel baseline**) |
| **Generic blog post** | (Readability) | — | Title + body paragraphs (fallback path). | `blog-post-fixture-visual` (fixture, **pixel baseline**) |

When adding a new site, **add a row here** and a visual spec under `tests/e2e/{site}-visual.spec.ts`. For sites that have a deterministic fixture (a saved HTML file under `tests/fixtures/sites/`), also add a `{site}-fixture-visual.spec.ts` with a `toHaveScreenshot()` pixel baseline — those guard against shared-CSS / generic-tagger regressions for free.

**Activating site taggers under fixtures** — site taggers gate on `window.location.hostname`, which means they don't fire on 127.0.0.1-served fixtures by default. The test build exposes `__setTestHostOverride(host)` in `capture.ts` (tree-shaken in production via `__DISCERNED_TEST_BUILD__`), and the dev test bridge in `content.ts` reads `opts.hostOverride` from `__DISCERNED_TEST_CAPTURE` messages and feeds it through. Fixture specs pass `hostOverride: 'www.reddit.com'` (etc.) to `runFixtureVisual()` to exercise the real tagger + `postClone` logic against the saved snapshot. See `reddit-thread-fixture-visual.spec.ts`, `youtube-watch-fixture-visual.spec.ts`, `goodreads-book-fixture-visual.spec.ts`, `stackoverflow-question-fixture-visual.spec.ts` for the pattern. Tier 0 (Twitter/X) is the one non-`SITE_TAGGERS` consumer of this override: `isTweetHost()` also honours `testHostOverride`, since Tier 0 gates on the full page URL rather than hostname alone — `hostOverride: 'x.com'` makes a 127.0.0.1-served fixture exercise the real `extractTweet()` path. See `x-status-newshape-fixture-visual.spec.ts`.

**Refreshing real-page snapshots** — Several one-shot snapshot tools exist under `tests/e2e/tools/`:

- `snapshot-fixtures.spec.ts` (`SNAP=1`) — Launches Brave with the `test` persistent profile + anti-detection flags, navigates to reddit/youtube/goodreads/stackoverflow, waits for site-specific render anchors (`shreddit-post`, `ytd-watch-flexy`, etc.), and saves the fully-rendered HTML to `tests/fixtures/sites/`. Re-run when a site redesign breaks the saved selectors. **Cloudflare hard-denies** cannot be worked around — for SO the fixture is hand-crafted instead.
- `snapshot-primal-note.spec.ts` (`PRIMAL_NOTE=1 PWDEBUG_HEADED=1`) — Loads a specific primal.net note in headed Brave. Inlines all `<img>` bytes as data URIs (via in-page `fetch` with `credentials: 'omit'`; large images/GIFs are downscaled to 256 px via `OffscreenCanvas`), bakes `<video>` poster frames (fetches video bytes → blob URL → untainted canvas), strips scripts/external links, and writes to `tests/fixtures/sites/primal-thread.html`.
- `snapshot-bsky-post.spec.ts` (`BSKY_POST=1 PWDEBUG_HEADED=1`) — Same shape for a Bluesky thread. `cdn.bsky.app` blocks CORS from the page context, so images are fetched on the **Node.js side** via `page.request.fetch()` (uses the browser's cookies/headers, no CORS enforcement), then injected back as data URIs via `page.evaluate()`. Writes to `tests/fixtures/sites/bsky-thread.html`.

After regenerating baselines, run `python tests/e2e/tools/refresh-gallery.py` (requires Pillow: `pip install pillow`) to rebuild `test-output/baselines-gallery/` — it copies every committed baseline and crops the top 1200 px of each `*-fixture-rendered.png` for a quick side-by-side gallery in File Explorer.

### Per-site taggers + `dx-*` markers

`SITE_TAGGERS` is a registry of `{ match: (host) => bool, tag: (root) => void, postClone?: (clone) => void }`. Each tagger walks the **live** DOM with selectors stable for that site (data attributes or class-name *prefixes* like `[class*="_primaryNote_"]`, since SPA class hashes change between builds) and stamps `dx-*` classes:

| Marker | Meaning |
|---|---|
| `dx-post` | the primary captured post |
| `dx-reply` | a reply in a thread |
| `dx-reply-row` | a reply's avatar + (name/body) split (flex row) |
| `dx-header` | avatar + name row |
| `dx-author` | inline username + verification + handle + time |
| `dx-byline` | avatar-LESS byline strip (news sites): `<address>` or author-link `<a>` + `<time>` + short text |
| `dx-byline-meta` | meta strip like "25 min read · May 26, 2026"; tagger MOVES it into dx-header's name column |
| `dx-quote` | a quoted/embedded note card (bordered) |
| `dx-quote-frag` | one `<a>` fragment of a quote (sites split a quote across sibling `<a>`s) |
| `dx-zaps-row` | horizontal zappers row |
| `dx-stats` | reply/like/repost icon row |
| `dx-stats--end` | right-aligned stats variant for footer engagement counters (footerStat-class siblings) |
| `dx-avatar` | round 44px pin on a small image (subreddit icon, channel avatar, comment avatar). CSS clips to circle. |
| `dx-byline-col` | column holding two stacked byline rows (subreddit/channel on top, author/subscribers below). Built by `postClone` on Reddit / YouTube. |
| `dx-byline-row` | one row inside a `dx-byline-col`. Variants `--sub` (bold, primary) and `--author` (muted, secondary). |
| `dx-excl` | element to remove during capture. Promoted to `EXCL_MARKER` by the pipeline, dropped by `removeMarked` before sanitisation. |

The matching layout CSS lives in `discerned-web/app/globals.css` under `.clip-body .dx-*`. **To add a site**: copy `tagPrimal`, swap the selectors, register it in `SITE_TAGGERS`. No web-app change needed unless the site has a new layout quirk.

A tagger may optionally **return a capture root** (`Element | void`). When it does, `extractArticle` captures that subtree instead of running the generic article/layout finders — use this to scope the clip to the content column and exclude page chrome (sidebars, search, banners). Returning nothing leaves root selection to the pipeline (still stamping markers).

`tagPrimal` (primal.net) is the reference implementation. `tagBsky` (bsky.app) is a second example: it tags each `[data-testid^="feedItem-by-"]` post (`dx-post` + `dx-header` + `dx-stats`) and returns the `profileScreen` column as the capture root. Bluesky positions content with inline `transform`/`position`/`aspect-ratio` that survive sanitisation (only `<img>` styles get scrubbed); `globals.css` neutralises those inside `.clip-body` so the dx-* layout takes over.

#### Live tagger MUST be non-destructive — use `postClone` for mutations

The tagger function runs on `document` (the **live** page). It should only **read** structure and **stamp classes** — never call `replaceWith()`, `remove()`, `insertBefore()`, or otherwise reparent nodes on the live DOM. Doing so leaks into the user's actual session: YouTube's player will stop responding to navigation, Reddit's SPA loses sync with framework state, Goodreads's lazy-loaded sections may not render.

For any destructive change (rebuilding the byline column, swapping `#player` for a `<figure>` poster, hoisting an avatar out of a soon-to-be-excluded `<a>` wrapper), register a `postClone(clone: Element)` callback in `SITE_TAGGERS`. It runs on the **detached clone** that `extractArticle` builds, before `removeMarked`/sanitisation — so it can lift content out of `dx-excl`'d wrappers before they're pruned. See `postCloneReddit` and `postCloneYoutube` for the pattern.

Order matters: `extractArticle` does `deepCloneWithShadow → siteTaggerPostClone → removeMarked → sanitiseTreeInPlace → inlineAllImages`. Anything you want to use that's normally dropped (e.g. an avatar inside a dx-excl'd anchor) needs to be hoisted out *during* `postClone`, before `removeMarked` runs.

**The site tagger runs for ALL three article-like formats** — `article`, `selection`, AND `full-page`. The shared helper `applyTaggerToClone(cloneOrFragment)` is called from each of those extractors: it promotes `dx-excl` classes to `EXCL_MARKER` on the clone, runs the site-tagger's `postClone` hook (if any), then calls `removeMarked` to drop excluded subtrees. Selection and full-page also share `tagSemanticStructure` and `dedupAdjacentImages` (for the dx-byline / chrome-link / triple-image patterns). When you write or fix a site tagger, expect it to apply to all three formats — write selectors that locate semantic landmarks (`shreddit-post`, `ytd-video-owner-renderer`) rather than ones that assume the user captured the whole page.

When defining `postClone` for a site, ALSO keep important elements off the `dx-excl` list inside the live tagger — otherwise they're dropped from the clone before `postClone` can transform them. Example: `tagYoutube` skips `#player`, `#player-container`, `ytd-player` in its `excludeNonKept` pass so `postCloneYoutube` can swap the player for the poster figure.

### Generic byline + chrome detection

`tagSemanticStructure()` has several **generic** passes that handle news + blog sites without needing per-site code. Most modern news sites and WordPress blog layouts work out of the box.

- **Chrome-link removal** — drops empty `<a>` elements pointing at `google.com/preferences`, `facebook.com/share`, `x.com/share`, `mailto:?`, `whatsapp:`, etc. Removes the gray-oval "Make this site a preferred Google source" buttons and bare share icons that survived sanitisation.
- **Audio widget removal** — drops `[data-mp3u]`, `input[type="range"]`, and walks up to `[class*="amplitude" i]` / `[id*="Polly" i]` wrappers. Removes Polly TTS / Amplitude.js article-narration scrubbers.
- **`dx-byline`** — avatar-less byline detection: an element with `<address>` OR author-link `<a>` + `<time>` + short total text (< 200 chars), no img descendants. Walks elements in reverse so the deepest (tightest) match wins. CSS lays it out as a single muted flex row.
- **`dx-byline-meta`** — meta strip matching `\d+ min read` or month-name+day pattern, found in dx-header's next-sibling subtree. The tagger MOVES it into dx-header's name column so it shares row with the author name. Skipped inside `.tweet-card` so tweet-card footers aren't repurposed as byline meta.
- **`dx-stats--end`** — right-aligned variant for footer engagement counters: 2+ siblings whose class names match `/footerStat\|engagement[A-Z_]\|node[-_]?stat/i`.
- **dx-class preservation on unwrap** — `sanitiseElement` promotes non-allowed tags (`<footer>`, `<header>`, `<address>`, etc.) to `<div>` when they carry trusted `dx-*` / `tweet-*` classes, instead of unwrapping them. Without this, stamping `dx-stats` on a `<footer>` would lose the class when sanitisation deleted the `<footer>`.

Container heuristic relaxed: `looksLikeContainer()` no longer rejects an `<article>` element just because it contains a direct `<header>` or `<footer>` child — news sites legitimately use that semantic pattern.

### Embedded tweets on third-party sites

Article captures detect and render embedded tweets from third-party pages (ZeroHedge, Breitbart, news blogs) as rich `tweet-card` blocks matching Tier 0's output.

**Pipeline** — `harvestEmbeddedTweets()` runs on the live DOM **before any clone**, returning `Map<tweetId, EmbeddedTweetData>`:
1. Parse every `<blockquote class="twitter-tweet">` (including hidden ones widgets.js leaves behind) for the static fallback data.
2. Round-trip through the background: `chrome.webNavigation.getAllFrames({ tabId })` enumerates ALL frames in the tab (including nested ones), filtered to `platform.twitter.com/embed/Tweet.html`. `chrome.scripting.executeScript({ target: { tabId, frameIds }, func: extractFromTweetEmbed })` injects an extractor that reads the rendered tweet DOM (avatar, author, text, photos, video poster, date, verified badge, "Show more" anchor). Iframe data wins over blockquote data when both are available.
3. 1-second timeout budget so a stuck iframe doesn't hang the capture.

**Substitution** — `substituteEmbeddedTweets(clone, harvested)` walks the cloned subtree and replaces:
- `iframe[id^="twitter-widget"]` — standard widgets.js render
- `iframe[src*="platform.twitter.com/embed"]` — direct platform embed
- `iframe[data-tweet-id]` — pre-tagged
- **Host-page wrapper iframes** — Breitbart pattern: `iframe[src*="/tweet-N.html#TWEET_ID"]` where the tweet ID is in the URL **fragment** (and may have a `-onlyvideo` suffix for video-only mode). Detection regex: `\/(tweet|status|x-embed)[^\/]*\.html#`.
- `blockquote.twitter-tweet` — static fallback

For each match: extract tweet ID, look up `harvested.get(id)`, `replaceWith()` a full `tweet-card--embed` div or a stub "View on X" card. Dedupes by tweet ID so a hidden blockquote + visible iframe for the same tweet produces ONE card.

**Required permissions** in `manifest.json`: `scripting`, `webNavigation`, `host_permissions: ["<all_urls>"]`.

**`-onlyvideo` mode** — Breitbart's wrapper iframes can request video-only rendering with `#TWEET_ID-onlyvideo`. In that mode the platform.twitter.com iframe has no avatar container, no `tweetText`, no profile link. `extractFromTweetEmbed` resolves `statusUrl` and `tweetId` FIRST, then derives `handle` from the URL path `/{handle}/status/` when the avatar container is absent. Display name falls back to handle. The video poster from `<video poster=>` flows through `videoInfos[].poster` → `buildVideoHtml` and renders as a `tweet-video` link card with play overlay.

**"Show more" link** — long tweets append `<a data-testid="tweet-text-show-more-link">` inside `tweetText`. The extractor preserves the anchor but rewrites its href from the Twitter signin-redirect chain to the canonical `https://x.com/.../status/...` URL, and prepends a regular-space text node (X's `<span>&nbsp;</span>` separator gets dropped during sanitisation because `trim()` strips U+00A0).

### Sanitisation

`sanitiseTreeInPlace()` whitelists tags (`ALLOWED_TAGS` — includes `div, span, img, table, svg` glyphs, etc.) and per-tag attributes (`ALLOWED_ATTRS_PER_TAG`). The `class` attribute is allowed but **only tokens with `dx-` or `tweet-` prefixes survive** (`TRUSTED_CLASS_PREFIXES`); source-page hashed classes are stripped. This is how the `dx-*` markers reach the rendered clip while the page's own CSS classes don't.

### Shadow DOM support

Some sites (Stansberry's Angular app is the reference case) ship article content via declarative open Shadow DOM (`<template shadowrootmode="open">`). `document.querySelector` and `window.getSelection` don't pierce shadow boundaries, and `cloneNode(true)` doesn't clone a host's shadow root — so the capture pipeline must descend manually wherever it touches the live DOM.

Five helpers at the top of `capture.ts` handle this:

| Helper | Used by |
|---|---|
| `hasOpenShadow(el)` | Type guard for the others. Returns false for closed-mode hosts (unreachable). |
| `querySelectorAllDeep(root, sel)` | `findArticleElement`, `findContentBlockByLayout`, `annotateLiveImageSizes`, `markExcluded` (cleanup). Live-DOM content discovery. |
| `forEachDeepElement(root, fn)` | `markExcluded`, `getActiveSelection`. Walks every element including shadow descendants. |
| `deepCloneWithShadow(src)` | The three clone steps in `extractArticle` (Tier 1 + 1.5), `cloneBodyClean`, `parseReadability`. Inlines open shadow content as ordinary children of the host clone so downstream walkers (`sanitiseTreeInPlace`, `tagSemanticStructure`, per-site taggers) work without modification. |
| `getActiveSelection()` | `hasSelection`, `extractSelection`. Uses the spec API `Selection.getComposedRanges({ shadowRoots })` (Chromium 134+) to retrieve selections that cross shadow boundaries, then converts the resulting `StaticRange` to a live `Range` so `cloneContents()` works in the existing pipeline. Falls back to `window.getSelection()` when `getComposedRanges` is unavailable, with an `LL.WARN` diagnostic when open shadow roots are present but the API is missing. |

**Closed shadow roots** are inaccessible to extensions. `hasOpenShadow` returns false for them; content there cannot be captured. We don't try to count them — there's no reliable in-page detection (heuristics produce too many false positives on empty placeholder custom elements).

**`<slot>` projection is NOT performed.** `deepCloneWithShadow` places light-DOM children before inlined shadow children, which is approximately right for most widgets and exactly right for widgets that render content straight into the shadow (no slots). If a site uses slots, add a site-specific tagger that handles the composition.

**Selection snapshot.** `hasSelection()` clones the live `Range` into a module-level `selectionSnapshot` when it returns true. `extractSelection()` falls back to that snapshot when the live `Selection` has been cleared between the user triggering the overlay and clicking Capture — a pattern observed on shadow-root content (e.g. Stansberry's Angular widgets) where appending the overlay shadow-DOM steals focus and collapses the selection on the page. The snapshot is consumed (set to `null`) at the start of `extractSelection` whether or not it's used, so a stale snapshot from a prior capture can't bleed in.

**Diagnostic logs** fire only when shadow roots are present (kept quiet on the common no-shadow case):
- `LL.NORMAL`: `Discerned: N open shadow root(s) detected on page` (once per article/selection capture)
- `LL.DEBUG`: `Discerned: layout finder winner is inside shadow root of <host-tag>` and `Discerned: selection found inside shadow root of <host-tag>`
- `LL.DEBUG`: in `extractSelection`, per-stage fragment-size logs (`after cloneContents+wrap`, `after unmarkWrappers`, `after removeMarked`, `after substituteVideos`, `after sanitizeFragment`, `after inlineAllImages`) so when a selection clip comes out empty the page console pinpoints which stage dropped the content.

## File Naming Conventions

- **No `index.ts` entry points** — name entry files after their directory (e.g., `background.ts`, `content.ts`, `popup.ts`)

## Coding Conventions

- **TypeScript strict mode** — no `any`, no unused vars/params (tsconfig enforces both as errors)
- **Vanilla TypeScript** — no React or UI frameworks; Shadow DOM for style isolation
- **HTML sanitization** — tag/attribute whitelist in `ALLOWED_TAGS` / `ALLOWED_ATTRS_PER_TAG` (see Sanitisation section below); `class` kept only for `dx-*`/`tweet-*` tokens (XSS prevention)
- **WSS only** — never use unencrypted WebSocket for relay connections
- **No source maps** in production builds

## Logging / Debug Bridge

All console output is centralised via `src/shared/logger.ts` using **function overriding**.

### How it works

Each non-background entry point calls `initLogBridge(source)` at module top-level:

```ts
// content.ts, popup.ts, onboarding.ts
import { initLogBridge } from '@/shared/logger';
initLogBridge('content'); // or 'popup' | 'onboarding'

// background.ts (called before any other code)
import { initLogBridge } from '@/shared/logger';
initLogBridge('background');
```

### Log flow per context

| Context | Destination | Mechanism |
|---|---|---|
| `content` / `onboarding` | Page console (VSCode debug session) | Already in page context; override just adds `[source]` prefix |
| `popup` | Page console (VSCode debug session) | `chrome.tabs.sendMessage → LOG_RELAY` to active tab |
| `background` | Page console (VSCode debug session) | `chrome.tabs.sendMessage → LOG_RELAY` to active tab |

`LOG_RELAY` messages land in the content script's `onMessage` handler, which calls `relayLog()` — a function that uses the **pre-override** originals to avoid double-prefixing.

### Toggle for Web Store release

```ts
// src/shared/logger.ts — line 1 of config
const REMOTE_LOGGING = true;   // ← set to false before publishing
```

When `false`, the bridge is a no-op; only the local `console` call fires in each context.

### Rules

- **Never** add `console.log` to `logger.ts` itself (causes recursion)
- All `LOG_RELAY` forwarding is fire-and-forget — failures are silently swallowed
- The `originals` snapshot in `logger.ts` must be taken **before** any override runs; `relayLog()` depends on it

## Logging Rules

- **Never use `console` directly** — always call `log(LOG_LEVEL.X, ...)` from `src/shared/logger.ts`
- Import both `log` from `@/shared/logger` and `LOG_LEVEL` from `@/shared/types`
- **Always include the URL** in log calls: pass `'url:', capture.url` (or `window.location.href` when no capture is in scope)
- Levels: `TRACE=0`, `DEBUG=1`, `NORMAL=2`, `WARN=3`, `ERROR=4` — filtered by `activeLogLevel` (default `TRACE`)
- Call `setLogLevel(LOG_LEVEL.WARN)` before publishing to Web Store to suppress verbose output

## Security Rules

- All user-supplied HTML must pass through `sanitizeHtml()` in `src/content/capture.ts`
- Shadow DOM isolation is required for all injected UI

## Current Status (MVP / Phase 1)

- NIP-44 encryption: stubbed, not fully implemented
- NIP-46 login: implemented
- No retry logic for failed relay publishes
- Firefox support: not targeted yet
- Tests: Vitest configured but coverage is minimal

## File Layout

```
src/
  background/   background.ts, relay-manager.ts
  content/      content.ts, capture.ts, overlay.ts
  shared/       types.ts, nostr/{auth,events,encryption}.ts
  popup/        popup.ts, popup.html
public/icons/
dist/           (build output, gitignored)
manifest.json   Chrome MV3 manifest
vite.config.ts
tsconfig.json
```
